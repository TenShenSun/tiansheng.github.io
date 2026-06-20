# Agent 应用架构：从 Chatbot 到自主智能体

对话即产品。

这句话成立的背景，是过去五年里"对话产品"这个品类经历了三次质变：从只会背课文的 FAQ Bot，到能检索知识库的 RAG 助手，再到能规划、用工具、自主完成任务的 Agent。

每次跃迁背后，都是架构的彻底重写。

本文做三件事：梳理三代架构的技术核心，剖析 ChatGPT、Claude、通义千问、Gemini、豆包、Amazon Q 六款头部产品的实现路径，最后给出一张架构选型的决策框架。

---

## 一、三代对话产品：演进路径全览

```
第一代（~2015-2020）：FAQ Bot
  规则 + 关键词匹配 → 固定答案
  核心技术：FSM、槽位填充、意图分类
  极限：只能处理预定义问题

第二代（~2020-2023）：RAG 助手
  LLM + 知识库检索 → 生成回答
  核心技术：向量检索、Embedding、Prompt 工程
  极限：只能"查"，不能"做"

第三代（2023-今）：自主 Agent
  LLM + 工具 + 规划 → 执行任务
  核心技术：Function Calling、ReAct 循环、多 Agent 协作
  极限：仍在探索中
```

三代之间并非替代关系。今天大量生产系统是三代混用：高频标准问题走规则、知识检索走 RAG、复杂任务走 Agent。

---

## 二、第一代：FAQ Bot 的技术核心

### 2.1 有限状态机（FSM）架构

第一代 Chatbot 的骨架是有限状态机：

```
States:  GREETING → INTENT_DETECTED → SLOT_FILLING → CONFIRM → RESPONSE → END
                            ↑                ↓
                       FALLBACK ←───────────────────────
```

每个状态对应一组规则：检测到关键词"退款"就跳转到 `REFUND_FLOW`，填完订单号槽位就跳转到 `CONFIRM`。

**工程实现**（简化）：

```python
class FAQBot:
    def __init__(self, intent_rules: dict, templates: dict):
        self.state = "GREETING"
        self.slots = {}
        self.rules = intent_rules      # {"退款": "REFUND_FLOW", ...}
        self.templates = templates     # {"REFUND_FLOW": "您的订单 {order_id} ..."}

    def reply(self, user_input: str) -> str:
        intent = self._match_intent(user_input)

        if intent == "REFUND_FLOW":
            if "order_id" not in self.slots:
                return "请提供您的订单号"
            return self.templates["REFUND_FLOW"].format(**self.slots)

        return "抱歉，我没有理解您的问题，请重新描述"

    def _match_intent(self, text: str) -> str | None:
        for keyword, intent in self.rules.items():
            if keyword in text:
                return intent
        return None
```

### 2.2 第一代的能力边界

**能做**：
- 处理高频、标准化的问题（物流查询、密码重置、产品价格）
- 语言无关（只要改词典）
- 可解释、可审计、可控

**不能做**：
- 语言变体（"退款"能识别，"钱打回来"就不行了）
- 开放域问题（没见过的问题直接 fallback）
- 多轮推理（每轮对话几乎无记忆）

:::观点 规则系统没有被 LLM 完全替代
阿里云 2024 年的工程博客指出，在高频、强监管、低延迟的客服场景（如金融、医疗），规则系统仍然是第一道防线——可解释性和强一致性是 LLM 目前难以替代的优势 **[1]**。
:::

---

## 三、第二代：RAG 助手架构

### 3.1 为什么需要 RAG

LLM 解决了"理解自然语言"的问题，但带来两个新问题：
1. **知识截止**：模型不知道最新产品手册、内部文档
2. **幻觉**：在无法确定时，LLM 倾向于生成听起来合理但不准确的内容

Lewis 等人在 NeurIPS 2020 提出 RAG（Retrieval-Augmented Generation），本质是给 LLM 外挂一个"开卷考试"能力：不要求模型背会所有知识，而是在回答时实时检索相关内容 **[2]**。

### 3.2 RAG 架构全图

```
                        ┌────────────────────────────┐
                        │         离线阶段             │
                        │  文档 → 切块 → Embedding    │
                        │       → 写入向量库           │
                        └────────────┬───────────────┘
                                     │
用户输入                              ▼
   │          ┌──────────────────────────────────────┐
   │          │            在线阶段（每次请求）         │
   ▼          │                                      │
Query ──────▶ Retriever ──▶ 召回 Top-K 文档           │
              │                    │                 │
              │              Reranker（可选）          │
              │                    │                 │
              │              构建 Prompt              │
              │       ┌────────────┴──────────┐      │
              │       │  System + Docs + Query │      │
              │       └────────────┬──────────┘      │
              │                    ▼                 │
              │                   LLM               │
              │                    │                 │
              └──────────────── 回答 ◀───────────────┘
                                   │
                              带引用的回答
```

### 3.3 Retriever：检索模块的工程细节

**两种主要检索方式**：

```python
# 方式一：密集检索（Dense Retrieval）——语义相似
query_vector = embed_model.encode(query)
results = vector_db.search(query_vector, top_k=10)

# 方式二：稀疏检索（BM25）——关键词精确匹配
results = bm25_index.search(query, top_k=10)

# 实际生产：混合检索
hybrid_results = reciprocal_rank_fusion(
    dense_results, bm25_results
)
```

:::方法 混合检索是生产标配
Google 在 "Agents" 白皮书（2024）中指出，单一检索方式在生产环境中往往不足，混合检索（Dense + BM25 + Metadata Filtering）能显著提升召回率和精确率 **[3]**。Weaviate、Elasticsearch 7.x+ 均已内置混合检索支持。
:::

### 3.4 Prompt 构建：RAG 的上下文组织

```python
def build_rag_prompt(
    query: str,
    retrieved_docs: list[str],
    system_prompt: str
) -> list[dict]:
    context = "\n\n---\n\n".join(
        f"[文档 {i+1}]\n{doc}"
        for i, doc in enumerate(retrieved_docs)
    )

    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": (
            f"以下是相关参考资料：\n\n{context}\n\n"
            f"请根据以上资料回答：{query}\n"
            f"如果资料中没有相关信息，请直接说明，不要臆测。"
        )}
    ]
```

:::提醒 文档放中间是典型陷阱
Transformer 的注意力分布是 U 形：开头和结尾区域注意力更强，中间弱（"Lost in the Middle"，Liu et al. 2023）。把最关键的文档放在 prompt 的最后，而非堆在中间，可以明显提升答案质量。
:::

### 3.5 第二代的能力边界

**能做**：
- 基于私有知识库回答问题（产品手册、内部文档、FAQ）
- 带引用的可溯源回答
- 处理超出训练数据截止日期的内容

**不能做**：
- 主动触发外部操作（发邮件、改数据库）
- 跨系统的多步骤任务（查库存 → 下单 → 通知物流）
- 需要规划和决策的复杂任务

---

## 四、第三代：自主 Agent 架构

### 4.1 什么让 Agent 成为 Agent

Agent 和 RAG 助手的核心区别不是"更聪明"，而是**有行动能力**。

Anthropic 在 "Building effective agents"（2024）中定义 **[4]**：

> "Agents are systems where LLMs dynamically direct their own processes and tool usage, maintaining control over how they accomplish tasks."

三个关键词：
- **动态决策**（dynamically direct）：不是走固定流程，而是根据情况决定下一步
- **工具使用**（tool usage）：能调用外部系统（API、数据库、代码执行器）
- **自主控制**（maintaining control）：自己决定何时停止

### 4.2 Agent Loop：核心执行机制

Agent 的核心是一个循环，直到任务完成或超出预算：

```
┌─────────────────────────────────────────────────────┐
│                    Agent Loop                        │
│                                                     │
│  用户任务                                            │
│     ↓                                               │
│  ┌──────────────────────────────────────────────┐   │
│  │  LLM 推理：分析当前状态，决定下一步行动         │   │
│  └──────────────────┬───────────────────────────┘   │
│                     │                               │
│           ┌─────────▼──────────┐                   │
│           │  需要工具调用？      │                   │
│           └─────────┬──────────┘                   │
│                Yes  │  No                          │
│                     │   └──▶ 直接生成最终回答 → END  │
│                     ▼                               │
│           ┌──────────────────┐                     │
│           │  执行工具         │                     │
│           │  (search/code/   │                     │
│           │   api/browser)   │                     │
│           └─────────┬────────┘                     │
│                     │                               │
│           观察工具结果，更新上下文                    │
│                     │                               │
│                     └──── 回到推理步骤 ◀─────────────┘
└─────────────────────────────────────────────────────┘
```

这个循环就是 **ReAct 范式**（Reasoning + Acting）——Yao 等人在 ICLR 2023 提出 **[5]**：每一步先推理（Thought），再行动（Action），再观察（Observation），循环直到任务完成。

### 4.3 工具调用：OpenAI Function Calling 的工程实现

工具调用是 Agent 能力的地基。OpenAI GPT-4 Technical Report（2023）**[6]** 描述了 Function Calling 的接口设计，目前已成为行业标准：

```python
import openai

tools = [
    {
        "type": "function",
        "function": {
            "name": "search_orders",
            "description": "查询用户的历史订单",
            "parameters": {
                "type": "object",
                "properties": {
                    "user_id": {"type": "string", "description": "用户 ID"},
                    "status": {
                        "type": "string",
                        "enum": ["pending", "shipped", "delivered"],
                        "description": "订单状态过滤"
                    }
                },
                "required": ["user_id"]
            }
        }
    }
]

response = openai.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "查一下我最近的待发货订单"}],
    tools=tools
)

# 如果模型决定调用工具
if response.choices[0].message.tool_calls:
    tool_call = response.choices[0].message.tool_calls[0]
    # tool_call.function.name == "search_orders"
    # tool_call.function.arguments == '{"user_id": "u123", "status": "pending"}'
```

### 4.4 AWS Bedrock Agents：企业级 Agent 的参考实现

AWS Bedrock Agents **[7]** 提供了一套完整的企业级 Agent 构建框架，其架构揭示了生产级 Agent 的标准组件：

```
┌─────────────────────────────────────────────┐
│              Amazon Bedrock Agent            │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │         Orchestration Engine         │    │
│  │  • Pre-processing（输入验证/分类）    │    │
│  │  • Orchestration（推理 + 工具选择）  │    │
│  │  • Post-processing（输出格式化）     │    │
│  └──────────────┬──────────────────────┘    │
│                 │                           │
│       ┌─────────┼──────────┐               │
│       ▼         ▼          ▼               │
│  Action     Knowledge   Memory             │
│  Groups     Bases        Store             │
│  (工具集)   (知识库)     (会话历史)          │
└─────────────────────────────────────────────┘
```

AWS 的设计明确分离了三个关注点：执行能力（Action Groups）、知识检索（Knowledge Bases）、状态保持（Memory Store）——这个三分法是理解所有生产级 Agent 架构的基础。

### 4.5 状态管理：三代系统的核心差异

```
第一代 FAQ Bot
  状态：FSM 状态 + 槽位值
  生命周期：单次请求内
  存储：内存

第二代 RAG 助手
  状态：对话历史（message list）
  生命周期：单次会话（session）
  存储：session cache（Redis）

第三代 Agent
  状态：任务状态 + 中间步骤 + 工具调用记录 + 长期记忆
  生命周期：跨会话（可以是天、周）
  存储：持久化 DB + 向量库
```

Agent 状态机比前两代复杂一个数量级：

```python
from enum import Enum

class AgentTaskStatus(Enum):
    PENDING     = "pending"      # 任务等待执行
    PLANNING    = "planning"     # LLM 正在规划步骤
    EXECUTING   = "executing"    # 正在执行工具调用
    WAITING     = "waiting"      # 等待外部 IO
    PAUSED      = "paused"       # 被用户暂停，等待确认
    COMPLETED   = "completed"    # 任务完成
    FAILED      = "failed"       # 不可恢复的失败
    INTERRUPTED = "interrupted"  # 超出预算/安全中断

class AgentTask:
    task_id: str
    status: AgentTaskStatus
    user_goal: str                  # 原始用户意图
    plan: list[str]                 # LLM 生成的执行计划
    steps_completed: list[StepLog]  # 已完成步骤的日志
    tool_calls: list[ToolCallLog]   # 工具调用记录
    context_window: list[Message]   # 当前上下文
    total_tokens_used: int          # token 预算追踪
    created_at: datetime
    updated_at: datetime
```

---

## 五、头部产品形态对照

### 5.1 ChatGPT（OpenAI）

ChatGPT 在产品形态上率先定义了"对话即产品"的范式。

```
核心架构（推断自 GPT-4 Technical Report 及公开信息）：

用户输入
  ↓
安全过滤层（Moderation API）
  ↓
对话管理（多轮上下文，按 token 预算截断）
  ↓
GPT-4 / GPT-4o（工具调用能力：browse/code/DALL-E）
  ↓
输出后处理（安全过滤 + 格式化）
  ↓
流式输出（SSE）
```

**关键产品决策**：
- 默认开启工具（web search、Python executor、DALL-E），降低用户门槛
- 个人化记忆（Memory）：用户偏好跨会话保留，本质是精简的情节记忆
- Projects：给 Agent 绑定固定知识库，填补"私有知识"场景

### 5.2 Claude（Anthropic）

Anthropic 的 Claude 在产品架构上有几个明显差异：

```
Constitutional AI 层（价值对齐）
  ↓
System Prompt 解析（支持长达 200k token 的上下文）
  ↓
Claude 3.x / Claude 4.x 模型
  ↓
工具执行层（MCP 协议，标准化工具接入）
  ↓
回答 + 引用
```

Anthropic "Building effective agents"（2024）**[4]** 在工程设计上推荐**从简单做起**：

> "We recommend that developers start with simple, single-agent architectures before moving to multi-agent systems. The complexity of coordinating multiple agents often outweighs the benefits for most use cases."

**关键产品决策**：
- MCP（Model Context Protocol）：标准化工具接入协议，让第三方开发者能为 Claude 提供工具，相当于 Agent 生态的 USB-C
- Claude.ai Projects：私有知识库 + 持久化 system prompt
- 超长上下文（200k token）：减少对外部记忆系统的依赖

### 5.3 通义千问（阿里巴巴）

通义千问（Qwen）是阿里巴巴基于 Qwen 系列模型构建的对话产品 **[8]**。

```
企业落地架构（基于公开技术报告）：

钉钉 / 阿里云工作台
  ↓
意图识别层（支持中文领域专项分类）
  ↓
Qwen-Max / Qwen2.5 模型
  ↓
工具层：
  - 代码执行器（支持 Python/Jupyter）
  - 网页搜索（集成通义搜索）
  - 文档解析（PDF/Word/Excel）
  - 企业内数据源（通过 API 接入）
  ↓
输出安全审核
```

**关键特点**：
- 深度中文优化（Qwen2 Technical Report 显示中文基准大幅领先）
- 企业私有化部署能力（支持阿里云 VPC 内部署）
- 与钉钉生态深度绑定（企业数据隔离 + 角色权限）

### 5.4 Gemini（Google）

Google 在 "Agents" 白皮书（2024）中披露了 Gemini 的 Agent 架构思路 **[3]**：

```
Gemini Agent 架构（根据白皮书）：

用户请求
  ↓
Orchestration Layer（编排层）
  ↓
  ├── Planning（任务拆解）
  ├── Memory（上下文 + 外部存储）
  └── Tool Use
       ├── Google Search（实时搜索）
       ├── Code Execution（Python 沙箱）
       ├── Vertex AI Extensions（企业 API）
       └── MCP / Function Calling（自定义工具）
  ↓
Gemini 2.x 模型
  ↓
回答
```

Google 的差异化是**原生搜索集成**——Gemini 可以直接调用 Google Search 的实时索引，这是其他厂商难以复刻的壁垒。

### 5.5 豆包（字节跳动）

字节跳动豆包基于 Doubao/Seed 系列模型，主要面向 C 端用户，强调多模态和创意生成：

```
豆包架构特点（基于公开信息）：

多模态输入（文本/图片/语音/视频）
  ↓
意图路由（创意生成 / 信息问答 / 任务执行）
  ↓
Doubao-pro / Seed 模型（MoE 架构，256k 上下文）
  ↓
工具层：
  - 图像生成（即梦 AI）
  - 网页搜索
  - 代码执行
  - 实时语音对话
  ↓
个性化模块（"分身"功能 = 角色化的 System Prompt）
```

**关键差异**：字节跳动将豆包定位为"AI 超级应用"，深度整合创意工具（即梦 AI、剪映）；产品上大量借助推荐算法经验做个性化，与 TikTok 推荐体系有技术同源之处。

### 5.6 Amazon Q（AWS）

Amazon Q 是 AWS 面向企业的 AI 对话产品，与 Amazon Bedrock Agents **[7]** 深度集成：

```
Amazon Q Business 架构：

企业数据源（S3 / Confluence / Salesforce / ...）
  ↓
数据连接器（自动抓取、索引、权限同步）
  ↓
向量检索层（Amazon Kendra）
  ↓
Amazon Q（Claude / Titan / Llama 可选）
  ↓
权限过滤（返回内容不超出用户在原系统的权限）
  ↓
回答 + 来源引用
```

AWS 的核心差异是**权限感知**——Amazon Q 能理解用户在原系统（如 Confluence、Salesforce）的权限，确保检索到的文档不超越用户实际可见的范围。这是企业客户最关心的合规需求之一。

---

## 六、产品形态对照总结

```
维度              ChatGPT      Claude       通义千问      Gemini       豆包         Amazon Q
──────────────    ──────────   ──────────   ──────────    ──────────   ──────────   ──────────
主要场景          通用 / 创意   通用 / 代码   企业 / 中文   通用 / 搜索  C端 / 创意    企业知识库
上下文长度        128k         200k         128k          1M           256k         varies
内置工具          搜索+代码+图  MCP生态       代码+搜索     搜索+代码     搜索+图+音    知识库+API
记忆              跨会话记忆    Projects     工作空间      Workspace    分身设置      IAM权限集成
私有化部署        无            企业协议      阿里云VPC      GCP           字节企业版    AWS VPC
中文优化          一般          较好          最优           一般          较好          弱
```

---

## 七、架构选型决策树

选哪种架构？本质是在**能力需求**和**系统复杂度**之间找平衡点：

```
你的场景是什么？
│
├── 问题集合固定、答案标准化（<1000 种问题）
│   → 第一代 FAQ Bot（规则 + 模板）
│   → 理由：可解释、可控、零幻觉风险
│
├── 需要基于私有知识库回答，但不需要主动操作
│   → 第二代 RAG 助手
│   → 理由：工程成熟、质量可控、成本合理
│
├── 需要跨系统操作（查询 → 处理 → 写回）
│   ├── 步骤固定、流程可预见
│   │   → 第三代 Agent（确定性工作流 / DAG）
│   │   → 推荐框架：LangGraph、AWS Step Functions
│   │
│   └── 步骤动态、需要 LLM 规划
│       → 第三代 Agent（ReAct / Plan-and-Execute）
│       → 推荐从单 Agent 开始，不要一开始就上 Multi-Agent
│
└── 需要多个 Agent 并行协作
    → 仅当单 Agent 已验证不够用时才升级
    → 参考：Anthropic 的建议是"最后手段"[^4]
```

:::启发 从简单做起，只在必要时升级
Anthropic 工程师在 "Building effective agents" **[4]** 中给出的最重要建议：大多数生产问题可以用"增强的 RAG"解决，不需要完整的 Agent 架构。Agent 的复杂度（调试难、延迟高、成本大）只有在任务真正需要动态决策时才值得承担。从最简单的实现开始，只有当它不够用时再升级。
:::

---

## 八、架构演进的三条主线

回顾三代架构，有三条主线贯穿始终：

**主线一：从静态到动态**
FAQ Bot 的状态机是静态的（开发时定义好所有路径）；RAG 助手的检索是动态的（根据每次问题实时决定召回内容）；Agent 的规划是完全动态的（每个任务都可能走不同路径）。

**主线二：从被动到主动**
FAQ Bot 和 RAG 助手都是被动的——只有用户说话，系统才响应。Agent 可以主动采取行动——在任务执行过程中，自己决定调用什么工具、什么时候问用户确认。

**主线三：从无状态到有状态**
FAQ Bot 基本无记忆；RAG 助手保留会话历史；Agent 需要跨会话的长期状态（任务进度、历史决策、用户偏好）。状态管理是三代系统工程复杂度的核心差异来源。

---

---

## 引用文献

**[1]** 阿里云. *通义千问技术博客：企业智能客服最佳实践*. 阿里云开发者社区, 2024. [tongyi.aliyun.com](https://tongyi.aliyun.com)

**[2]** Lewis, P., Perez, E., Piktus, A., et al. *Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks*. NeurIPS 2020. [arXiv:2005.11401](https://arxiv.org/abs/2005.11401)

**[3]** Wiesinger, J., Marlow, P., & Voskovic, V. *Agents*. Google Cloud Whitepaper, September 2024. [Google Cloud — Agents Whitepaper](https://cloud.google.com/resources/agents-whitepaper)

**[4]** Anthropic. *Building effective agents*. Anthropic Research Blog, December 2024. [anthropic.com/research/building-effective-agents](https://www.anthropic.com/research/building-effective-agents)

**[5]** Yao, S., Zhao, J., Yu, D., et al. *ReAct: Synergizing Reasoning and Acting in Language Models*. ICLR 2023. [arXiv:2210.03629](https://arxiv.org/abs/2210.03629)

**[6]** OpenAI. *GPT-4 Technical Report*. March 2023. [arXiv:2303.08774](https://arxiv.org/abs/2303.08774)

**[7]** Amazon Web Services. *Amazon Bedrock Agents*. AWS Documentation, 2024. [docs.aws.amazon.com/bedrock/latest/userguide/agents.html](https://docs.aws.amazon.com/bedrock/latest/userguide/agents.html)

**[8]** Qwen Team. *Qwen2 Technical Report*. Alibaba Group, July 2024. [arXiv:2407.10671](https://arxiv.org/abs/2407.10671)
