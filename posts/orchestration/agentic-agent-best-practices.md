# Agentic Agent 工程最佳实践：从字节、阿里看多步骤智能体的架构演进

:::观点 为什么这篇文章值得读
"Agentic AI"已从研究概念走向大规模生产部署——字节跳动的 Coze 平台每天服务数百万 Agent 任务，阿里的 Qwen-Agent 框架支撑数十个业务线落地。本文系统梳理 Agentic Agent 的核心架构范式（ReAct、PRO、DPRO）、工程化挑战与解法，并从两家公司的公开论文和工程资料中提炼可复用的最佳实践。
:::

---

## 一、从 Chatbot 到 Agentic AI：本质是什么变了

### 1.1 被动响应 vs. 主动规划

普通 Chatbot 是**请求-响应**模型：用户输入一个问题，模型生成一条回复，交互结束。Agentic AI 的核心变化是**目标导向的自主执行**：

| 维度 | Chatbot | Agentic Agent |
|---|---|---|
| 交互模式 | 单轮/多轮对话 | 目标驱动、多步骤执行 |
| 工具使用 | 可选/简单调用 | 核心能力，动态选择 |
| 状态管理 | 无状态或短期上下文 | 持久记忆、任务状态机 |
| 错误处理 | 无法重试 | 可观测、可恢复、可回滚 |
| 规划能力 | 无 | 任务分解、依赖分析、优先级排序 |
| 人类参与 | 每轮必须 | 审批节点可配置（HITL） |

### 1.2 什么让 Agent 变得"Agentic"

Agentic AI 不是一个技术点，而是四个能力同时在线：

```
感知（Perception）
  ↓ 读取环境：文件系统 / API / 数据库 / 截图 / 代码
规划（Planning）
  ↓ 分解目标 → 生成步骤序列 → 分析依赖关系
执行（Execution）
  ↓ 调用工具 / 执行代码 / 写文件 / 访问网络
反思（Reflection）
  ↓ 验证结果 → 检测偏差 → 决定是否重规划
```

只有感知没有规划，是搜索引擎；只有执行没有反思，是脚本；四者协同，才是 Agent。

---

## 二、核心架构范式

### 2.1 ReAct：奠基范式

**ReAct**（Reasoning + Acting）是 Agentic AI 的理论基础。由普林斯顿 / Google 在 2022 年提出，核心思想是让模型在 Thought → Action → Observation 之间交替，形成可追踪的推理链。

```
Thought: 我需要查询当前比特币价格
Action: search("bitcoin current price")
Observation: Bitcoin is $67,420 as of 2026-06-10
Thought: 已获得价格，可以回答用户
Action: finish("当前比特币价格约为 $67,420")
```

**优势**：推理过程可读、可调试、可干预。  
**局限**：无全局规划，容易陷入局部循环；对复杂多步任务缺乏全局视角。

### 2.2 Plan-and-Execute：规划与执行分离

为解决 ReAct 缺乏全局规划的问题，**Plan-and-Execute** 将任务拆成两个阶段：

```
[Planner LLM]  →  生成步骤序列（Step 1, 2, 3...）
       ↓
[Executor LLM] →  逐步执行，每步回报 Observation
       ↓
[Planner LLM]  →  根据执行结果决定是否重规划
```

代表实现：LangChain 的 `PlanAndExecute`、字节跳动的 OpenAgents 内部调度器。

**优势**：全局视角，步骤可并行，Planner 和 Executor 可用不同模型（降低成本）。  
**局限**：规划阶段的质量瓶颈决定整体上限，初始计划错误会级联。

### 2.3 Reflexion：语言强化学习

**Reflexion**（2023，Shinn et al.）让 Agent 在失败后对轨迹做语言层面的"事后复盘"，并将反思结果写入长期记忆，影响下一次尝试：

```
尝试 1 → 失败 → Reflect("我在步骤2误解了API格式")
             ↓ 写入 Episodic Memory
尝试 2 → 调用 Recall Memory → 避免同样错误
```

在 HotpotQA、AlfWorld 等基准上，Reflexion 让单模型性能提升 20%+，无需微调。

---

## 三、PRO 范式：Plan → React → Observe

PRO 是对 ReAct 的结构化增强，在字节跳动、阿里系生产 Agent 系统中均有体现。它将 Agent Loop 明确拆成三个**有边界的阶段**，每阶段有独立的输入/输出契约：

### 3.1 三个阶段详解

```
┌──────────────────────────────────────────────────────┐
│                    PRO Loop                          │
│                                                      │
│  ┌──────────┐   ┌──────────┐   ┌──────────────────┐ │
│  │  PLAN    │──▶│  REACT   │──▶│    OBSERVE       │ │
│  │ 生成子目标│   │ 选择工具 │   │ 更新状态 / 决策  │ │
│  │ 排序依赖 │   │ 执行动作 │   │ → 继续 / 重规划  │ │
│  └──────────┘   └──────────┘   └──────────────────┘ │
│        ▲                               │             │
│        └───────── replan ─────────────┘             │
└──────────────────────────────────────────────────────┘
```

**PLAN 阶段**（输入：当前目标 + 历史状态 → 输出：下一个子目标 + 执行参数）

- 模型显式推理"下一步是什么"，而非直接选工具
- 输出结构化的子目标（JSON schema 约束），便于下游工具解析
- 如果历史状态显示前步失败，在此阶段触发重规划

**REACT 阶段**（输入：子目标 → 输出：工具调用 + 执行结果）

- 将子目标映射到具体工具（search / code_exec / file_write…）
- 参数生成、工具调用、异常捕获都在此阶段完成
- 严格限制：单次 REACT 只允许调用一个原子工具（避免副作用叠加）

**OBSERVE 阶段**（输入：执行结果 → 输出：状态更新 + 决策信号）

- 将 raw 工具输出压缩成结构化 Observation（避免塞爆上下文）
- 做三类判断：`done`（任务完成）/ `continue`（进入下轮 PLAN）/ `replan`（子目标失败，回到 PLAN 重规划）
- 记录置信度分数，用于后续 HITL 决策

### 3.2 PRO vs. ReAct 的关键差异

| 差异点 | ReAct | PRO |
|---|---|---|
| 规划粒度 | 隐含在 Thought 里 | 显式 PLAN 阶段，结构化输出 |
| 工具调用 | 随 Thought 流式决策 | 在 REACT 阶段，有参数 schema 约束 |
| 观测处理 | Observation 直接进上下文 | OBSERVE 阶段压缩 + 结构化 |
| 重规划触发 | 无明确机制 | OBSERVE 输出 `replan` 信号 |
| 可观测性 | 难以追踪各阶段边界 | 三阶段边界清晰，可 per-stage tracing |

---

## 四、DPRO 范式：Decompose → Plan → React → Observe

对于**长链复杂任务**（如：分析一个代码仓库并输出重构方案，或调研竞品并生成报告），PRO 的单层循环仍不足——任务分解本身就需要一个独立阶段。DPRO 在 PRO 外层增加了 **DECOMPOSE** 阶段，形成两层嵌套结构：

### 4.1 两层结构

```
DECOMPOSE（外层，一次执行）
  ├── 将复杂任务拆解为 N 个独立子任务
  ├── 分析子任务间依赖（生成 DAG）
  └── 决定串行 / 并行执行策略

    ↓ 对每个子任务，执行 PRO 内层循环

  PRO Loop（内层，每子任务一次）
    → PLAN → REACT → OBSERVE → [重循环或结束]

MERGE（外层，汇总）
  └── 聚合各子任务输出，生成最终答案
```

### 4.2 DECOMPOSE 阶段的工程要点

```
[复杂任务描述]
    ↓
Decomposer LLM（提示词包含 DAG 输出格式约束）
    ↓
{
  "subtasks": [
    {"id": "T1", "desc": "搜集竞品A数据", "deps": []},
    {"id": "T2", "desc": "搜集竞品B数据", "deps": []},
    {"id": "T3", "desc": "对比分析", "deps": ["T1", "T2"]},
    {"id": "T4", "desc": "撰写报告", "deps": ["T3"]}
  ]
}
```

关键点：
- T1、T2 无依赖 → **并行执行**，节省时间
- T3 依赖 T1+T2 → 等两者完成后触发
- T4 依赖 T3 → 串行末尾

### 4.3 DPRO 适用场景

| 场景 | 为何用 DPRO |
|---|---|
| 代码仓库分析 | 需先扫描文件结构、再分析各模块、再综合 |
| 竞品/市场调研 | 多数据源并发采集 + 汇总分析 |
| 多表单 / 多文档处理 | 并行抽取 + 合并校验 |
| 软件自动化测试 | 用例分组并发执行 + 结果聚合 |

:::方法 DPRO 的两个扩展变体
**D-PRO-H**（Human-in-the-Loop）：在 DECOMPOSE 后加一个人工审批节点，确认子任务划分是否合理，再启动内层 PRO。适合高风险任务（金融操作、删除类操作）。  
**D-PRO-M**（Multi-Agent）：每个子任务分配给不同的专用 Agent 并行执行，主 Agent 只负责 DECOMPOSE 和最后的 MERGE。适合资源充足、子任务间完全独立的场景。
:::

---

## 五、字节跳动的 Agentic AI 实践

### 5.1 AgentBench：系统性 Agent 评测框架

字节跳动与清华大学联合发布的 **AgentBench**（ICLR 2024）是首个系统性评测 LLM 作为 Agent 能力的基准，覆盖 8 类真实环境：

| 环境类型 | 任务示例 | 核心考察维度 |
|---|---|---|
| OS（操作系统） | bash 命令执行、文件管理 | 工具调用精度、多步规划 |
| DB（数据库） | SQL 查询、数据分析 | 结构化推理 |
| KG（知识图谱） | 多跳推理 | 关系推断 |
| Web Shopping | 电商搜索+下单 | 网页理解、流程规划 |
| Web Browsing | 通用网页任务 | 长链执行 |
| Card Games | 策略对弈 | 博弈推理 |
| Lateral Thinking | 逻辑谜题 | 创造性推理 |
| House Holding | 家居任务模拟 | 具身规划 |

**核心发现**：GPT-4 在大多数环境下领先，但**开源模型与商业模型的 Agent 能力差距远大于纯语言任务**（差距从 QA 的 20% 扩大到 Agent 任务的 50%+）。这说明 Agent 能力需要专项训练，不是 Chat 能力的自然迁移。

:::提醒 AgentBench 的工程启示
**动态环境 > 静态评测**：Agent 性能在静态 benchmark 上的好坏无法直接预测真实部署效果，必须用贴近生产的动态环境（真实工具、真实错误）做评测。字节在生产中配套了"影子模式"（shadow mode）——新 Agent 与老 Agent 同时跑，对比轨迹差异，作为上线前最后验收。
:::

### 5.2 AgentTuning：让 LLM 具备跨场景 Agent 能力

**AgentTuning**（2023，字节 + 清华）的核心洞察：用少量高质量 Agent 轨迹做 SFT（监督微调），可以大幅提升模型的 Agent 能力，同时**不损害通用语言能力**。

关键结论：
- **1820 条精选 Agent 轨迹**（来自 AgentBench 6 个任务）即可让 LLaMA-2-70B 的 Agent 成功率提升约 3 倍
- 混合训练（Agent 数据 + 通用对话数据）比纯 Agent 数据训练更稳定
- **轨迹质量 >> 轨迹数量**：选 GPT-4 生成的高质量轨迹比大量 GPT-3.5 轨迹效果好

工程含义：企业如果需要内部部署专用 Agent 模型，不需要从头训练——用生产环境产生的高质量执行轨迹做 SFT，可以快速提升特定场景的 Agent 能力。

### 5.3 OpenAgents：三类 Agent 并行架构

字节跳动研究院的 **OpenAgents**（2023）将面向真实用户的 Agent 分为三类，并给出可部署的参考实现：

```
OpenAgents
  ├── DataAgent  — 数据分析（Python / SQL 执行环境）
  ├── PluginsAgent — 工具调用（200+ 插件，类 ChatGPT Plugins）
  └── WebAgent   — 网页任务（真实浏览器，Playwright 驱动）
```

架构亮点：
- **统一的任务分发层**：根据用户意图路由到对应 Agent，支持跨 Agent 协作
- **持久化工具状态**：DataAgent 的 Python 环境在会话内保持，变量可复用
- **结构化错误恢复**：工具调用失败后，自动触发"错误分析 → 修正参数 → 重试"三步流程（标准 PRO OBSERVE 阶段的产品化实现）

### 5.4 Coze 平台的生产工程经验

字节跳动的 Coze Agent 平台（2024 年开放）在工程上有几点值得关注的设计：

**工作流（Workflow）vs. 自主模式（Autonomous）**

Coze 提供两种执行模式：结构化工作流（DAG 图，工程师画流程）和 LLM 自主模式（让模型自己规划步骤）。生产经验：
- **确定性强的任务**（表单填写、数据提取）→ Workflow，稳定可控
- **探索性任务**（调研、问答）→ Autonomous，灵活但需配置 Max Steps 上限

**插件系统的幂等设计**

Coze 要求所有外部插件遵循幂等约束：相同输入多次调用结果一致。这是为了支持 Agent 在失败后安全重试，而不产生副作用（如重复提交表单、重复扣款）。

**Token 预算控制**

每个 Agent 任务可配置 Token Budget，超出后强制触发 `summarize_and_stop`，而非直接截断——确保输出有完整结论而非半截内容。

---

## 六、阿里巴巴的 Agentic AI 实践

### 6.1 Qwen-Agent：模型原生的 Agent 框架

阿里的 **Qwen-Agent** 是专为 Qwen 系列模型设计的 Agent 框架，与模型训练联动，在工具调用和代码执行上做了深度优化：

**核心设计原则**：

1. **Function Calling 原生支持**：Qwen2.5 在后训练阶段专门加入了 Function Calling 轨迹，模型对工具 schema 的理解和参数生成精度高于通用微调模型
2. **Code Interpreter 优先**：对于数据分析、数学计算类任务，优先用代码解释器（Python sandbox）而非自然语言推理，因为代码执行结果可验证
3. **ReAct + 结构化 Thought**：在 Thought 阶段要求模型输出结构化的推理（包括：目标 / 当前状态 / 选择工具的理由），而非自由文本，提升可追踪性

**记忆系统**：Qwen-Agent 的记忆分三层：
- `System Memory`：Agent 人设、能力描述（注入 System Prompt）
- `Conversation Memory`：当前会话历史（滑动窗口 + 摘要压缩）
- `External Memory`：向量库（RAG），按需检索

### 6.2 ToolBench / ToolLLM：工具学习基准

清华大学与阿里 ModelScope 联合的 **ToolBench**（2023）构建了迄今最大的工具学习基准，包含：
- **16000+ 个真实 API**（来自 RapidAPI）
- **49000+ 条工具调用轨迹**（DFSDT 算法生成）
- **ToolEval**：评测工具选择精度和解题成功率的标准化流程

**DFSDT（Depth First Search-based Decision Tree）** 是 ToolBench 的核心算法：将 Agent 的工具调用路径建模为决策树，用深度优先搜索（DFS）探索可行路径，同时允许回溯——这本质上是一种 DPRO 的采样策略。

:::启发 ToolBench 对工程师的启示
工具泛化能力是 Agentic AI 的核心瓶颈之一。模型在训练集内的工具上表现好，但遇到新 API（不同参数结构、不同错误码）时会显著退化。解决方向：一是让模型学习"工具文档阅读能力"（few-shot API doc → 调用），二是在 PLAN 阶段加入工具可用性预检（先验证 schema，再调用）。
:::

### 6.3 OS-Copilot：系统级 Agent

上海交通大学与阿里合作的 **OS-Copilot** 将 Agent 能力扩展到操作系统层面：

```
用户指令
    ↓
OS-Copilot（Planner）
    ├── Bash 工具（终端命令）
    ├── Python 解释器
    ├── 文件系统 API
    └── Web 搜索
```

关键技术：**自进化工具库**——Agent 在执行任务时发现可复用的操作序列，自动提炼为新工具存入工具库，供后续任务调用。这是一种生产级的 skill 积累机制。

### 6.4 阿里 DashScope Agent API 的工程取舍

阿里 DashScope 的 Agent API 在设计上做了几个有意思的工程取舍：

- **流式输出优先**：Agent 的中间思考过程实时流式返回，用户看到"正在搜索..."、"正在分析..."，而非等待黑盒完成，显著提升体验
- **工具调用并行**：支持单次推理返回多个工具调用（Parallel Tool Calling），由客户端并行执行后统一回传，减少 RTT
- **最大轮次限制**：强制设置 `max_iterations`（默认 10），防止 Agent 陷入无限循环导致成本失控

---

## 七、多 Agent 协作模式

单 Agent 的能力上限受限于上下文窗口和专注度，复杂任务需要多 Agent 协作。常见三种模式：

### 7.1 主从模式（Orchestrator-Worker）

```
Orchestrator（主 Agent）
  ├── 分解任务 → 分发给 Worker
  ├── 汇总 Worker 结果
  └── 做最终决策

Worker Agent（专用）
  ├── ResearchAgent（搜索 + 总结）
  ├── CodeAgent（写代码 + 执行）
  └── WriterAgent（内容生成）
```

代表框架：AutoGen（微软）、Manus、字节 Coze 的 Multi-Agent 工作流。

**优点**：职责清晰，Worker 可专门优化；主 Agent 保持全局视野。  
**缺点**：Orchestrator 是单点瓶颈；Worker 失败需要 Orchestrator 感知并恢复。

### 7.2 专家路由（Expert Routing）

```
Router（意图分类）
  ├── 问题类型 A → ExpertAgent-A
  ├── 问题类型 B → ExpertAgent-B
  └── 问题类型 C → ExpertAgent-C
```

适合：知识领域明确分割的场景（法律 / 财务 / 技术支持）。  
工程要点：Router 的分类精度决定系统整体准确率；需要维护一套"边界模糊场景"的路由测试集。

### 7.3 对等协作（Peer-to-Peer / Debate）

多个同级 Agent 对同一任务独立生成答案，再通过辩论（Debate）或投票（Voting）收敛到最优解。

```
Agent-1: 分析 → "答案是 A"
Agent-2: 分析 → "答案是 B"
Agent-3: 分析 → "答案是 A"
           ↓
Aggregator: 多数投票 → "答案是 A"（或让第4个Agent做裁判）
```

实验结果（Du et al., 2023）：Debate 策略在数学推理和常识问答上比单 Agent 平均提升 5-15%，但成本是 3×。

---

## 八、工程化挑战与解法

### 8.1 幻觉与错误传播

**问题**：Agent 在第 3 步产生幻觉（错误的中间结论），第 4、5、6 步全部基于错误前提，且因果链难以追溯。

**解法**：
- **结构化中间输出**：强制每步输出 JSON，而非自然语言，便于后续步骤解析和验证
- **自检（Self-Verification）**：在关键节点插入"验证子任务"（"验证上一步的输出是否符合预期格式"）
- **Grounding 工具**：对数值/事实类内容，强制通过工具查询而非模型记忆

### 8.2 工具调用稳定性

**问题**：LLM 生成的工具参数不符合 schema；工具超时或返回非预期格式。

**解法**：
```
工具调用三层防护：
1. Schema 验证层：Pydantic / JSON Schema 校验参数，失败→ 重新生成（最多3次）
2. 超时与重试：工具调用设置 timeout（5-30s），失败→ 返回结构化错误信息给 LLM
3. 降级策略：工具不可用时，提供 fallback（如：搜索 API 失败 → 用模型知识回答，并标注"来自模型记忆，可能不准确"）
```

### 8.3 长链任务的成本控制

**问题**：Agent 执行 20+ 步的任务，每步都携带完整历史，Token 成本指数级增长。

**解法**：
- **渐进式上下文压缩**：每 N 步执行一次"摘要压缩"，保留关键状态，丢弃冗余对话历史
- **工具结果截断**：搜索/爬虫等工具返回大量文本时，先做 summarize 再进上下文（字节的 OpenAgents 和阿里 Qwen-Agent 均采用此策略）
- **Token Budget Enforcement**：硬性限制每个 Agent 会话的最大 Token 数，触发后强制生成"中间总结 + 下一步建议"

### 8.4 人机协作（HITL）节点设计

完全自主 Agent 在高风险场景下不可接受（删除数据、发送邮件、执行支付）。HITL 设计原则：

```
低风险操作（只读）     → 自动执行
中风险操作（写/修改）  → 展示计划 + 用户一键确认
高风险操作（删除/支付）→ 强制人工审批 + 二次确认 + 审计日志
不可逆操作             → 先在 sandbox 演练，确认后执行
```

:::提醒 "自主性"与"可控性"的工程平衡点
字节 Coze 和阿里 DashScope 的生产经验都指向同一结论：**企业客户最终愿意部署的 Agent，不是"最自主"的，而是"最可控"的**。可观测（每步可追踪）、可中断（任意步可暂停）、可回滚（失败可恢复）是企业采购的核心标准，而非任务完成率。
:::

---

## 九、评测体系：如何衡量 Agentic Agent 的好坏

| 评测维度 | 指标 | 工具/基准 |
|---|---|---|
| 任务完成率 | Success Rate（端到端） | AgentBench, SWE-bench, GAIA |
| 规划质量 | Plan Precision（步骤无冗余） | 人工标注 / LLM-as-Judge |
| 工具调用精度 | Tool Call Accuracy | ToolBench ToolEval |
| 轨迹效率 | Steps to Solution（越少越好） | AgentBench |
| 错误恢复能力 | Recovery Rate（失败后能继续） | τ-bench |
| 成本效率 | Token / Task | 自定义监控 |
| 幻觉率 | Factual Error Rate（中间步骤） | TruthfulQA + 工具验证 |

**生产环境补充指标**（离线基准测不到的）：
- **P99 延迟**：长尾任务卡死频率
- **Loop 检测率**：Agent 陷入重复循环被检测和中断的比例
- **HITL 触发率**：高风险操作的人工介入频率（过高 = Agent 能力不足，过低 = 风控可能缺失）

---

## 十、总结：选型建议

```
单步问答 / RAG 检索          → Chatbot，不需要 Agent
固定流程自动化（表单/报告）  → Workflow（Coze / n8n / Dify DAG 模式）
探索性多步任务               → PRO（单层 Agent Loop + ReAct 增强）
复杂并行任务 / 多源采集       → DPRO（外层分解 + 内层 PRO）
多领域协作 / 大型系统         → Multi-Agent（Orchestrator-Worker）
高风险 / 合规场景             → 任意范式 + 强 HITL + 审计日志
```

Agentic AI 的工程核心不是"让模型更聪明"，而是**让系统更可控、更可观测、更容易在失败时恢复**。字节和阿里的实践都印证了同一点：生产中跑得通的 Agent，往往是那些在设计时就预留了"人工接管出口"的系统。

---

## 参考文献

1. Yao, S. et al. (2022). **ReAct: Synergizing Reasoning and Acting in Language Models**. *ICLR 2023*. https://arxiv.org/abs/2210.03629

2. Shinn, N. et al. (2023). **Reflexion: Language Agents with Verbal Reinforcement Learning**. *NeurIPS 2023*. https://arxiv.org/abs/2303.11366

3. Liu, X. et al. (2023). **AgentBench: Evaluating LLMs as Agents**. *ICLR 2024*. ByteDance + Tsinghua. https://arxiv.org/abs/2308.03688

4. Zeng, A. et al. (2023). **AgentTuning: Enabling Generalized Agent Abilities for LLMs**. ByteDance + Tsinghua. https://arxiv.org/abs/2310.12823

5. Xie, T. et al. (2023). **OpenAgents: An Open Platform for Language Agents in the Wild**. ByteDance Research. https://arxiv.org/abs/2310.10634

6. Qwen Team, Alibaba. (2024). **Qwen-Agent: Tool Use, RAG, Human-Computer Interaction, and Multi-Agent based on Qwen**. https://github.com/QwenLM/Qwen-Agent

7. Qin, Y. et al. (2023). **ToolLLM: Facilitating Large Language Models to Master 16000+ Real-world APIs**. Tsinghua + Alibaba ModelScope. https://arxiv.org/abs/2307.16789

8. Wang, G. et al. (2024). **OS-Copilot: Towards Generalist Computer Agents with Self-Improvement**. SJTU + Alibaba. https://arxiv.org/abs/2402.07456

9. Wang, L. et al. (2023). **Plan-and-Solve Prompting: Improving Zero-Shot Chain-of-Thought Reasoning by Large Language Models**. https://arxiv.org/abs/2305.04091

10. Hong, S. et al. (2023). **MetaGPT: Meta Programming for A Multi-Agent Collaborative Framework**. https://arxiv.org/abs/2308.00352

11. Wu, Q. et al. (2023). **AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent Conversation**. *Microsoft Research*. https://arxiv.org/abs/2308.08155

12. Yao, S. et al. (2023). **Tree of Thoughts: Deliberate Problem Solving with Large Language Models**. https://arxiv.org/abs/2305.10601

13. Du, Y. et al. (2023). **Improving Factuality and Reasoning in Language Models through Multiagent Debate**. https://arxiv.org/abs/2305.14325

14. Sumers, T. et al. (2023). **Cognitive Architectures for Language Agents**. *Princeton / Google DeepMind*. https://arxiv.org/abs/2309.02427

15. Wang, L. et al. (2024). **A Survey on Large Language Model based Autonomous Agents**. *Renmin University*. https://arxiv.org/abs/2308.11432

16. Karpas, E. et al. (2022). **MRKL Systems: A modular, neuro-symbolic architecture that combines large language models, external knowledge sources and discrete reasoning**. *AI21 Labs*. https://arxiv.org/abs/2205.00445
