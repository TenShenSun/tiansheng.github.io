# 记忆系统的实现：Agent 如何突破上下文窗口的边界

大模型天生是无状态的。

每次对话结束，模型忘掉一切。这个问题在 Chatbot 时代还能接受——用户重新说一次就好。但到了 Agent 时代，任务周期可以持续几天、几周，Agent 需要记住用户的偏好、上次做了什么、哪些方案试过失败了。

**记忆系统是 Agent 从"工具"变成"伙伴"的关键工程**。

这篇文章不讲"上下文工程"的高层概念——那部分在 [第 6 篇](https://tianshengsun.com/#/post/06-context-engineering) 里。这里讲**实现**：记忆系统内部怎么设计、怎么读写、怎么在生产环境里工程化。

---

## 一、上下文 vs 记忆：两个不同的概念

很多人把"上下文"和"记忆"混为一谈。它们的关系是：

```
记忆系统
├── 工作记忆（Working Memory）
│     = 当前上下文窗口里的内容
│     = 短期、易失、容量有限
│
└── 长期记忆（Long-term Memory）
      = 上下文窗口之外的外部存储
      = 持久、需要显式读写、容量无限
```

**上下文窗口是记忆的一种**——是工作记忆，但不是全部。

Agent 真正需要的是一套机制，让它能把"重要的东西"从工作记忆移到长期记忆，在需要时再取回来。

---

## 二、四类记忆的分类框架

认知科学给出了一套经典分类，直接对应 Agent 实现：

```
认知科学分类          Agent 对应实现
───────────────────   ────────────────────────────────
情节记忆              过去的对话/任务历史（向量库）
 (Episodic Memory)    "上次我们讨论过 A 方案"

语义记忆              外部知识库（文档、知识图谱）
 (Semantic Memory)    "Python 的 asyncio 怎么用"

程序性记忆            Few-shot 示例、工具调用模板
 (Procedural Memory)  "遇到这类问题用这个工具"

工作记忆              当前上下文窗口
 (Working Memory)     "这次对话里刚说的内容"
```

理解这个分类，是设计记忆系统的第一步——**不同类型的记忆，读写频率、存储格式、检索策略都不同**。

---

## 三、工作记忆：上下文窗口的精细管理

工作记忆是最直接的，但也有工程细节。

### 3.1 上下文槽位分配

一个 128k token 的上下文窗口，不是拿来全塞对话历史的：

```
┌─────────────────────────────────────────┐
│ System Prompt（固定）          ~2k token │
│ 用户 Profile / 偏好摘要         ~1k token │
│ 当前任务描述                    ~2k token │
│ 检索召回的长期记忆               ~8k token │
│ 工具定义 / 可用能力              ~4k token │
│ 近期对话历史                   ~10k token │
│ 当前轮次输入                    ~2k token │
│ 模型输出空间（预留）             ~4k token │
└─────────────────────────────────────────┘
总计: ~33k token，留出 buffer
```

:::方法 上下文槽位分配的工程原则
实际生产中要做"槽位预算"管理。每个槽位设上限，超出时触发压缩或截断。

Transformer 的注意力分布是 **U 形**：开头和结尾都是高注意力区，中间是低注意力区（["Lost in the Middle"，Liu et al. 2023](https://arxiv.org/abs/2307.03172)）。布局策略由此而来：
- **最前**（高注意力）：系统 prompt、工具定义——必须让模型始终遵守的约束
- **最后**（高注意力）：最近几轮对话——模型生成下一个 token 时天然偏重靠近的内容
- **中间**（低注意力）：检索召回的记忆、RAG 内容——仍然有用，但模型对此区域注意力弱，所以要做好压缩，把最关键的部分放到前后段

不要让历史对话无限增长，超过阈值就触发摘要压缩。
:::

### 3.2 对话历史的压缩策略

对话历史是工作记忆里消耗最快的部分。三种处理方式：

**策略一：滑动窗口（Sliding Window）**

```python
def get_context_messages(history: list[Message], max_tokens: int) -> list[Message]:
    # 保留最新的 N 轮，超出就丢掉最旧的
    result = []
    token_count = 0
    for msg in reversed(history):
        msg_tokens = count_tokens(msg)
        if token_count + msg_tokens > max_tokens:
            break
        result.insert(0, msg)
        token_count += msg_tokens
    return result
```

优点：简单。缺点：丢失的历史不可恢复，Agent 容易"失忆"。

**策略二：层级摘要（Hierarchical Summarization）**

```
原始历史：[turn1, turn2, ..., turn20]
        ↓ 当 turn 数超过阈值
摘要层：  [summary(turn1-10), turn11, ..., turn20]
        ↓ 再次超过阈值
摘要层：  [summary(summary(turn1-10) + turn11-20), turn21, ...]
```

优点：信息损失小。缺点：摘要是 LLM 生成的，可能引入幻觉。

**策略三：选择性保留（Selective Retention）**

```
对每一轮对话打重要性标签：
  - 用户明确说"记住这个" → 重要度 HIGH
  - 工具调用的结果 → 重要度 MEDIUM
  - 闲聊 → 重要度 LOW

上下文满时：先丢 LOW，再丢 MEDIUM，保留 HIGH
```

生产系统通常三种策略结合使用。

---

## 四、情节记忆：向量库的读写设计

情节记忆存的是"发生过什么"——过去的对话、任务执行记录、用户反馈。核心实现是向量数据库。

### 4.1 写入时机与内容选择

:::观点 不要把所有内容都存进记忆
存储成本不是问题，检索精度才是。如果把所有对话都写进向量库，检索时会召回大量噪声，反而干扰 Agent 的判断。只存"值得记住的内容"。
:::

什么值得存？

```
值得存入长期记忆的内容：
  ✓ 用户明确表达的偏好（"我不喜欢用 Redux"）
  ✓ 任务执行的关键节点（"方案 A 已验证失败，原因是..."）
  ✓ 对话中的重要决策（"用户决定放弃 Python 改用 Go"）
  ✓ 错误与教训（"这个 API 有速率限制，之前踩过"）

不需要存入长期记忆的内容：
  ✗ 纯粹的闲聊
  ✗ 已经在知识库里有的通用知识
  ✗ 中间步骤的临时推理过程
```

### 4.2 记忆写入的实现

```python
class EpisodicMemory:
    def __init__(self, vector_store: VectorStore):
        self.store = vector_store

    async def store(self, content: str, metadata: dict) -> str:
        # 生成嵌入向量
        embedding = await embed(content)

        # 存入向量库，带元数据
        memory_id = await self.store.upsert(
            vector=embedding,
            payload={
                "content": content,
                "timestamp": datetime.utcnow().isoformat(),
                "user_id": metadata["user_id"],
                "session_id": metadata["session_id"],
                "importance": metadata.get("importance", "medium"),
                **metadata
            }
        )
        return memory_id
```

### 4.3 记忆检索：不只是相似度搜索

纯向量相似度检索有一个盲区：**最相似的记忆不一定是最相关的**。

考虑这个例子：
```
用户问："帮我重写这个函数"
历史记忆中有：
  A. 上周讨论了"如何重构函数"（语义相似度高）
  B. 三天前用户说"我不喜欢递归写法"（语义相似度低）

纯相似度搜索会召回 A，但 B 其实更影响这次的输出。
```

生产系统的检索策略通常是混合的：

```python
async def retrieve_memories(
    query: str,
    user_id: str,
    top_k: int = 5
) -> list[Memory]:
    # 1. 向量相似度（语义）
    semantic_results = await vector_store.search(
        vector=await embed(query),
        filter={"user_id": user_id},
        top_k=top_k * 2
    )

    # 2. 时间衰减加权（最近的记忆权重更高）
    for r in semantic_results:
        age_days = (now() - r.timestamp).days
        r.score *= exp(-0.1 * age_days)

    # 3. 重要性加权
    importance_weight = {"high": 1.5, "medium": 1.0, "low": 0.5}
    for r in semantic_results:
        r.score *= importance_weight[r.importance]

    # 4. 按最终得分排序，返回 top_k
    return sorted(semantic_results, key=lambda x: x.score, reverse=True)[:top_k]
```

:::方法 MMR：最大边际相关性
实际检索还要避免召回一堆内容高度重合的记忆。MMR（Maximal Marginal Relevance）在保证相关性的同时最大化多样性：每次选取"与查询最相关、但与已选结果最不重复"的候选，避免冗余。
:::

---

## 五、语义记忆：外部知识的接入

语义记忆存的是"世界是什么"——产品文档、代码库、领域知识。这其实就是 RAG 的范畴。

但语义记忆和情节记忆有一个关键区别：

```
情节记忆：个人化、动态增长、记录发生过的事
语义记忆：共享化、定期更新、存储通用知识
```

工程上的含义：
- 语义记忆用**同一个知识库**服务所有用户（节省存储）
- 情节记忆是**每个用户自己的**（隔离，不能共享）

### 5.1 知识库的分层索引

```
Layer 1: 全文索引（BM25）
  → 精确关键词匹配（用户问"asyncio.gather"，直接命中）

Layer 2: 向量索引（Dense Retrieval）
  → 语义相近匹配（用户问"并发执行多个任务"，召回 asyncio 文档）

Layer 3: 结构化索引（Graph / SQL）
  → 关系查询（"这个 API 依赖哪些其他 API？"）
```

实际系统通常做 Hybrid Retrieval：BM25 + Dense，然后用 Reranker 做二次排序。

---

## 六、程序性记忆：Agent 的"肌肉记忆"

程序性记忆是最容易被忽视的一类，但在实际 Agent 系统里非常重要。

它存的是**怎么做**——面对某类问题时，哪种工具调用序列更有效。

### 6.1 Few-shot 示例库

```python
class ProceduralMemory:
    def __init__(self):
        self.examples = {}  # task_type -> list[Example]

    def retrieve_examples(
        self, task_description: str, top_k: int = 3
    ) -> list[Example]:
        # 根据任务描述检索最相关的示例
        # 示例包含：输入、成功的工具调用序列、最终结果
        ...

    def add_successful_trajectory(
        self, task: str, tool_calls: list[ToolCall], result: str
    ):
        # 把成功的执行轨迹存为新示例
        example = Example(
            task=task,
            trajectory=tool_calls,
            outcome=result,
            timestamp=now()
        )
        self.examples.setdefault(classify_task(task), []).append(example)
```

### 6.2 从执行历史中自动学习

更高级的系统会让 Agent 从自己的成功/失败轨迹中自动提炼程序性记忆：

```
执行记录（raw）：
  任务：查询用户 ID 123 的订单
  步骤 1：call search_orders(user_id=123) → 成功
  步骤 2：call format_response(data=...) → 成功

提炼后的程序性记忆：
  模式：查询特定用户订单
  推荐工具序列：search_orders → format_response
  注意：search_orders 必须传 user_id，不能只传 username
```

---

## 七、存储形式的选型：六种方案的组织、检索与场景

前面六节讲了"记忆里存什么"。这一节讲**用什么存**——不同存储形式的组织方式、检索机制和适用边界。

记忆系统不是"用向量库就完了"。每种存储形式对应不同的数据结构、检索语义和读写成本，错配会严重拖累系统性能和质量。

---

### 7.1 纯文件系统 / Key-Value 存储

**组织方式**：内容以文本文件、JSON、JSONL 存储，按 `user_id/session_id` 组织目录或 key。

```
memory/
  user_alice/
    profile.json          ← 用户画像（偏好、基本信息）
    sessions/
      2026-05-01.jsonl    ← 当天对话历史（每行一条消息）
      2026-05-15.jsonl
    facts.jsonl           ← 提炼过的核心事实
```

**检索方式**：无索引检索——按 key 直接读取，或线性扫描文件内容。需要关键词搜索时用 `grep`，没有语义理解能力。

**读写性能**：写入极快（append-only），精确读取 O(1)，全量扫描 O(N)。

**适用场景**：
- 用户画像（profile）、偏好配置——每次完整读取，不需要检索
- 对话历史的冷存档——长期保存但很少检索
- Agent 的工作日志——只写不读，供调试审计
- 本地单用户工具（不需要扩展性）

**不适合**：需要"找最相关的 N 条"的场景，文件多了之后扫描代价极高。

---

### 7.2 关系型数据库（SQL）

**组织方式**：结构化表，按字段建索引，支持精确条件过滤和聚合。

```sql
CREATE TABLE memories (
    id          UUID PRIMARY KEY,
    user_id     TEXT NOT NULL,
    content     TEXT NOT NULL,
    memory_type TEXT,           -- episodic / semantic / procedural
    importance  TEXT,           -- high / medium / low
    tags        TEXT[],
    created_at  TIMESTAMPTZ,
    accessed_at TIMESTAMPTZ,
    access_count INT DEFAULT 0,
    expires_at  TIMESTAMPTZ
);

CREATE INDEX idx_memories_user ON memories(user_id);
CREATE INDEX idx_memories_type ON memories(user_id, memory_type);
```

**检索方式**：SQL 条件查询。精确匹配、范围过滤、排序都很强。

```sql
-- 查某用户最近 30 天访问过的高重要性记忆
SELECT * FROM memories
WHERE user_id = 'alice'
  AND importance = 'high'
  AND accessed_at > NOW() - INTERVAL '30 days'
ORDER BY accessed_at DESC
LIMIT 20;
```

**适用场景**：
- 记忆的元数据管理（时间、重要性、类型、访问频率）
- 遗忘/清理策略的执行（批量过期、访问频率统计）
- 多用户系统的记忆隔离和权限控制
- 记忆的溯源与审计（谁写的、什么时候写的、被修改过几次）

**不适合**：语义相似度搜索——`LIKE '%asyncio%'` 找不到"并发编程"相关内容。

:::提醒 SQL + 向量库双写是常见的生产架构
实际系统通常把元数据存 SQL（用于精确过滤和生命周期管理），把语义向量存向量库（用于相似度检索）。检索时先用 SQL 过滤出候选集，再做向量相似度排序。两者分工明确。
:::

---

### 7.3 向量数据库

**组织方式**：每条记忆被嵌入模型（Embedding Model）编码成高维浮点向量（通常 1536 维），存储向量 + 原文 + 元数据。检索时把查询也编码成向量，在向量空间里找"最近邻"。

```
记忆："用户不喜欢使用递归"
  → embed() → [0.12, -0.34, 0.89, ..., 0.03]  (1536维)
  → 存入向量库，附带 {user_id, timestamp, importance}

查询："用户对代码风格的偏好"
  → embed() → [0.14, -0.31, 0.85, ..., 0.05]
  → 向量相似度搜索 → 找到最近邻记忆
  → 召回"用户不喜欢使用递归"（语义相关，尽管词面不同）
```

**检索方式**：近似最近邻（ANN）搜索，常用算法：HNSW（高速，内存友好）、IVF（大规模分片）。

**读写性能**：写入需要先做 embedding（100-500ms），向量检索快（毫秒级）。

**适用场景**：
- 情节记忆的相似场景召回（"之前遇到类似问题时怎么处理的"）
- 用户偏好的模糊匹配（"用户喜欢简洁风格" ↔ "用户说过不要冗余代码"）
- 程序性记忆的任务匹配（找最相似的历史成功轨迹）
- RAG 知识库检索

**不适合**：
- 精确 ID 查找——向量库不是 KV 存储，主键查找用 SQL
- 有明确时间范围的过滤——向量相似度不等于时间相关性
- 小数据量场景（< 1000 条）——纯 SQL 线性扫描更简单，不需要引入向量库

---

### 7.4 全文检索（BM25 / Elasticsearch）

**组织方式**：对文本建倒排索引——记录每个词出现在哪些文档里。

```
倒排索引示例：
  "asyncio"  → [doc_12, doc_34, doc_89]
  "并发"     → [doc_3, doc_34, doc_77]
  "gather"   → [doc_12, doc_88]

查询 "asyncio gather" → 交集 → [doc_12]（精确命中）
```

**检索方式**：BM25 打分（词频 + 逆文档频率），支持布尔查询、短语匹配、通配符。

**适用场景**：
- 用户查询包含明确术语（API 名、函数名、错误码）
- 代码库记忆（`NullPointerException`、`redis.get`）
- 精确关键词比语义相似更重要的场景

**局限**：词面匹配，没有语义理解。"python 并发"查不到"asyncio"相关内容（除非有同义词扩展）。

**与向量库的关系**：互补而非替代。生产系统常做 **Hybrid Retrieval**：
```
查询 → BM25 召回 top-N（精确词面）
     + 向量检索 top-N（语义相近）
     → Reranker 混合重排
     → 最终 top-K 结果
```

---

### 7.5 知识图谱（Graph Database）

**组织方式**：实体 + 关系的图结构，存储实体之间的命名关系。

```
(Alice) --[偏好]--> (Python)
(Alice) --[不喜欢]--> (递归写法)
(Alice) --[使用]--> (VSCode)
(VSCode) --[支持]--> (Python)
(项目A) --[使用技术栈]--> (Python)
(Alice) --[负责]--> (项目A)
```

**检索方式**：图遍历查询（Cypher / SPARQL）。

```cypher
// 查询 Alice 用的工具和她负责的项目
MATCH (u:User {name: "Alice"})
OPTIONAL MATCH (u)-[:使用]->(t:Tool)
OPTIONAL MATCH (u)-[:负责]->(p:Project)
RETURN u, collect(t), collect(p)

// 查询 Alice 不喜欢的、但她负责的项目里用到的技术
MATCH (u:User {name: "Alice"})-[:不喜欢]->(tech)
MATCH (u)-[:负责]->(p:Project)-[:使用技术栈]->(tech)
RETURN p, tech
```

**适用场景**：
- 用户与实体之间的复杂关系（"Alice 参与的项目用到了哪些她不喜欢的技术"）
- 多跳推理（"用户的同事用什么工具"）
- 结构化的用户画像（偏好关系网络）
- 知识库里实体间依赖关系（"这个 API 依赖哪些其他 API"）

**不适合**：非结构化文本的语义搜索；写入频繁更新的流式记忆（图结构的写入成本较高）。

---

### 7.6 选型速查表

```
存储形式          组织方式       检索能力              适合存什么
──────────────    ───────────    ──────────────────    ────────────────────────────
文件系统 / KV     按 key 存取    精确 key 查找         用户 profile、对话冷存档
关系型 (SQL)      结构化表       精确过滤、聚合、排序  记忆元数据、生命周期管理
向量数据库        高维向量       语义相似度搜索        情节/程序性记忆的模糊匹配
全文检索          倒排索引       关键词精确匹配        代码库、术语密集的技术记忆
知识图谱          实体-关系图    多跳关系遍历          结构化用户画像、依赖关系
混合方案          以上组合       精确 + 语义           生产系统的主流选择
```

**选型决策树**：

```
需要"找最相似的记忆"？
  是 → 向量数据库（+ 可选 BM25 做混合）
  否 → 需要"按条件过滤 + 排序"？
         是 → 关系型数据库
         否 → 需要"关系图谱推理"？
                是 → 知识图谱
                否 → 文件系统 / KV（最简单）
```

大多数生产级记忆系统的最终答案是：**SQL 管元数据 + 向量库做检索 + 文件系统存原始归档**，三层各司其职。

---

## 八、MemGPT 架构：把 OS 虚拟内存的思想搬到 LLM


MemGPT（2023, Berkeley）是第一个系统性解决 LLM 记忆问题的工作，思路来自操作系统的**虚拟内存**机制。

```
OS 虚拟内存              MemGPT 对应设计
───────────────────      ──────────────────────────────
CPU 寄存器（最快）        当前上下文窗口（工作记忆）
RAM（主存）              核心记忆（core memory）
磁盘（外存）             归档记忆（archival memory）
页置换算法               记忆读写控制器（Memory Manager）
```

### MemGPT 的核心创新：让 LLM 自己管理记忆

传统做法是在 Agent 外部写死记忆逻辑（何时写入、何时检索）。MemGPT 把记忆操作变成**工具**，让 LLM 自己决定：

```python
# MemGPT 给 LLM 提供的记忆工具
tools = [
    {
        "name": "core_memory_append",
        "description": "往核心记忆里追加内容（永久存在于上下文）",
        "parameters": {"content": "string"}
    },
    {
        "name": "core_memory_replace",
        "description": "修改核心记忆里的某条内容",
        "parameters": {"old_content": "string", "new_content": "string"}
    },
    {
        "name": "archival_memory_insert",
        "description": "把内容存入归档记忆（不在上下文，需要时检索）",
        "parameters": {"content": "string"}
    },
    {
        "name": "archival_memory_search",
        "description": "从归档记忆里检索相关内容",
        "parameters": {"query": "string"}
    }
]
```

LLM 在对话中可以这样使用：
```
用户说："我叫 Alice，是前端工程师，不喜欢 jQuery"

LLM 内部决策：这些是重要的用户偏好，应该存入核心记忆
→ call core_memory_append("用户名：Alice，职业：前端工程师，偏好：不使用 jQuery")

用户问："你还记得我的名字吗？"
→ 核心记忆在上下文里，直接回答："你叫 Alice"

用户问："上次我们讨论的技术方案是什么？"
→ call archival_memory_search("技术方案讨论")
→ 检索到结果，插入上下文，再回答
```

:::启发 MemGPT 最重要的洞察：记忆管理本身就是推理
不要用外部启发式规则决定"什么值得记忆"，把这个决策交给 LLM 本身——它比硬编码规则更理解语义重要性。代价是多了工具调用的开销，但质量更高。
:::

---

## 九、记忆的一致性问题

当记忆可以被修改时，一致性问题浮现。

### 8.1 记忆冲突检测

```
用户在第 1 次对话说："我住在上海"
用户在第 10 次对话说："我最近搬到北京了"
```

如果两条记忆都在库里，Agent 可能在不同时候给出矛盾的答案。

处理方案：写入时做冲突检测。

```python
async def store_with_conflict_check(
    content: str,
    memory_store: MemoryStore
) -> str:
    # 检索与新内容语义最近的旧记忆
    candidates = await memory_store.search(content, top_k=5)

    # 用 LLM 判断是否存在冲突
    conflict = await llm_check_conflict(content, candidates)

    if conflict.exists:
        # 软删除旧的（保留时间戳，方便审计），写入新的
        await memory_store.soft_delete(conflict.conflicting_id)
        await memory_store.insert(
            content,
            supersedes=conflict.conflicting_id
        )
    else:
        await memory_store.insert(content)
```

### 8.2 记忆的时效性

不是所有记忆都要永久保留。

```python
class MemoryWithTTL:
    async def store(
        self,
        content: str,
        ttl_days: int | None = None,
        importance: str = "medium"
    ):
        expiry = (
            datetime.utcnow() + timedelta(days=ttl_days)
            if ttl_days else None
        )
        await self.db.insert({
            "content": content,
            "importance": importance,
            "expires_at": expiry,
            "access_count": 0,
            "last_accessed": datetime.utcnow()
        })

    async def cleanup_expired(self):
        # 定期清理过期记忆
        await self.db.delete_where(
            "expires_at IS NOT NULL AND expires_at < NOW()"
        )
```

遗忘策略的常见做法：
- **时间衰减**：超过 N 天未被访问，降低重要性
- **访问频率**：从未被召回的记忆，定期清理
- **显式覆盖**：新信息与旧信息冲突时，旧信息标记为过期

---

## 十、生产工程中的四个陷阱

### 陷阱一：记忆写入的延迟问题

如果每轮对话结束都同步写入向量库，延迟会很高（向量化 + 网络 IO）。

**解法**：异步写入，写入失败有补偿机制。

```python
async def handle_turn(user_message: str) -> str:
    response = await agent.run(user_message)

    # 异步写入记忆，不阻塞响应
    asyncio.create_task(
        memory_store.store_if_important(user_message, response)
    )

    return response
```

### 陷阱二：检索召回的上下文过长

向量检索召回 5 条记忆，每条 500 token，加起来 2500 token——很快就把上下文槽位撑满。

**解法**：召回后做压缩，只保留与当前问题最相关的片段。

```python
async def retrieve_and_compress(
    query: str, top_k: int = 5, max_tokens: int = 800
) -> str:
    memories = await vector_store.search(query, top_k=top_k)
    raw_context = "\n---\n".join(m.content for m in memories)

    if count_tokens(raw_context) <= max_tokens:
        return raw_context

    # 超出预算时，让 LLM 压缩
    return await llm_compress(raw_context, query, max_tokens)
```

### 陷阱三：多用户的记忆隔离

情节记忆必须按用户严格隔离，否则 A 用户的记忆会污染 B 用户的响应。

**解法**：所有记忆存储和检索操作都强制带 `user_id` 过滤。

```python
# 错误：忘记过滤 user_id
results = await vector_store.search(query, top_k=5)

# 正确：总是带用户过滤
results = await vector_store.search(
    query,
    filter={"user_id": current_user_id},
    top_k=5
)
```

建议在 `MemoryStore` 的构造函数里绑定 `user_id`，从接口层面杜绝这类错误。

### 陷阱四：记忆内容的幻觉扩散

LLM 在摘要/提炼记忆时，可能产生轻微的幻觉——把"用户说 A"变成"用户说 A 并且 B"。

幻觉一旦存进记忆，会在后续每次检索时被当成事实使用，越滚越大。

**解法**：
1. 原文存储优先：能存原始文本就别存 LLM 生成的摘要
2. 存时打来源标签（用户原话 vs LLM 提炼），检索时区分对待
3. 关键记忆（用户明确表达的偏好）让用户确认后再写入

---

## 十一、技术选型速查

```
组件                推荐方案
────────────────    ──────────────────────────────────────
向量数据库           Qdrant（本地可部署）/ Pinecone（云托管）
                    / Weaviate（支持混合检索）
嵌入模型             text-embedding-3-small（通用）
                    / BGE-M3（中文效果好）
记忆框架             MemGPT / mem0（开源，可自托管）
混合检索             Weaviate BM25 + Vector Hybrid
                    / Elasticsearch + HNSW
摘要压缩             Claude Haiku / GPT-4o-mini（低成本）
```

---

## 结语

记忆系统的核心矛盾是：**信息的完整性 vs 上下文的有效性**。

存太少，Agent 反复失忆，像个每次见面都不认识你的助手。存太多，检索噪声增大，上下文被无关记忆撑满，反而影响决策质量。

工程上没有银弹——需要根据你的任务周期（单会话 vs 长期关系）、用户规模（个人工具 vs 多租户 SaaS）、延迟要求，选择合适的记忆类型和策略组合。

MemGPT 的思路给了一个方向：**把记忆管理的决策权交还给模型**——让 LLM 自己判断什么值得记、什么该遗忘、什么该检索。随着模型能力的提升，这个方向会越来越有效。

记忆是 Agent 智能的下限。工具能力决定 Agent 能做什么，记忆决定 Agent 能成长为什么。
