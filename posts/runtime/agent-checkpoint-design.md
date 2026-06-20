# Agent Checkpoint 机制：设计与实现

Agent 任务越来越长——30 步代码编写、60 步数据分析、跨天的研究流程。一个工具调用失败、网络超时、模型幻觉，就可能让整个任务前功尽弃。Checkpoint 机制让 Agent 能从中断点恢复、能回滚到上一步、能精确重放任意历史状态，是生产级 Agent 系统的基础设施。

这个问题并不新鲜。数据库工程师在 1992 年（ARIES）、流计算工程师在 2015 年（Flink）、操作系统工程师在更早就解决过同一批问题：如何在不暂停系统的情况下取得一致快照？如何从中断点精确恢复？如何在副作用已经发生后"撤销"一个操作？这些答案对 Agent 系统完全适用。

本文覆盖：OS/Flink/Spark 的设计传承、核心数据模型、状态快照、断点续跑、重放恢复、事务回滚，以及字节、OpenAI、Anthropic、Google、阿里的实现对照，附完整参考文献。

---

## 1. 为什么 Agent 需要 Checkpoint

单次 LLM 调用是无状态的。但 Agent 是有状态的——它维护对话历史、工具调用结果、中间变量、对外部世界产生的副作用（写了文件、发了邮件、创建了数据库记录）。

没有 Checkpoint，长任务面临五类风险：

| 风险 | 场景 | 代价 |
|------|------|------|
| **不可恢复失败** | 第 45 步网络超时 | 从头重跑，前 44 步全废 |
| **副作用重复** | 重跑时工具重复执行 | 重复发邮件、重复扣款 |
| **无法调试** | Agent 走错路，无法回溯 | 只能靠日志猜，无法重现 |
| **Replan 代价高** | 执行到一半发现计划需要修订 | 无锚点，只能从头重规划+重执行 |
| **动态节点丢失** | 运行时插入了新节点/子任务 | 图拓扑变化未持久化，重启后图结构丢失 |

Checkpoint 的价值是五个：

- **断点续跑**：从上次中断的精确位置继续，不重跑已完成的步骤
- **事务回滚**：发现走错路时，回退到任意历史检查点
- **精确重放**：以相同输入重跑任意历史片段，用于调试和评测
- **Replan 锚点**：修订计划时，以某个历史 Checkpoint 为起点重新执行新计划，保留已完成步骤的结果
- **动态图持久化**：运行时插入的节点、新增的分支快照进 Checkpoint，重启后图结构可完整还原

### 1.1 Replan 场景为什么需要 Checkpoint

Plan-and-Execute 是最常见的 Agent 编排范式：外层 Planner 制定步骤列表，内层 Executor 逐步执行。问题在于，执行中途的反馈会让计划失效。

```
初始计划:  [搜索资料] → [整理数据] → [生成报告] → [发送邮件]
                                  ↑
                       Step 3 发现数据格式不对，需要重新爬取
                       Planner 修订计划：
                       [重新爬取] → [整理数据] → [生成报告] → [发送邮件]
```

没有 Checkpoint，Replan 意味着从头重跑，前两步的 API 调用和网络请求全部浪费。

**有 Checkpoint 的 Replan 流程**：

1. 执行到 Step 3，Executor 返回异常反馈给 Planner
2. Planner 以 Step 2 完成时的 Checkpoint 为锚点，生成新的剩余计划
3. Executor 从 Step 2 的 Checkpoint 加载状态，执行新计划——Step 1、Step 2 的结果直接复用

```python
def replan_and_resume(self, run_id: str, failed_at_step: int, new_plan: list[str]):
    # 找到失败步骤的前一个稳定 Checkpoint
    anchor = self.store.find_last_stable(run_id, before_step=failed_at_step)
    
    # 从锚点恢复状态
    self.resume(run_id, from_snapshot=anchor.snapshot_id)
    
    # 注入新计划（替换 variables 里的 plan 字段）
    self.variables["plan"] = new_plan
    self.variables["plan_revised"] = True
    self._checkpoint("replan")
    
    return self.run_loop()
```

Replan + Checkpoint 要求 Checkpoint 存储的不只是"已做了什么"（历史），还要存储"接下来要做什么"（计划变量）。这意味着 `variables` 字段必须包含 Planner 的当前计划状态。

### 1.2 动态插入节点为什么需要 Checkpoint

静态图（在执行前定义好所有节点）容易 Checkpoint——图结构不变，只需快照每个节点的状态。

动态图更复杂：执行过程中 Planner 会**插入新节点**、**激活休眠分支**、**生成子 Agent 任务**。

```
初始图:    A → B → C → D
                ↑
         B 执行后发现需要并行 B1 / B2

动态修改后: A → B → [B1, B2] → C → D
                        ↑
               B1 执行中又插入了 B1a
```

如果这些动态变化没有快照进 Checkpoint，重启后只能恢复到**初始图结构**，丢失所有运行时插入的节点。

**需要快照的图状态**：

```python
@dataclass
class GraphCheckpoint(Checkpoint):
    # 在基础 Checkpoint 之上，追加图拓扑状态
    graph_nodes: list[dict]     # 当前所有节点（含动态插入的）
    graph_edges: list[dict]     # 当前所有边（含动态添加的）
    node_states: dict           # node_id -> 执行状态（pending/running/done/failed）
    active_branches: list[str]  # 当前激活的并行分支
    pending_subagents: dict     # subagent_id -> 启动参数（未完成的子 Agent）
```

LangGraph 通过 `Command` 返回值支持运行时修改图，并自动将修改后的图状态纳入 Checkpoint 快照——这是它相比其他框架的关键优势之一。

:::提醒 子 Agent 是动态节点的高频场景
Multi-Agent 架构中，Orchestrator 在运行时动态启动 Sub-Agent，Sub-Agent 自身也有 Checkpoint。父子 Checkpoint 需要通过 `parent_run_id` 关联，回滚父 Agent 时需要一并处理子 Agent 的状态和副作用。
:::

---

## 2. 设计传承：从 OS、Flink、Spark 到 Agent Checkpoint

Agent Checkpoint 不是新发明。数据库、操作系统、流计算分别用不同的方式解决了同一个问题。理解这些前辈设计，可以避免重新踩坑。

### 2.1 写前日志（WAL / ARIES）：先记再做

WAL（Write-Ahead Logging）是数据库恢复的基石，ARIES（1992）将其发展为最完整的形式 [2]。

核心思想：**在修改数据之前，先把"打算做什么"写进日志**。日志里的每条记录包含：LSN（日志序列号）、事务 ID、操作类型、修改前镜像（before-image）、修改后镜像（after-image）。

ARIES 的三遍恢复算法：

```
1. Analysis（分析）：从最近 Checkpoint 向前扫描日志
   → 确定哪些页是脏的（Dirty Page Table）
   → 确定哪些事务未提交（Active Transaction Table）

2. Redo（重做）：从 redo-point 向前重放所有操作——即使是未提交的
   → 把数据库页恢复到崩溃时的物理状态

3. Undo（撤销）：逆序回滚所有未提交事务
   → 用 before-image 把未提交的修改撤回
```

ARIES 最反直觉的地方：**Redo 阶段会重放尚未提交的事务，然后 Undo 阶段再把它们撤回**。原因是要先恢复物理状态，再做逻辑回滚。

**映射到 Agent：**

| ARIES 概念 | Agent 对应 |
|-----------|-----------|
| WAL（日志记录） | 事件日志（event log） |
| LSN（序列号） | step + event_seq |
| before-image | 工具调用前的 Agent 状态 |
| after-image | 工具调用后的 Agent 状态 |
| Redo pass | 断点续跑（重放已完成步骤，用缓存） |
| Undo pass | 事务回滚（逆序补偿，Saga 模式） |
| Checkpoint（WAL 截断点）| Agent Checkpoint（快照 + 日志截断） |

ARIES 给 Agent 最重要的启发：**事件日志 + 周期性快照** 是一个完整的恢复系统，两者缺一不可。只有快照没有日志，快照之间的操作丢失；只有日志没有快照，重放时间无限增长。

### 2.2 OS 进程快照（CRIU）：内存即状态

CRIU（Checkpoint/Restore In Userspace）是 Linux 的进程级 Checkpoint 工具，能把一个运行中的进程完整冻结到磁盘，然后在任意时刻恢复。

它需要序列化的内容：

```
进程状态
├── 内存映射：/proc/PID/maps + 每个 VMA 的物理页内容
├── 文件描述符：打开的文件、管道、socket（包含 socket 状态）
├── CPU 寄存器：通用寄存器、程序计数器、栈指针
├── 信号：pending signals、signal handlers
├── 线程：每个线程的 TLS、栈、寄存器
└── Namespace：PID、网络、挂载点
```

**Copy-on-Write（COW）快照**：Linux `fork()` 系统调用本质上就是一次进程快照——父子进程共享所有内存页，直到某一方写入时才复制（Copy-on-Write）。这让快照几乎是零成本的。

**脏页追踪（Dirty Page Tracking）**：内核为每个内存页维护 dirty bit。增量快照只需要 dump 自上次快照以来被写过的页，而不是全量内存。

**映射到 Agent：**

| CRIU 概念 | Agent 对应 |
|----------|-----------|
| 进程内存 | messages + variables（Agent 的"内存"）|
| 文件描述符 | 外部资源引用（文件路径、DB 连接信息）|
| 增量快照（dirty page）| 只存 delta（上次 CP 以来变化的字段）|
| COW fork | 快照时不复制全量，记录与上个 CP 的 diff |

COW 思想应用到 Agent 的增量快照：

```python
class IncrementalCheckpoint:
    def __init__(self, parent_id: str | None):
        self.parent_id = parent_id
        self.delta: dict = {}      # 只存"脏"字段

    def write(self, key: str, value):
        self.delta[key] = value    # COW：写时才复制到 delta

    def read(self, key: str, store) -> Any:
        if key in self.delta:
            return self.delta[key]
        if self.parent_id:          # 未命中，向父 CP 追溯（链表式）
            return store.load(self.parent_id).read(key, store)
        return None
```

### 2.3 Flink 分布式快照（Chandy-Lamport）：屏障对齐

分布式系统 Checkpoint 的核心难题：**如何在不暂停整个系统的情况下，取得一个全局一致的快照？**

Chandy-Lamport 算法（1985）[1] 的答案是：**向数据流里注入"标记"（Marker），用标记分割"快照之前"和"快照之后"的消息**。

```
Source A: ─── data ─── [MARKER] ─── data ──►
Source B: ─── data ─── [MARKER] ─── data ──►
                              │
                    当算子在所有输入上都收到 Marker
                    → 保存当前算子状态
                    → 向下游转发 Marker
```

Flink 的实现（Carbone et al. 2015）[4]：

- **JobManager** 定期向所有 Source 注入 Checkpoint Barrier
- **对齐检查点（Aligned）**：算子等待所有输入通道都收到 Barrier 后再快照——精确一次语义，但可能阻塞快速通道
- **非对齐检查点（Unaligned，Flink 1.11+）**：不等待对齐，把"飞行中"的记录也纳入快照——延迟更低，快照体积更大
- **State Backend**：
  - `HashMapStateBackend`（内存）：快，受限于堆内存
  - `EmbeddedRocksDBStateBackend`：堆外，大状态，支持**增量快照**（只传 RocksDB SST 文件的 diff）
- **精确一次 Sink（2PC）**：
  - Checkpoint 触发时 → 预提交（pre-commit）：数据写入但不可见
  - Checkpoint 完成时 → 提交（commit）：数据变为可见
  - 失败时 → 中止（abort）：回到上个 Checkpoint

**映射到 Agent：**

| Flink 概念 | Agent 对应 |
|-----------|-----------|
| Checkpoint Barrier | `tool_call_start` 事件（步骤边界）|
| 对齐 CP | 工具调用完成后再快照 |
| 非对齐 CP | 工具执行中途快照（记录 in-flight 调用）|
| State Backend | Checkpoint Store（内存/SQLite/PostgreSQL+S3）|
| 2PC Sink | 非幂等工具：commit = 缓存写入 + 副作用确认 |
| 增量 SST diff | 增量快照（delta 只存变化的 messages/variables）|

Flink 给 Agent 最重要的启发：**精确一次不是靠"不执行两次"，而是靠"执行了两次但第二次有缓存"**。非幂等 Sink 的 2PC 对应 Agent 非幂等工具的缓存保护。

### 2.4 Spark Checkpoint：血缘截断与增量状态

Spark 的 RDD 本质上是一个**隐式 Checkpoint**：每个 RDD 记录自己的血缘（从哪些 RDD 怎么计算来的），失败时沿血缘重算。

```
Source RDD ─► filter() ─► map() ─► groupBy() ─► ... ─► reduce()
                                                   血缘链：50 步
```

问题：血缘链太长时，重算代价超过存储代价。

`checkpoint()` = **把中间 RDD 物化到 HDFS，截断血缘**：

```scala
val longRDD = source.filter(...).map(...).groupBy(...)  // 50 步血缘
longRDD.checkpoint()  // 写 HDFS，截断血缘
longRDD.cache()       // 配合 cache 避免重算两次
```

**Spark Streaming 的双层 Checkpoint**：

```
Metadata Checkpoint：DStream 图结构、配置、batch 时间戳
    → 应对 Driver 重启（重建计算图）

Data Checkpoint：有状态操作（updateStateByKey）的 RDD 内容
    → 应对 lineage 过长问题
```

**Structured Streaming** 的 Delta 模式：

```
checkpoint/
  offsets/          # WAL：每个 batch 处理前记录 source offset
  commits/          # Commit log：每个 batch 完成后写入
  state/            # 增量状态存储（只写变化的 key）
```

**映射到 Agent：**

| Spark 概念 | Agent 对应 |
|-----------|-----------|
| RDD 血缘（lineage）| Agent 事件日志（总能从头重放）|
| `checkpoint()` 截断血缘 | 周期性 Agent 快照（避免从头重放）|
| 有状态 DStream | 跨步骤累积的 Agent variables |
| Source WAL（offsets）| 工具调用前记录意图（`tool_call_start`）|
| Delta commit log | 增量 Checkpoint（只存 diff）|

Spark 给 Agent 最重要的启发：**不是所有任务都需要 Checkpoint**。短任务直接重试（沿"血缘"重算）比维护 Checkpoint 更简单。只有当重算代价（API 费用、时间）超过存储代价时，才值得 Checkpoint。

### 2.5 概念映射全表

| 维度 | OS (CRIU/WAL) | Flink | Spark | Agent |
|------|--------------|-------|-------|-------|
| **状态单元** | 进程（内存+fd）| 算子状态 | RDD 分区 | messages + variables |
| **快照触发** | 信号 / 定时 | Checkpoint Barrier | `checkpoint()` API | 步骤边界（工具调用前后）|
| **快照类型** | 全量 / 增量（dirty page）| 对齐 / 非对齐 | 全量 / delta | 全量 / 增量 delta |
| **恢复单元** | 进程 | Task（并行度粒度）| RDD 分区 | 步骤 |
| **精确一次** | WAL + Force/Steal | 2PC + Barrier | 幂等写 + Source WAL | 工具缓存 + Saga 补偿 |
| **回滚机制** | 加载进程快照 | 从 CP 重启 Task | 血缘重算 / 加载 CP | 状态回滚 + 补偿事务 |
| **存储后端** | 磁盘文件 | Memory / RocksDB / HDFS | HDFS / S3 | SQL + blob/S3 |
| **日志角色** | WAL（ARIES 三遍恢复）| Changelog（RocksDB）| DeltaLog | 事件日志 |
| **Redo** | Redo pass（前向重放）| Barrier 后重放 | 血缘重算 | 断点续跑（缓存命中）|
| **Undo** | Undo pass（逆序补偿）| 从 CP 重建 | 加载快照替代重算 | Saga 逆序补偿 |

---

## 3. 核心数据模型

Checkpoint 本质是两样东西的组合：**状态快照（State Snapshot）** + **事件日志（Event Log）**。对应 ARIES 的"周期性全页写入"和"WAL 日志"。

```
Checkpoint
├── snapshot_id      # 唯一标识（对应 ARIES 的 Checkpoint LSN）
├── run_id           # 所属的执行 run
├── step             # 第几步（从 0 开始）
├── parent_id        # 父 Checkpoint（增量模式下形成链）
├── timestamp
├── state            # 状态快照
│   ├── messages     # 完整对话历史
│   ├── variables    # Agent 内部变量（scratchpad、计划等）
│   └── resources    # 外部资源引用（文件路径、DB row id 等）
└── event            # 触发本次快照的事件（对应 WAL 日志记录）
    ├── type         # tool_call_start | tool_call_end | llm_response | user_input
    ├── tool_name    # 工具名（如果是工具事件）
    ├── input        # 工具输入（before-image 语义）
    ├── output       # 工具输出（after-image，call_end 时才有）
    └── is_idempotent # 该工具调用是否幂等
```

这两样东西的职责不同：

- **状态快照**：完整记录"此刻 Agent 的全部内部状态"，足以从这一刻重新跑（对应 ARIES 的全页写入）
- **事件日志**：记录"发生了什么"，用于快照间的增量恢复（对应 WAL）

:::方法 快照时机选择
**每步快照（对齐 Checkpoint）**：最细粒度，恢复精确，对应 Flink 对齐 CP。适合关键任务（金融、医疗）。
**工具调用前后快照**：兼顾精度与成本，工具调用是副作用边界，也是最常见的失败点。
**LLM 响应后快照（非对齐）**：最省存储，工具执行中途失败时用事件日志补全，对应 Flink 非对齐 CP。
:::

---

## 4. 状态快照：序列化什么

Agent 状态通常分四类，序列化策略各不相同：

### 4.1 对话历史（Messages）

最重要也最直接。LangChain/LangGraph 用 `BaseMessage` 列表，OpenAI 用 `messages` 数组。序列化为 JSON 即可。

```python
@dataclass
class Checkpoint:
    messages: list[dict]        # role + content，完整历史
    tool_calls_cache: dict      # cache_key -> result，已完成的工具调用
    variables: dict             # Agent 自定义的 scratchpad 变量
    step: int
    snapshot_id: str
    parent_id: str | None
    timestamp: float
```

### 4.2 工具调用缓存（Tool Call Cache）

这是断点续跑的关键，对应 Flink 的 State Backend。缓存记录哪些工具调用已经执行过、输出是什么。恢复时，遇到已缓存的调用直接返回缓存结果，不重新执行。

```python
tool_calls_cache = {
    "0:bash:a3f9b2c1": {
        "tool": "bash",
        "input": {"cmd": "git clone https://..."},
        "output": "Cloned into 'repo'...",
        "timestamp": 1718200000.0,
        "is_idempotent": False     # 非幂等操作，重放时必须用缓存
    }
}
```

### 4.3 外部资源引用

Agent 在外部世界留下的脚印——文件、数据库记录、API 创建的资源。这些不能"序列化"，只能记录引用和操作日志，供回滚时做补偿（对应 ARIES 的 before-image）。

```python
resources = {
    "files_created": ["./output/report.md", "/tmp/data.csv"],
    "db_records": [{"table": "tasks", "id": 42, "op": "INSERT"}],
    "api_calls": [{"service": "email", "id": "msg_xyz", "reversible": False}]
}
```

### 4.4 序列化格式选型

| 格式 | 优点 | 缺点 | 适用场景 |
|------|------|------|----------|
| JSON | 可读、调试友好 | 不支持二进制、体积大 | 开发阶段、审计需求 |
| MessagePack | 比 JSON 小 2-5x | 不可读 | 高频快照 |
| Protobuf | 强类型、最小体积 | 需要 schema 维护 | 大规模生产 |
| SQLite | 事务支持、可查询 | 单文件竞争 | 本地开发、单机 Agent |

生产推荐：**元数据用 PostgreSQL/SQLite 存，大 payload（messages）用 blob 或 S3**。对应 Flink 的 `EmbeddedRocksDBStateBackend + HDFS` 组合（本地快速访问 + 远程持久化）。

---

## 5. 断点续跑（Resume）

断点续跑的核心逻辑是：**找到最后一个有效 Checkpoint，恢复状态，跳过已完成的步骤**。对应 ARIES 的 Redo pass——重放 WAL 到崩溃点，但用缓存替代真实执行。

```
┌─────────────────────────────────────────────────────────┐
│                     Agent Run                           │
│  Step 0 ──► Step 1 ──► Step 2 ──✗ (crash)              │
│                                                         │
│  Checkpoint:  CP0      CP1      CP2(partial)            │
└─────────────────────────────────────────────────────────┘
                                    ↑ 从 CP1 恢复，重跑 Step 2
```

### 5.1 恢复流程

```python
class AgentRunner:
    def resume(self, run_id: str, from_checkpoint: str | None = None):
        cp = self.store.load(run_id, from_checkpoint or "latest")
        
        # 恢复 Agent 状态（对应 ARIES Analysis + Redo 的结果）
        self.messages = cp.messages.copy()
        self.variables = cp.variables.copy()
        self.tool_calls_cache = cp.tool_calls_cache.copy()
        self.step = cp.step
        
        return self.run_loop()   # 继续执行，工具层自动查 cache
    
    def execute_tool(self, tool_name: str, tool_input: dict, call_id: str):
        cache_key = self._cache_key(self.step, tool_name, tool_input)
        
        # 断点续跑的关键：先查缓存（Redo 语义：已做过的不重做）
        if cache_key in self.tool_calls_cache:
            return self.tool_calls_cache[cache_key]["output"]
        
        # 执行前快照（WAL：先记再做）
        self._save_checkpoint(event_type="tool_call_start", tool=tool_name, input=tool_input)
        
        result = self.tools[tool_name].execute(tool_input)
        
        self.tool_calls_cache[cache_key] = {
            "tool": tool_name, "input": tool_input, "output": result
        }
        self._save_checkpoint(event_type="tool_call_end", tool=tool_name, output=result)
        
        return result
```

### 5.2 幂等 vs 非幂等工具

并非所有工具都能安全重跑，这与 Flink 的精确一次 Sink 设计完全对应：

| 工具类型 | 幂等性 | 续跑策略 |
|----------|--------|----------|
| 读文件、查数据库 | 是 | 可重新执行，也可用缓存 |
| 写文件（覆盖） | 是（最终状态一致） | 通常重新执行 |
| 发邮件、发 Slack | **否** | **必须用缓存，禁止重发** |
| 数据库 INSERT | 否（除非有唯一约束） | 用缓存 or 先查再插 |
| API 扣款 | **否** | **必须用缓存** |
| bash 命令 | 取决于命令 | 标记 + 缓存 |

:::提醒 非幂等工具必须在工具定义时声明
在工具 schema 里加 `"idempotent": false` 字段，执行器层统一处理。对应 Flink 要求 Sink 实现 `TwoPhaseCommitSinkFunction` 接口——声明式、集中化，不要在每个调用点分散判断。
:::

---

## 6. 重放恢复（Replay）

重放与续跑的区别：**续跑是从中断点继续往前跑；重放是以相同输入重新跑一段历史**。对应 ARIES 的 Redo pass 不带 Undo——单纯重演历史。

### 6.1 确定性重放

工具调用使用缓存输出，LLM 调用也使用缓存响应——完全重现历史，不引入任何新的不确定性。

```python
class ReplayAgent(AgentRunner):
    def replay(self, run_id: str, from_step: int = 0, to_step: int | None = None):
        checkpoints = self.store.load_range(run_id, from_step, to_step)
        for cp in checkpoints:
            self._apply_event(cp.event, use_cache=True)  # 全部用缓存
```

### 6.2 非确定性重放（实验模式）

只缓存非幂等工具的结果，LLM 调用使用新模型/新 prompt——用来对比"换了新模型，Agent 会走不同的路吗？"这对应字节 AgentTuning [11] 中的离线评测范式。

```python
def replay_with_new_model(self, run_id: str, new_model: str):
    self.tool_cache_policy = "non_idempotent_only"  # 只缓存非幂等工具
    self.llm_model = new_model                       # LLM 用新模型重推理
    return self.replay(run_id)
```

### 6.3 重放的核心挑战：Tool Call ID 稳定性

重放时，LLM 可能生成不同的 `tool_call_id`，导致缓存命中失败。解决方案与 Flink Barrier 序号的稳定性思路相同：**用内容寻址，不依赖运行时生成的 ID**。

```python
def _cache_key(self, step: int, tool_name: str, tool_input: dict) -> str:
    input_hash = hashlib.sha256(
        json.dumps(tool_input, sort_keys=True).encode()
    ).hexdigest()[:16]
    return f"{step}:{tool_name}:{input_hash}"   # 内容寻址：step + 工具 + 输入的 hash
```

---

## 7. 事务回滚（Rollback）

回滚分两类：**状态回滚**（恢复 Agent 内部状态到历史检查点）和**副作用补偿**（撤销对外部世界的操作）。对应 ARIES 的 Undo pass。

### 7.1 状态回滚

直接加载历史 Checkpoint，等价于 ARIES 用 before-image 恢复数据页：

```python
def rollback(self, run_id: str, to_checkpoint: str):
    cp = self.store.load(run_id, to_checkpoint)
    
    self.messages = cp.messages.copy()
    self.variables = cp.variables.copy()
    self.tool_calls_cache = cp.tool_calls_cache.copy()
    self.step = cp.step
    
    self.store.mark_rolled_back(run_id, after_step=cp.step)
    self._compensate(run_id, after_step=cp.step)
```

### 7.2 副作用补偿（Saga 模式）

状态可以回滚，但副作用——发出的邮件、已扣的钱——无法"取消"，只能"补偿"。这是 Garcia-Molina & Salem 1987 Saga 论文 [3] 的核心思想，将长事务分解为一系列子事务，每个子事务对应一个补偿事务。

```
Forward transaction:          Compensating transaction:
  Step 1: Create order   ←─→   Cancel order
  Step 2: Deduct stock   ←─→   Restore stock
  Step 3: Charge payment ←─→   Refund payment  ← 无法真正"撤销"，只能补偿
  Step 4: Send email     ←─→   Send recall email（如果支持）
```

每个工具注册时，同时注册其补偿动作（对应 Saga 的 C_i）：

```python
@tool(
    name="send_email",
    idempotent=False,
    compensate=lambda ctx: send_email(
        to=ctx["to"],
        subject=f"[Correction] {ctx['subject']}",
        body="Please disregard the previous email."
    )
)
def send_email(to: str, subject: str, body: str) -> str:
    ...
```

补偿时，**逆序执行**从回滚点到当前步骤的所有补偿动作（对应 Saga 的 C_n, C_{n-1}, ..., C_1）：

```python
def _compensate(self, run_id: str, after_step: int):
    events = self.store.load_events(run_id, from_step=after_step + 1)
    
    for event in reversed(events):     # 逆序补偿（Saga Undo 顺序）
        if event.type == "tool_call_end" and not event.is_idempotent:
            tool = self.tools[event.tool_name]
            if tool.compensate:
                try:
                    tool.compensate(event.input)
                    self.store.log_compensation(run_id, event.step, "success")
                except Exception as e:
                    self.store.log_compensation(run_id, event.step, "failed", str(e))
```

:::提醒 不可补偿操作的处理
有些副作用真的无法补偿（支付已经到账、法律文件已经签署）。这类操作必须在 Agent 工作流中加人工确认门控（HITL），不能事后靠补偿解决。Anthropic 的 Model Spec [8] 明确要求：Agent 应在执行不可逆操作前暂停并请求确认。
:::

### 7.3 回滚到"上一步"

最常见的交互场景：用户说"不对，回到上一步重试"。

```
CP0 → CP1 → CP2 → CP3(当前)
                      ↑
                   rollback_to(CP2)
                      → 补偿 CP3 的副作用
                      → 状态恢复到 CP2
                      → 用户修改指令后继续
```

```python
def rollback_one_step(self, run_id: str):
    checkpoints = self.store.list(run_id, order="desc", limit=2)
    if len(checkpoints) < 2:
        raise ValueError("Already at the beginning")
    
    current, previous = checkpoints[0], checkpoints[1]
    self.rollback(run_id, to_checkpoint=previous.snapshot_id)
    return previous
```

---

## 8. Checkpoint 存储设计

### 8.1 存储层结构

对应 Flink 的 State Backend 分层：元数据轻量高频查询，payload 大体积持久化。

```sql
-- 元数据表（对应 Flink Job Manager 维护的 CP 元数据）
CREATE TABLE checkpoints (
    snapshot_id   TEXT PRIMARY KEY,
    run_id        TEXT NOT NULL,
    step          INTEGER NOT NULL,
    parent_id     TEXT,                             -- 增量 CP 的父节点
    timestamp     REAL NOT NULL,
    event_type    TEXT,
    tool_name     TEXT,
    status        TEXT DEFAULT 'active',            -- active | rolled_back
    payload_key   TEXT,                             -- 指向 blob 存储的 key
    checksum      TEXT                              -- SHA256，防截断快照
);
CREATE INDEX idx_run_step ON checkpoints (run_id, step);

-- payload 存 blob 列或外部存储（S3/GCS），包含 messages、variables、tool_calls_cache
```

### 8.2 存储接口

```python
class CheckpointStore(Protocol):
    def save(self, checkpoint: Checkpoint) -> None: ...
    def load(self, run_id: str, snapshot_id: str | Literal["latest"]) -> Checkpoint: ...
    def load_range(self, run_id: str, from_step: int, to_step: int | None) -> list[Checkpoint]: ...
    def list(self, run_id: str, order: str, limit: int) -> list[CheckpointMeta]: ...
    def mark_rolled_back(self, run_id: str, after_step: int) -> None: ...
    def log_compensation(self, run_id: str, step: int, status: str, error: str | None = None) -> None: ...
```

### 8.3 存储后端选型

| 场景 | 推荐存储 | 对应 Flink/Spark 类比 |
|------|----------|-----------------------|
| 本地开发/单机 | SQLite | MemoryStateBackend |
| 生产单机 | PostgreSQL | FsStateBackend（本地 HDFS）|
| 生产分布式 | PostgreSQL + S3 | RocksDBStateBackend + HDFS |
| 需要回溯查询 | DynamoDB + S3 | 水平扩展，按 run_id 查 |
| 极低延迟 | Redis（ACID 要求低）| MemoryStateBackend（注意持久化配置）|

---

## 9. 完整实现骨架

把所有模块拼在一起，一个可工作的 Checkpoint-aware Agent（对应 Flink 的 `CheckpointedFunction` 接口）：

```python
import json, hashlib, time, uuid
from dataclasses import dataclass
from typing import Protocol, Any

@dataclass
class Checkpoint:
    snapshot_id: str
    run_id: str
    step: int
    timestamp: float
    messages: list[dict]
    variables: dict
    tool_calls_cache: dict       # cache_key -> {output, is_idempotent}
    resources: dict
    event_type: str
    parent_id: str | None = None
    tool_name: str | None = None
    status: str = "active"

class CheckpointAgent:
    def __init__(self, tools: dict, store, model_fn):
        self.tools = tools          # name -> Tool
        self.store = store          # CheckpointStore
        self.model_fn = model_fn    # (messages) -> response
        self.messages: list[dict] = []
        self.variables: dict = {}
        self.tool_calls_cache: dict = {}
        self.resources: dict = {"files_created": [], "db_records": [], "api_calls": []}
        self.run_id: str = ""
        self.step: int = 0
        self._last_cp_id: str | None = None

    def start(self, system_prompt: str, user_message: str) -> str:
        self.run_id = str(uuid.uuid4())
        self.messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message}
        ]
        self._checkpoint("run_start")
        return self.run_loop()

    def resume(self, run_id: str, from_snapshot: str = "latest") -> str:
        cp = self.store.load(run_id, from_snapshot)
        self.run_id = run_id
        self.messages = cp.messages.copy()
        self.variables = cp.variables.copy()
        self.tool_calls_cache = cp.tool_calls_cache.copy()
        self.resources = cp.resources.copy()
        self.step = cp.step
        self._last_cp_id = cp.snapshot_id
        return self.run_loop()

    def rollback_one_step(self) -> Checkpoint:
        cps = self.store.list(self.run_id, order="desc", limit=2)
        if len(cps) < 2:
            raise ValueError("Already at the beginning")
        target = cps[1]
        self._compensate(after_step=target.step)
        cp = self.store.load(self.run_id, target.snapshot_id)
        self.messages = cp.messages.copy()
        self.variables = cp.variables.copy()
        self.tool_calls_cache = cp.tool_calls_cache.copy()
        self.step = cp.step
        self._last_cp_id = cp.snapshot_id
        self.store.mark_rolled_back(self.run_id, after_step=target.step)
        return cp

    def run_loop(self) -> str:
        while True:
            response = self.model_fn(self.messages)
            self.messages.append({"role": "assistant", "content": response.content})
            self._checkpoint("llm_response")

            if not response.tool_calls:
                return response.content

            for call in response.tool_calls:
                result = self._execute_tool(call.name, call.input, call.id)
                self.messages.append({
                    "role": "tool", "tool_call_id": call.id, "content": str(result)
                })
            self.step += 1

    def _execute_tool(self, name: str, input_: dict, call_id: str) -> Any:
        cache_key = self._cache_key(self.step, name, input_)
        if cache_key in self.tool_calls_cache:
            return self.tool_calls_cache[cache_key]["output"]

        self._checkpoint("tool_call_start", tool_name=name)   # WAL：先记再做
        result = self.tools[name].execute(input_)

        self.tool_calls_cache[cache_key] = {
            "output": result, "is_idempotent": self.tools[name].idempotent,
            "tool_name": name, "input": input_
        }
        self._checkpoint("tool_call_end", tool_name=name)
        return result

    def _compensate(self, after_step: int):
        cps = self.store.load_range(self.run_id, after_step + 1, None)
        for cp in reversed(cps):
            if cp.event_type == "tool_call_end" and cp.tool_name:
                tool = self.tools.get(cp.tool_name)
                if tool and tool.compensate and not tool.idempotent:
                    for k, v in self.tool_calls_cache.items():
                        if k.startswith(f"{cp.step}:{cp.tool_name}:"):
                            try:
                                tool.compensate(v["input"])
                            except Exception as e:
                                print(f"[WARN] Compensation failed: {cp.tool_name}: {e}")

    def _checkpoint(self, event_type: str, tool_name: str | None = None):
        cp = Checkpoint(
            snapshot_id=str(uuid.uuid4()),
            run_id=self.run_id, step=self.step, timestamp=time.time(),
            messages=self.messages.copy(), variables=self.variables.copy(),
            tool_calls_cache=self.tool_calls_cache.copy(), resources=self.resources.copy(),
            event_type=event_type, tool_name=tool_name, parent_id=self._last_cp_id
        )
        self.store.save(cp)
        self._last_cp_id = cp.snapshot_id

    @staticmethod
    def _cache_key(step: int, tool_name: str, input_: dict) -> str:
        h = hashlib.sha256(json.dumps(input_, sort_keys=True).encode()).hexdigest()[:16]
        return f"{step}:{tool_name}:{h}"
```

---

## 10. 主流公司的 Checkpoint 实现与最佳实践

### LangGraph（LangChain）

LangGraph 的 Persistence 层是目前 Agent 框架里最接近 Flink 语义的实现：

```python
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import StateGraph

memory = SqliteSaver.from_conn_string("checkpoints.db")
app = graph.compile(checkpointer=memory)

config = {"configurable": {"thread_id": "run-001"}}
app.invoke({"messages": [HumanMessage("分析这份报告")]}, config)

# 恢复（自动从最后状态继续，对应 Flink 的 restoreCheckpoint）
app.invoke(None, config)

# 回滚（对应 Flink 的 update_state 到历史版本）
states = list(app.get_state_history(config))
app.update_state(config, states[-3].values)
```

设计特点：每个图节点执行后自动快照，状态是 TypedDict，快照粒度是节点（对应 Flink 的算子级快照）。

### OpenAI：服务端不透明 Checkpoint

OpenAI 的 Threads API 是一种"服务端托管、客户端无感知"的 Checkpoint：

```python
thread = client.beta.threads.create()
run = client.beta.threads.runs.create(thread_id=thread.id, assistant_id=assistant.id)

# "续跑"就是在同一 thread 上继续追加消息
client.beta.threads.messages.create(thread_id=thread.id, role="user", content="继续")
```

**设计哲学**：客户端不需要理解 Checkpoint，状态管理完全由服务端负责。代价是无法细粒度回滚，无法访问中间状态。这与 OpenAI 在《Practices for Governing Agentic AI Systems》[7] 中的立场一致：通过**服务端控制**而非客户端透明性来保障安全。

### Anthropic：git 作为 Checkpoint 系统

Claude Code 的 Checkpoint 是最自然的形式：**文件系统即状态，git 即 Checkpoint**。每次工具调用前保存 git stash，工具调用后可选提交或回退。

```bash
# 执行工具前（工具调用前快照 = git stash）
git stash  # 保存工作区状态

# 工具调用后（快照 = git commit 或 git stash pop）
git add -A && git commit -m "step: ran tests"

# 回滚（= git checkout 到历史 commit）
git checkout HEAD~1 -- .
```

Anthropic Model Spec [8] 将"可撤销性"（reversibility）列为 Agent 行为的核心原则：**Agent 应优先选择可撤销的行动，并在执行不可逆操作前停下来确认**。git-based checkpoint 是这个原则的最直接实现。

对于非文件系统副作用（API 调用、数据库操作），Claude Code 依赖人工确认（HITL）而非自动补偿。

### 字节跳动：调度器级 Checkpoint

字节的 Coze 平台在工作流节点级别做 Checkpoint：每个节点完成后持久化节点输出，失败时从最后成功节点恢复，而不是从头重跑。

在更底层，字节的 Volcano 调度器为 GPU 训练任务实现了抢占式 Checkpoint：任务被抢占前强制保存 checkpoint，新 Pod 启动后自动加载——**同一套机制服务 LLM 训练和 Agent 运行时**，这是字节内部的基础设施复用 [11]。

在 AgentTuning 的评测实践中，为了保证大规模评测的可复现性，需要对每个评测 episode 做确定性重放——与 § 6.1 的确定性重放完全对应。

### 阿里巴巴：流水线级 Checkpoint

Qwen-Agent [12] 采用工具调用重试 + 缓存结果的模式，工具层自动缓存已执行的调用结果：

```python
# Qwen-Agent 的 tool_call 抽象（简化）
@retry(max_attempts=3, cache_result=True)
def call_tool(tool_name: str, args: dict):
    ...
```

阿里 PAI（Platform for AI）Pipeline 将每个 Pipeline 步骤定义为幂等容器，失败时从最后成功步骤恢复。这与 § 4.2 的幂等工具设计完全对应，阿里将这一思路从 ML Pipeline 延伸到了 Agent 工作流。

### Google：制品（Artifact）级 Checkpoint

Google Vertex AI Pipelines 的设计与其他框架有一个重要区别：**Checkpoint 的单元不是 Agent 状态，而是每一步的输出制品（Artifact）**。

```python
# Vertex AI Pipeline 步骤（简化）
@dsl.component
def analysis_step(input_data: Input[Dataset]) -> Output[Metrics]:
    # 输出自动存储到 GCS，成为可复用的 Artifact
    ...

# 如果 step 3 失败，step 1/2 的 Artifact 已存 GCS，直接跳过
pipeline.run(resume_from_failed=True)
```

Artifact-based checkpoint 的优势：**步骤之间完全解耦，每个步骤天然幂等（相同输入 → 相同制品）**。Google DeepMind 在 SIMA [13] 的安全评测中也用类似思路：保存环境状态快照（environment snapshot），用于重放特定场景做安全测试。

---

## 11. 生产注意事项

**存储清理**：长时任务会产生大量 Checkpoint。策略：保留最近 N 个 + 每小时保留一个 + 任务完成后压缩为最终状态。对应 Flink 的 `state.checkpoints.num-retained`。

**并发安全**：多 Agent 共享 CheckpointStore 时需要乐观锁。用 `(run_id, step, version)` 做 CAS，防止并行写覆盖。

**Checkpoint 验证**：加载时验证快照完整性（SHA256 checksum），防止截断的快照导致神秘错误。对应 Flink 的 Checkpoint 完整性校验。

**跨版本兼容**：Agent 代码升级后，旧 Checkpoint 格式可能不兼容。在 Checkpoint 里存 `schema_version`，加载时做迁移。对应 Flink 的 `SavepointFormatType` 版本管理。

**WAL 截断**：事件日志会无限增长。周期性快照后，可以截断快照之前的事件日志（对应 ARIES 的 fuzzy checkpoint + log truncation），只保留最近 N 个快照之后的事件。

:::观点 Checkpoint 是 Agent 可信赖的基础
Agent 越来越自主，执行的任务越来越长，影响的系统越来越多。没有 Checkpoint，Agent 对用户和开发者来说是一个黑盒：不知道它做了什么，不能干预，不能回退。Checkpoint 不只是工程基础设施，它是建立 Agent 信任的前提——让人类始终能"接管"和"撤销"。这正是 Anthropic Model Spec [8] 和 OpenAI 治理文件 [7] 都反复强调的：可控性（controllability）的工程实现，就是 Checkpoint。
:::

---

## 小结

| 功能 | 关键设计点 | 前辈设计类比 |
|------|-----------|-------------|
| **断点续跑** | Tool Call Cache（step:name:input_hash）+ 恢复状态 | ARIES Redo pass |
| **重放恢复** | 确定性重放全用缓存；实验性重放仅缓存非幂等工具 | Flink Aligned Checkpoint |
| **事务回滚** | 加载历史 CP + 逆序补偿（Saga 模式）| ARIES Undo pass + Saga 1987 |
| **快照增量化** | dirty-field delta + parent_id 链 | CRIU dirty page / RocksDB SST diff |
| **非幂等保护** | 工具声明 `idempotent` + 执行层统一处理 | Flink 2PC Sink |
| **存储分层** | 元数据 SQL + payload blob/S3 | RocksDB + HDFS |

Checkpoint 的核心洞见，从 1985 年的 Chandy-Lamport 到今天的 Agent 框架，始终没有变过：**你不需要暂停一切才能取快照——只需要在数据流里插入一个"屏障"，记录屏障前后的分界线，就得到了一致性快照**。Agent 的每次工具调用边界，就是那道屏障。

---

## 参考文献

### 经典系统论文

1. K. Mani Chandy, Leslie Lamport. **"Distributed Snapshots: Determining Global States of Distributed Systems."** *ACM Transactions on Computer Systems*, 3(1):63–75, 1985.

2. C. Mohan, Don Haderle, Bruce Lindsay, Hamid Pirahesh, Peter Schwarz. **"ARIES: A Transaction Recovery Method Supporting Fine-Granularity Locking and Partial Rollbacks Using Write-Ahead Logging."** *ACM Transactions on Database Systems*, 17(1):94–162, 1992.

3. Hector Garcia-Molina, Kenneth Salem. **"Sagas."** *ACM SIGMOD Record*, 16(3):249–259, 1987. — Saga 模式的原始论文，分布式长事务补偿机制的理论基础。

4. Paris Carbone, Gyula Fóra, Stephan Ewen, Seif Haridi, Kostas Tzoumas. **"Lightweight Asynchronous Snapshots for Distributed Dataflows."** *arXiv:1506.08603*, 2015. — Flink Checkpoint 机制的设计论文，Chandy-Lamport 在流计算中的工程化实现。

5. Matei Zaharia, Tathagata Das, Haoyuan Li, Timothy Hunter, Scott Shenker, Ion Stoica. **"Discretized Streams: Fault-Tolerant Streaming Computation at Scale."** *SOSP 2013*. — Spark Streaming 的系统论文，介绍 metadata checkpoint + data checkpoint 的双层设计。

6. Jim Gray, Andreas Reuter. **"Transaction Processing: Concepts and Techniques."** Morgan Kaufmann, 1992. — 数据库事务与恢复理论的权威教材，Checkpoint 与 WAL 的完整理论基础。

### Agent 系统与治理

7. OpenAI. **"Practices for Governing Agentic AI Systems."** December 2023. — OpenAI 对 Agentic AI 的治理框架，明确将"暂停、中断、回滚能力"列为安全属性。

8. Anthropic. **"Claude's Model Specification."** 2024. — Anthropic 对 Claude 行为准则的完整描述，"可逆性优先"和"不可逆操作前确认"作为 Agent 行为核心原则。

9. Shunyu Yao, Jeffrey Zhao, Dian Yu, Nan Du, Izhak Shafran, Karthik Narasimhan, Yuan Cao. **"ReAct: Synergizing Reasoning and Acting in Language Models."** *ICLR 2023*. arXiv:2210.03629. — ReAct 范式论文，Agent 动作序列（Trajectory）是 Checkpoint 的基本单元。

10. Xiao Liu et al. **"AgentBench: Evaluating LLMs as Agents."** arXiv:2308.03688, 2023. — LLM 作为 Agent 的系统评测框架，评测的可复现性依赖确定性重放。

11. Aohan Zeng, Mingdao Liu, Rui Lu, Bowen Wang, Xiao Liu, Yuxiao Dong, Jie Tang. **"AgentTuning: Enabling Generalized Agent Abilities for LLMs."** arXiv:2310.12823, 2023. — 字节跳动 + 清华联合工作，Agent 训练与评测中的可复现性实践。

12. Qwen Team, Alibaba DAMO Academy. **"Qwen-Agent: Tool-Augmented LLMs via ReAct."** GitHub: QwenLM/Qwen-Agent, 2024. — 阿里 Qwen-Agent 框架，工具调用缓存与重试机制的开源实现参考。

13. SIMA Team, Google DeepMind. **"Scaling Instructable Agents Across Many Simulated Worlds."** arXiv:2404.10179, 2024. — 用环境状态快照做多世界 Agent 的安全评测，Artifact-based Checkpoint 的研究实践。

### 工程文档

14. Apache Flink Documentation. **"Stateful Stream Processing — Checkpointing."** flink.apache.org, 2024. — Flink Checkpoint 机制的完整工程文档，包含 Aligned/Unaligned CP、State Backend 配置、2PC Sink 实现。

15. Apache Spark Documentation. **"Structured Streaming Programming Guide."** spark.apache.org, 2024. — Spark Structured Streaming 的 Checkpoint 与 WAL 配置指南。

16. LangGraph Documentation. **"Persistence & Memory."** langchain-ai.github.io/langgraph, 2024. — LangGraph 的 Checkpoint 接口（`BaseCheckpointSaver`）及 SQLite/PostgreSQL 后端实现文档。
