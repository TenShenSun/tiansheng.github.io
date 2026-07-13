# Agent 执行基础设施：长短 Agent、容器调度与启动优化

:::观点 基础设施决定上限
写编排逻辑很性感，但真正决定 Agent 系统能不能跑稳的，是底层的执行基础设施：任务怎么分类、怎么打包、怎么调度、怎么启动、怎么隔离。这层没设计好，上层再精妙也是空中楼阁。
:::

本文从**长短 Agent 分类**出发，逐层拆解容器/Pod 打包、线程与调度模型、三种启动方式的延迟与成本权衡，以及权限隔离的工程实践。每节补充当前主流开源生态的选型依据，附完整参考文献。

---

## 一、长 Agent vs 短 Agent：两类根本不同的运行时需求

Agent 任务并非一刀切。**任务时长**是最重要的分类维度——它决定了资源分配、状态管理、调度策略的所有下游设计决策。

### 分类标准

| 维度 | 短 Agent | 长 Agent |
|---|---|---|
| **执行时长** | 秒级到分钟级（< 5 min） | 分钟级到小时级（> 5 min，甚至天级） |
| **典型任务** | 单次问答、工具查询、代码补全 | 代码库重构、自动化研究、多步骤流程自动化 |
| **状态模型** | 无状态或单次请求内有状态 | 有状态、跨步骤持久化 |
| **资源持有** | 用完即释放，共享池化 | 长期占用或定期申请 |
| **失败恢复** | 直接重试即可 | 必须 Checkpoint + 断点续跑 |
| **计费模型** | 按次/按 Token | 按时长/按步骤 |
| **典型实现** | AWS Lambda、Serverless Function | K8s Job、Temporal Workflow |

### 长短 Agent 的根本分歧：状态持久化

短 Agent 可以是**纯函数**——给定输入，产生输出，没有副作用。这让它们极易水平扩展：任何节点都能处理任何请求，失败直接重试。

长 Agent 本质上是**状态机**——每个步骤都依赖前几步的执行结果，中间状态必须持久化。这引出了三个核心工程问题：

1. **状态存在哪**：内存不可靠（进程可能被杀），必须写到外部存储（Redis + DB）
2. **什么时候存**：每次工具调用完成后、每次 LLM 调用完成后、任务被抢占前
3. **怎么恢复**：从最近一个 Checkpoint 恢复，跳过已执行的幂等工具调用

:::提醒 混淆长短 Agent 是高频设计失误
用处理短 Agent 的架构（同步 HTTP、内存状态）来处理长 Agent，会在生产里遇到：进程被 OOM Kill 导致任务丢失、超时断连、无法回溯失败步骤。发现这个问题往往已经有用户数据损失了。
:::

### Durable Execution：长 Agent 的工业标准

2025 年后，**Durable Execution**（持久化执行）已成为长 Agent 工程的主流范式，其核心思想是：把业务代码写成普通函数/协程，由框架自动在每步之后持久化状态，进程崩溃后能精确从上一步继续，对代码完全透明。

**Temporal.io** 是这一范式最成熟的开源实现：

```python
# Temporal Workflow：看起来是普通 Python 代码，
# 实际上每个 activity 调用后状态自动持久化到 Temporal Server
@workflow.defn
class ResearchAgentWorkflow:
    @workflow.run
    async def run(self, query: str) -> str:
        # 每个 activity 调用对应一个持久化检查点
        search_results = await workflow.execute_activity(
            search_web, query,
            start_to_close_timeout=timedelta(minutes=5),
        )
        summary = await workflow.execute_activity(
            summarize_with_llm, search_results,
            start_to_close_timeout=timedelta(minutes=10),
        )
        return summary
```

如果进程在 `search_web` 和 `summarize_with_llm` 之间崩溃，Temporal Worker 重启后会自动重放历史事件，跳过已完成的 `search_web`，直接从 `summarize_with_llm` 继续——业务代码无需任何改动。

**与自研 Checkpoint 的对比**：

| 维度 | 自研 Checkpoint（Redis/DB） | Temporal Durable Execution |
|---|---|---|
| **开发成本** | 高（需要自己写恢复逻辑） | 低（框架透明处理） |
| **状态一致性** | 需要手动保证 | 框架保证（事件溯源） |
| **重放能力** | 手动实现 | 内置（History Replay） |
| **可观测性** | 需要自建 | Web UI + API 内置 |
| **适用规模** | 中小型系统 | 大规模生产（Stripe、Netflix 使用） |

类似选型还有 **AWS Step Functions**（托管）和 **Prefect**（开源，更偏数据流水线）。

### 混合架构：大多数生产系统的选择

实践中，很少有系统只有一种类型。常见模式是**短 Agent 处理原子操作，长 Agent 编排整体任务**：

```
用户请求
    ↓
长 Agent（Orchestrator，有状态，Temporal Workflow）
    ├─→ 短 Agent：搜索网页（无状态，Serverless Activity）
    ├─→ 短 Agent：执行代码片段（无状态，沙箱容器 Activity）
    └─→ 短 Agent：调用外部 API（无状态，共享连接池 Activity）
```

Orchestrator 持有任务进度和上下文，Worker 无状态、可替换。这是 Manus、Claude Code、字节 Coze 等系统的共同架构模式。

---

## 二、容器与 Pod：Agent 的打包与部署单元

### 为什么 Agent 需要容器

Agent 执行环境的特殊性：
- 可能运行任意用户代码（代码沙箱场景）
- 需要访问文件系统、网络、进程（能力 vs 隔离的矛盾）
- 多租户场景下任务间不能互相干扰
- 执行环境要可重现（相同代码每次执行结果一致）

容器（Container）提供了**进程级别的隔离**：每个 Agent 任务跑在独立的 Linux 命名空间里，有自己的文件系统视图、网络栈、进程树。

```
宿主机（containerd 管理容器生命周期）
├── 容器 A（Agent Task 1）
│   ├── 独立文件系统（overlayfs，分层读写）
│   ├── 独立网络命名空间（veth pair）
│   └── 独立 PID 命名空间
├── 容器 B（Agent Task 2）
│   └── ...
└── 容器 C（Agent Task 3）
    └── ...
```

现代 K8s 集群普遍使用 **containerd**（替代 dockerd）作为容器运行时，其 snapshot 机制能大幅加速镜像层的复用，减少 Agent 容器的创建时间。

### Pod：K8s 的调度原语

在 Kubernetes 里，Pod 是**最小调度单元**，一个 Pod 可以包含多个容器，它们共享网络和存储。

Agent 系统的典型 Pod 设计（含 Init Container）：

```yaml
spec:
  # Init Container：在主容器启动前准备工作空间
  initContainers:
  - name: workspace-init
    image: workspace-init:v1.0
    command: ["sh", "-c", "cp -r /templates/. /workspace/"]
    volumeMounts:
    - name: workspace
      mountPath: /workspace

  containers:
  - name: agent-worker          # 主容器：Agent 执行逻辑
    image: agent-worker:v1.2
    resources:
      requests: { cpu: "500m", memory: "1Gi" }
      limits:   { cpu: "2",    memory: "4Gi" }
    volumeMounts:
    - name: workspace
      mountPath: /workspace

  - name: tool-proxy            # Sidecar：工具调用代理（权限控制）
    image: tool-proxy:v1.0

  - name: log-collector         # Sidecar：日志 + Trace 采集
    image: fluent-bit:latest

  volumes:
  - name: workspace
    emptyDir: {}
```

**Init Container 的工程价值**：
- 在主容器启动前完成工作区初始化（克隆代码仓库、下载工具依赖）
- Init Container 失败会阻止主容器启动，比在主容器内做初始化更安全
- 可以挂载只有 Init Container 有权限访问的 Secret，完成后销毁

**Sidecar 模式的工程意义**：
- `tool-proxy` Sidecar 拦截所有工具调用请求，做鉴权、限流、审计日志——Agent 代码无需感知
- `log-collector` Sidecar 负责日志/Trace 的异步采集，不阻塞主进程
- Sidecar 升级不需要重新构建 Agent 镜像，运维边界清晰

### 资源配额：长短 Agent 的差异配置

| 资源维度 | 短 Agent Pod | 长 Agent Pod |
|---|---|---|
| **CPU** | 0.5–1 核（Burstable） | 1–4 核（Guaranteed） |
| **内存** | 256Mi–1Gi | 2Gi–16Gi（上下文越长，内存越大） |
| **生命周期** | 几秒到几分钟，执行完销毁 | 可能持续数小时，配置 Pod Disruption Budget |
| **存储** | emptyDir（临时） | PVC（持久化）或挂载 Redis/DB |
| **网络策略** | 只允许访问工具白名单 URL | 同上，但可能有更多外部资源访问需求 |

:::方法 资源 QoS 分级
K8s 资源 QoS 有三级：Guaranteed（requests=limits）> Burstable（requests<limits）> BestEffort（无 requests）。长 Agent 一定要用 Guaranteed，防止被 OOM Killer 随机杀死。短 Agent 可以 Burstable，节省资源。
:::

### 弹性伸缩：KEDA + Karpenter

静态 Worker 数量既浪费又不够灵活。生产里用两层弹性：

**KEDA（Kubernetes Event-Driven Autoscaling）** 基于队列深度动态调整 Worker 副本数：

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: agent-worker-scaler
spec:
  scaleTargetRef:
    name: agent-worker-deployment
  minReplicaCount: 2      # 保持最小 2 个 Worker（温启动备用）
  maxReplicaCount: 100    # 峰值最多 100 个
  triggers:
  - type: redis
    metadata:
      listName: agent-task-queue
      listLength: "10"    # 队列每积压 10 条任务，增加 1 个 Worker
```

**Karpenter** 在节点层面按需创建 EC2/GCP 实例，比 Cluster Autoscaler 更快（< 60s），且支持按 GPU 型号、Spot 价格等维度选择实例类型。

两者组合：**KEDA 控制 Pod 数量 → Karpenter 控制节点数量**，实现完整的双层弹性。

### GPU Agent：特殊的调度需求

当 Agent 需要运行本地模型推理时，GPU 调度引入额外复杂性：
- GPU 不可超分（和 CPU 不同），一个 GPU 通常只给一个任务
- **MIG（Multi-Instance GPU）** 可以把一张 A100 切成最多 7 个 GPU 切片，适合中小型推理任务
- 短 Agent 的 GPU 任务适合用 **GPU Time-Slicing**（NVIDIA Device Plugin 支持）；长 Agent 推理最好独占 MIG 切片
- **KServe** 提供了 Model Server 级别的自动扩缩容，可以把推理服务从 Agent Worker 里解耦出来

---

## 三、线程分配与调度：Agent 并发的工程基础

### Agent 内部的并发模型

一个 Agent 执行过程中有两类操作：

- **IO 密集型**：等待 LLM API 响应、等待工具调用结果、数据库查询
- **CPU 密集型**：解析 LLM 输出、上下文压缩计算、向量检索

对应两种并发原语：

```
IO 密集型 → 异步协程（async/await）
             Python: asyncio + uvloop
             Go:     goroutine（天然支持，无需选型）
             JS/TS:  单线程事件循环（Node.js）

CPU 密集型 → 线程池 / 进程池
             Python: concurrent.futures.ProcessPoolExecutor（绕过 GIL）
             Go:     goroutine + GOMAXPROCS 自动利用多核
```

**Python Agent 的典型并发实现**：

```python
import asyncio
import uvloop                          # 替代默认 asyncio 事件循环，速度提升 2-4x
from concurrent.futures import ProcessPoolExecutor

asyncio.set_event_loop_policy(uvloop.EventLoopPolicy())

class AgentWorker:
    def __init__(self):
        self.cpu_pool = ProcessPoolExecutor(max_workers=4)

    async def run_step(self, step):
        # IO 操作：async/await 不阻塞事件循环
        # asyncio.TaskGroup (Python 3.11+) 支持结构化并发，
        # 任意一个 task 抛异常，整组自动取消
        async with asyncio.TaskGroup() as tg:
            llm_task   = tg.create_task(self.call_llm(step.prompt))
            cache_task = tg.create_task(self.check_cache(step.action))

        llm_result, cached = llm_task.result(), cache_task.result()

        if not cached:
            tool_result = await self.call_tool(step.action)

        # CPU 操作：进程池，绕开 GIL
        loop = asyncio.get_running_loop()
        compressed = await loop.run_in_executor(
            self.cpu_pool, compress_context, llm_result
        )
        return compressed
```

:::方法 uvloop 是生产标配
uvloop 基于 libuv（Node.js 的事件循环库），IO 密集场景下吞吐量比默认 asyncio 高 2–4 倍，且 API 完全兼容，只需两行切换。Agent Harness 是 IO 密集场景的典型，强烈推荐使用。
:::

### 分布式 Python：Ray 的角色

当单机 Worker 不足以承载 Agent 并发时，**Ray** 是 Python 生态里最成熟的分布式计算框架：

```python
import ray

@ray.remote
class AgentWorker:
    async def run(self, task: AgentTask) -> AgentResult:
        ...

# Ray 自动分配任务到集群中的空闲节点
workers = [AgentWorker.remote() for _ in range(100)]
results = await asyncio.gather(*[w.run.remote(task) for w in workers])
```

Ray 的优势：
- 内置任务调度、故障恢复、资源管理
- 支持 GPU 任务的亲和调度（`@ray.remote(num_gpus=1)`）
- `ray.serve` 提供在线推理服务部署，适合把本地模型作为 Agent 的工具

### Worker 调度：任务队列的设计

Agent 任务调度通常基于**消息队列 + Worker Pool**架构：

```
                         ┌──────────────────────────────────────┐
                         │         任务调度层（KEDA 弹性）       │
请求入口 → Task Queue    │  ┌──────────┐  ┌──────────┐          │
（Kafka/SQS/Redis）  →  │  │ Worker 1 │  │ Worker 2 │  ...     │
                         │  │ (async)  │  │ (async)  │          │
                         │  └──────────┘  └──────────┘          │
                         └──────────────────────────────────────┘
                                      ↓
                              Checkpoint Store
                            （Redis + PostgreSQL / Temporal Server）
```

Python 生态中最常用的任务队列是 **Celery**（配合 Redis/RabbitMQ broker），适合中等规模；大规模生产推荐 **Temporal**（强一致性 + 内置可观测性）或 **AWS SQS + Lambda**（Serverless）。

**优先级队列**：不同 Agent 任务有不同优先级：

| 优先级 | 任务类型 | 调度策略 |
|---|---|---|
| P0（实时） | 用户直接等待的交互式任务 | 独立队列，抢占低优任务 |
| P1（高优） | 付费用户后台任务 | 优先队列，保证 SLA |
| P2（普通） | 普通用户任务 | FIFO 队列 |
| P3（低优） | 批处理/离线任务 | Best-Effort，空闲时执行 |

**Work Stealing**：高级调度器（如 Go runtime、Java ForkJoinPool）采用 Work Stealing——空闲 Worker 从繁忙 Worker 的队列末尾偷任务。Agent 场景实现 Work Stealing 的前提是任务可以在任意 Worker 上继续执行（即状态必须外部化）。

### 调度器的核心指标

监控调度层健康状态的关键指标：

- **队列积压深度**（Queue Depth）：> 1000 条说明 Worker 不够，需要 scale out
- **任务调度延迟**（Schedule Latency）：从入队到开始执行的时间，P95 > 5s 要告警
- **Worker 利用率**：< 40% 说明 Worker 过多可以收缩；> 85% 说明即将饱和
- **任务超时率**：任务超过 max_deadline 被强制终止的比率

---

## 四、三种启动模式：冷启动、温启动、热启动

启动模式是 Agent 基础设施中**延迟 vs 资源消耗**最直接的权衡维度。

### 冷启动（Cold Start）

**定义**：从零创建一个全新的执行环境，没有任何预热。

```
冷启动各阶段耗时（容器场景，Python Agent）：

镜像层拉取（首次，节点无缓存）  ～ 10–30s
  ↓ （节点有镜像缓存后跳过）
容器创建 + namespace 初始化     ～ 200–500ms
Python 解释器启动               ～ 100–300ms
依赖库 import（torch/numpy 等） ～ 2–8s
连接池初始化（Redis/DB）        ～ 100–500ms
本地模型加载（如有）            ～ 30s–数分钟
                                 ─────────────
纯代码启动（无模型）            ～ 3–10s
含大模型加载                    ～ 分钟级
```

:::提醒 Lambda 冷启动和容器冷启动不同
AWS Lambda Python 函数的冷启动（无 VPC）通常只需 200–500ms，因为 Lambda 基础设施已经在 MicroVM 层面预热了大量空实例（Firecracker VM），只需注入函数代码。容器冷启动慢的主要原因是镜像拉取和依赖加载，两者数量级不同。
:::

**工程优化**：
- **镜像分层缓存**：把不变的依赖层（numpy、torch 等）固化到 base image，每次只拉取业务代码层
- **懒加载**：只 import 当前任务需要的工具库（避免一次性 import 全部）
- **节点预拉取**：用 DaemonSet 在每个 K8s 节点上预先拉取常用 Agent 镜像
- **CRIU（Checkpoint/Restore In Userspace）**：把已初始化的进程快照到磁盘，下次直接从快照恢复，跳过启动和 import 阶段（实验性，Modal.com 等平台在使用）

**适用场景**：
- 安全隔离要求极高的场景（每次任务必须全新环境）
- 任务本身执行时间很长（启动延迟相对可以忽略）
- 极低频任务（不值得预热）

### 温启动（Warm Start）

**定义**：执行环境预先创建好并保持待命，任务到来时直接分配并初始化任务上下文。

```
温启动各阶段耗时：

从 Warm Pool 取出预创建实例     ～ 0ms
任务上下文注入（env / config）   ～ 50–100ms
重置上次任务的残留状态           ～ 10–50ms
                                 ─────────────
总延迟                           ～ 100–200ms
```

**Warm Pool 管理**：

```
                    min_warm   max_warm
实例池：  [空闲][空闲][空闲] ... (预创建 N 个)
                              ↑
                         新任务到来，取出一个
                              ↓
                         任务完成，清理后放回池
                         （或销毁，按 warmup_ttl 配置）
```

**关键配置**：
- `min_warm_instances`：始终保持的最小空闲实例数（防止突发流量冷启动）
- `max_warm_instances`：空闲实例上限（防止资源浪费）
- `warmup_ttl`：空闲实例的最大存活时间（超时后销毁，防止环境污染积累）

**Firecracker VM 快照：温启动的高级实现**

AWS Lambda、Fly.io、Modal.com 等平台已经将 **Firecracker MicroVM 快照** 作为温启动的核心机制：

```
首次启动一个 Firecracker VM，完成初始化后打快照：
  VM 内存状态 + 磁盘状态 → 序列化到文件（通常 < 500MB）

下次任务到来时，从快照恢复 VM：
  加载内存快照 + 恢复磁盘    ～ 50–150ms（比从零启动快 10-100x）
  注入任务上下文              ～ 50ms
                              ─────────
总启动延迟                    ～ 100–200ms，且是 VM 级隔离强度
```

这是目前冷启动性能和隔离强度之间最好的工程平衡——**VM 快照让每个任务都有 MicroVM 级别的隔离，同时实现了接近容器温启动的延迟**。AWS Lambda 的"快速冷启动"本质上就是这个机制。

:::提醒 温启动的安全隐患
温启动实例在任务间复用时，必须严格清理上一次任务的残留状态：环境变量、临时文件、内存数据、进程间通信通道。不清理导致的数据泄露比冷启动慢 10 倍的代价更严重。Firecracker 快照从根本上解决了这个问题——每次都从同一个干净快照恢复。
:::

### 热启动（Hot Start）

**定义**：实例不仅预创建好，还保持了任务特定的上下文（甚至连接到特定用户/会话），任务到来时几乎零延迟开始执行。

```
热启动各阶段耗时：

从用户级专属实例池取出实例     ～ 0ms
实例已持有：用户上下文、        （已加载）
  模型 KV Cache、工具连接
                               ─────────────
总延迟                          ～ < 50ms
```

**适用场景**：
- 高频交互式 Chatbot（用户等待响应）
- 有持续上下文的长对话 Agent
- Streaming 场景（首 Token 延迟要求 < 500ms）
- 需要复用 LLM KV Cache 的对话（同一个 System Prompt，不重新计算）

**代价**：
- 资源消耗最高（每个活跃用户/会话持有一个专属实例）
- 实例泄漏风险（用户离开后实例不及时回收）
- 状态隔离更复杂（共享更多上下文意味着更多污染风险）

**KV Cache 复用是热启动的核心收益之一**：对话场景的 System Prompt 通常有数千 Token，每次冷启动都需要全量计算。热启动实例保留了 KV Cache，首 Token 延迟可以从 1–2s 降低到 200ms 以内（Anthropic Prompt Caching 提供 API 层面的等效能力）。

### 三种启动模式对比

| 维度 | 冷启动 | 温启动 | 热启动 |
|---|---|---|---|
| **首次延迟** | 3s ~ 分钟级 | 100–300ms | < 50ms |
| **资源占用** | 极低（按需创建） | 中（维持 Warm Pool） | 高（专属实例） |
| **隔离强度** | 最强（全新环境） | 中（快照恢复 = VM 级隔离）| 弱（持有状态） |
| **适合任务类型** | 批处理、高安全要求 | 通用后台任务 | 交互式、对话式 |
| **典型选型** | K8s Job 按需创建 | Firecracker 快照池 / Lambda Provisioned Concurrency | 专属容器 / 进程保活 |

### 生产策略：分层启动

实际系统通常不是单一策略，而是**分层**：

```
用户发起任务
      ↓
  有没有热实例？→ 有 → 热启动（< 50ms）
      ↓ 没有
  有没有温实例？→ 有 → 温启动（~200ms，Firecracker 快照）
      ↓ 没有
  冷启动（> 3s，同时预热一批温实例备用）
```

AWS Lambda Provisioned Concurrency 本质上是官方提供的温实例池管理，按配置数量始终保持预热实例，避免冷启动。对于 Agent 服务，这是 Serverless 架构下最直接的温启动方案。

:::启发 延迟预算的反推设计
不要从"什么启动方式最好"出发，而是从**用户延迟预算**反推：交互式场景通常要求首次响应 < 2s，减去 LLM 调用的 ~1s，留给启动的时间只有 1s，这意味着温启动是下限。实时场景（语音助手等）延迟预算 < 500ms，必须热启动。
:::

---

## 五、权限隔离：谁能做什么

Agent 权限隔离是"最小权限原则"在 Agent 系统的具体落地。核心问题：**这个 Agent 实例，在这次任务中，应该能访问哪些资源、执行哪些操作？**

### 权限的四个维度

#### 1. 系统级隔离（Linux 命名空间 + Seccomp + Pod Security Standards）

容器内的 Agent 进程受 Linux 内核机制约束：

```
命名空间隔离（Linux Namespace）：
- PID namespace：Agent 进程看不到宿主机其他进程
- Network namespace：独立网络栈，出口流量受 NetworkPolicy 控制
- Mount namespace：独立文件系统视图，不能访问宿主机路径
- User namespace：容器内 root ≠ 宿主机 root（用户重映射）

Seccomp 策略（系统调用白名单）：
- 允许：read、write、open、close、socket（受限）...
- 禁止：ptrace（防进程注入）、mount（防挂载攻击）、kexec（防内核替换）

Pod Security Standards（PSS，K8s 1.25+ 内置，替代已废弃的 PSP）：
- Privileged：无限制（仅系统组件）
- Baseline：防止已知提权（禁止 hostPID、hostNetwork、特权容器）
- Restricted：当前最严格标准（强制 runAsNonRoot、禁止所有 capabilities）
```

生产 Agent 集群应对所有命名空间强制 `Restricted` 级别，并通过 OPA Gatekeeper 策略拦截不合规的 Pod 创建请求。

**Falco / Tetragon：运行时安全检测**

静态策略只能防已知威胁；**Falco**（CNCF 项目）在运行时监控系统调用，实时检测异常行为：

```yaml
# Falco 规则示例：检测 Agent 容器里的可疑网络连接
- rule: Agent container connects to unexpected IP
  desc: Agent worker pod connected to an IP not in the allowlist
  condition: >
    evt.type = connect and
    container.label.role = "agent-worker" and
    not fd.sip in (allowed_ip_set)
  output: "Unexpected outbound connection from agent (ip=%fd.sip)"
  priority: WARNING
```

**Tetragon**（Cilium 项目）基于 eBPF，开销比 Falco 更低，且能在内核层面直接阻断违规操作（不只是告警）。

#### 2. 网络级权限（NetworkPolicy + Egress 控制）

Agent 的出口网络访问应该只允许白名单：

```yaml
# K8s NetworkPolicy：Agent Worker 只能访问内部工具服务和 HTTPS 出口
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: agent-egress-policy
spec:
  podSelector:
    matchLabels:
      role: agent-worker
  policyTypes:
  - Egress
  egress:
  - to:
    - ipBlock:
        cidr: 10.0.0.0/8    # 内部工具服务
  - ports:
    - port: 443              # HTTPS 出口（需配合 DNS 域名过滤）
```

**实践原则**：
- 代码执行类 Agent（沙箱场景）：**完全禁止出口网络**，防止数据外泄和反向 shell
- 搜索类 Agent：只允许访问特定域名白名单（结合 Egress Gateway + DNS 过滤）
- 通用 Agent：允许 HTTPS，但记录所有出口流量（服务网格 / eBPF）

#### 3. 工作负载身份与凭证管理（SPIFFE/SPIRE + Vault）

静态 API Key 是权限管理的最大风险点。主流最佳实践是用**工作负载身份**替代静态凭证：

**SPIFFE/SPIRE**（CNCF 标准）为每个 Agent Pod 颁发短期 x.509 证书（SVID），证明"我是运行在这个 K8s 命名空间里的这个 ServiceAccount 的工作负载"：

```
K8s 节点上的 SPIRE Agent
    ↓ 验证 Pod 身份（K8s Attestor）
    ↓ 申请 SVID（x.509 证书，TTL = 1 小时）
Agent Pod
    ↓ 用 SVID 向 Vault 换取动态凭证
    ↓（Vault 验证 SVID，颁发短期 DB 密码 / AWS STS Token）
Agent 执行工具调用（凭证 TTL 与任务时长绑定）
    ↓ 任务完成，Vault Lease 自动吊销
```

这个链路实现了：**零静态 Secret → 凭证自动轮换 → 任务结束即吊销**，比在 K8s Secret 里存 API Key 安全数量级。

**短期 Scoped Token 示例**：

```python
def create_scoped_credential(task_id: str, duration: int):
    return {
        "token": sign_jwt({
            "sub": f"agent-task/{task_id}",
            "scope": ["db:read:customer_data"],
            "exp": time.time() + duration,
            "jti": str(uuid4())    # 唯一 ID，支持单次吊销
        }),
        "expires_at": time.time() + duration
    }
```

#### 4. 策略即代码（OPA / Open Policy Agent）

权限规则散在代码里难以审计，**OPA**（Open Policy Agent）用 Rego 语言统一描述策略，作为 K8s Admission Webhook 拦截不合规请求：

```rego
# OPA Rego 策略：Agent Pod 必须以非 root 用户运行
package kubernetes.admission

deny[msg] {
    input.request.kind.kind == "Pod"
    input.request.object.metadata.labels.role == "agent-worker"
    not input.request.object.spec.securityContext.runAsNonRoot
    msg := "Agent worker pods must run as non-root"
}
```

**OPA + Gatekeeper** 的组合让所有 K8s 资源的安全策略都变成可 Git 版本管理、可 CI 测试的代码，而不是散落在各处的手动配置。

#### 5. 操作级权限（Human-in-the-Loop 分级）

高风险操作的权限不是"有没有"，而是"谁来确认"：

```
操作风险分级：

低风险（自动执行）：
  - 只读查询（搜索、读文件、查数据库）
  - 幂等写操作（写临时文件）

中风险（异步通知，事后可撤销）：
  - 发送通知（邮件、Slack）
  - 更新文档（有版本历史）
  - 写数据库（有软删除）

高风险（同步确认，超时取消）：
  - 删除操作（文件、数据库记录）
  - 调用外部支付接口
  - 权限变更、代码部署
```

### 多租户场景：租户间隔离

当同一套 Agent 基础设施服务多个租户（B2B 场景）时，需要额外的租户隔离层：

```
租户 A 的 Agent 任务               租户 B 的 Agent 任务
        ↓                                  ↓
  K8s Namespace: tenant-a          K8s Namespace: tenant-b
  专属 NetworkPolicy                专属 NetworkPolicy
  专属 ServiceAccount               专属 ServiceAccount
  SPIRE SVID（租户隔离）            SPIRE SVID（租户隔离）
  Vault Namespace: tenant-a         Vault Namespace: tenant-b
        ↓                                  ↓
  禁止跨命名空间通信（NetworkPolicy + OPA）
```

**关键原则**：
- **存储隔离**：不同租户的数据存不同 DB Schema 或 Redis keyspace（前缀 + ACL），禁止跨租户查询
- **日志隔离**：日志写入时带 `tenant_id` 标签，查询时 OPA 强制过滤，运维人员也无法越权查看其他租户日志
- **资源配额**：每个租户有独立的 K8s `ResourceQuota`，防止噪声邻居（Noisy Neighbor）耗尽共享资源

:::方法 Vault Namespace 隔离
HashiCorp Vault Enterprise 的 Namespace 功能可以为每个租户创建完全隔离的凭证管理空间——不同租户的 Secret Engine、Policy、Token 完全隔离，管理员权限也互不影响。开源版可以用 Path 前缀 + Policy 实现近似效果。
:::

---

## 六、端到端架构：把五层拼在一起

```
用户请求
    ↓
API Gateway（认证 + 限流）
    ↓
任务分类器
  ├─ 短任务 → Serverless Pool（Firecracker 快照温启动，~200ms）
  └─ 长任务 → Temporal Worker Pool（Durable Execution，有状态）
    ↓
调度器（KEDA 弹性 + 优先级队列 + Work Stealing）
    ↓
Agent Pod
  ├─ Init Container（工作区初始化）
  ├─ 主容器（Agent 执行逻辑，asyncio + uvloop / Go goroutine）
  ├─ Tool-Proxy Sidecar（SPIFFE SVID 鉴权 + 审计日志）
  └─ Log-Collector Sidecar（OpenTelemetry Trace → Jaeger）
    ↓
执行层
  ├─ LLM API（限流 + 多模型路由 + Prompt Cache 复用）
  ├─ 工具沙箱（代码执行：gVisor / Firecracker）
  └─ 状态持久化（Temporal Server / Redis + PostgreSQL）
    ↓
权限层
  ├─ 系统级（Seccomp + Namespace + Pod Security Standards）
  ├─ 运行时安全（Falco / Tetragon eBPF 监控）
  ├─ 网络级（NetworkPolicy + Egress 白名单）
  ├─ 工作负载身份（SPIFFE/SPIRE → Vault 动态凭证）
  ├─ 策略管理（OPA Gatekeeper）
  └─ 操作级（HITL 分级确认）
```

---

## 关键设计决策速查

| 场景 | 推荐选型 | 核心理由 |
|---|---|---|
| 用户实时等待的对话 Agent | 热启动 + 专属进程 + KV Cache 复用 | 延迟要求 < 500ms |
| 用户触发的后台任务 | Firecracker 快照温启动 | VM 级隔离 + ~200ms 延迟 |
| 批处理/定时任务 | 冷启动 + 按需创建 K8s Job | 隔离强，资源成本低 |
| 长任务编排 | Temporal Durable Execution | 透明 Checkpoint，不需要手写恢复逻辑 |
| 代码执行类工具 | MicroVM（Firecracker/gVisor）| 安全隔离第一 |
| Python 高并发 Worker | asyncio + uvloop + ProcessPoolExecutor | IO 密集用协程，CPU 密集用进程池 |
| 分布式 Python 计算 | Ray（ray.remote）| K8s 原生，支持 GPU 亲和调度 |
| 弹性伸缩 | KEDA（队列深度触发）+ Karpenter（节点自动供给） | 双层弹性，无需手动配置副本数 |
| 凭证管理 | SPIFFE/SPIRE → Vault 动态凭证 | 零静态 Secret，自动吊销 |
| 多租户 B2B 场景 | K8s Namespace + Vault Namespace + OPA | 合规和数据隔离要求 |
| 运行时安全监控 | Falco（规则告警）/ Tetragon（eBPF 阻断） | 防御绕过容器静态策略的攻击 |
| 长任务 Worker 资源 | Guaranteed QoS + PodDisruptionBudget | 防 OOM Kill + 滚动升级不中断任务 |

---

## 参考文献

### Agent 运行时与基础设施

1. Anthropic. **"Building Effective Agents."** Anthropic Engineering Blog, December 2024. — 明确区分 Workflow（固定流程）与 Agent（动态决策）两类系统，是长短 Agent 分类的工程依据。

2. OpenAI. **"Practices for Governing Agentic AI Systems."** December 2023. — 提出 Agent 基础设施的三项安全属性：最小权限、可中断、可回滚，对权限隔离设计有直接指导意义。

3. OpenAI. **"OpenAI Agents SDK Documentation."** 2025. — Agents SDK 的 Handoffs、Guardrails、Tracing 设计，展示了短 Agent（工具调用）和长 Agent（多步骤 Handoff）的官方架构选型。

4. Shunyu Yao, Jeffrey Zhao, Dian Yu, Nan Du, Izhak Shafran, Karthik Narasimhan, Yuan Cao. **"ReAct: Synergizing Reasoning and Acting in Language Models."** *ICLR 2023*. arXiv:2210.03629. — ReAct 范式：Thought-Action-Observation 循环，Agent 步骤是状态持久化的基本单元。

### 容器与 Kubernetes

5. CNCF. **"Kubernetes Documentation: Resource Management for Pods and Containers."** kubernetes.io, 2024. — QoS 分级（Guaranteed / Burstable / BestEffort）与 OOM Kill 行为的官方文档。

6. CNCF / KEDA. **"KEDA: Kubernetes Event-Driven Autoscaling."** keda.sh, 2024. — 基于队列深度、Kafka Lag、Prometheus 指标的 Pod 弹性伸缩方案，Agent Worker 扩缩容的主流选型。

7. AWS. **"Karpenter: Just-in-time Nodes for Any Kubernetes Cluster."** karpenter.sh, 2024. — 节点级自动供给，比 Cluster Autoscaler 快 2–5 倍，支持 GPU 节点的 Spot 竞价选型。

8. containerd Authors. **"containerd: An industry-standard container runtime."** containerd.io, 2024. — containerd 的 snapshot 机制（overlayfs / native snapshotter）对容器创建速度的影响。

### 启动优化与 MicroVM

9. Alexandru Agache, Marc Brooker, Alexandra Iordache, Anthony Liguori, Rolf Neugebauer, Phil Piwonka, Diana-Maria Popa. **"Firecracker: Lightweight Virtualization for Serverless Applications."** *NSDI 2020*. — Firecracker 的设计论文：100ms 内启动 MicroVM，内存占用 < 5MB；AWS Lambda 和 Fargate 的底层基础。

10. AWS. **"Lambda Provisioned Concurrency."** AWS Documentation, 2024. — Provisioned Concurrency 的官方文档，本质上是托管的温实例池；附 SnapStart（Java Lambda 基于 CRaC 的快照机制）说明。

11. CRIU Project. **"CRIU: Checkpoint/Restore In Userspace."** criu.org, 2024. — 进程级快照技术，允许把已初始化的 Python 进程序列化到磁盘，下次直接恢复，跳过 import 和初始化阶段。

12. Modal Labs. **"How Modal works: Container Snapshots."** modal.com/blog, 2024. — Modal 的容器快照机制（基于 CRIU），实现 Python 容器的温启动；冷启动中 Python import 阶段从 3–8s 降至 100ms 以内。

### 异步并发与分布式调度

13. MagicStack. **"uvloop: Blazing fast Python networking."** GitHub: magicstack/uvloop, 2024. — 基于 libuv 的 asyncio 事件循环替代，IO 密集场景吞吐量提升 2–4 倍，API 完全兼容 asyncio。

14. Temporal Technologies. **"Temporal Documentation: What is Durable Execution?"** docs.temporal.io, 2024. — Durable Execution 范式的完整工程文档：事件溯源、确定性重放、Activity 重试策略；Stripe、Netflix、Datadog 在生产使用。

15. Philipp Moritz et al. **"Ray: A Distributed Framework for Emerging AI Applications."** *OSDI 2018*. — Ray 的系统论文：面向 AI/ML 的分布式 Python 执行框架，Task + Actor 模型；Agent 大规模分布式场景的主流选型。

### 权限隔离与安全

16. CNCF / SPIFFE. **"SPIFFE: Secure Production Identity Framework For Everyone."** spiffe.io, 2024. — 工作负载身份标准（x.509 SVID），解决 Kubernetes 内 Pod 之间及 Pod 与外部服务之间的身份认证问题；与 Vault 集成实现零静态 Secret。

17. Open Policy Agent. **"OPA Documentation."** openpolicyagent.org, 2024. — Rego 策略语言与 Gatekeeper Admission Webhook；K8s 中 Agent Pod 安全策略的声明式管理方案。

18. The Falco Authors (CNCF). **"Falco: Cloud Native Runtime Security."** falco.org, 2024. — 基于 Linux 系统调用的运行时安全监控，可实时检测容器逃逸、异常网络连接、可疑进程执行。

19. Isovalent / Cilium. **"Tetragon: eBPF-based Security Observability and Runtime Enforcement."** tetragon.io, 2024. — 基于 eBPF 的内核级安全策略，支持在系统调用层面直接阻断违规操作（不只是告警），开销比 Falco 更低。

20. HashiCorp. **"Vault Documentation: Dynamic Secrets."** developer.hashicorp.com/vault, 2024. — Vault 动态凭证（Database Secret Engine / AWS Secrets Engine）：按需生成短期凭证，任务结束自动吊销，是生产级零静态 Secret 架构的核心组件。
