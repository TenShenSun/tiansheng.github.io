# LangGraph 框架深度解读：有状态 Agent 编排的工程基础

:::观点 为什么这篇文章值得读
LangGraph 是目前生产环境中使用最广泛的 Agent 编排框架之一，被 Replit、Uber、LinkedIn 等公司用于构建复杂的多步骤智能体系统。它的核心创新不是让你少写代码，而是给 Agent 的"状态"和"流程"提供了一套严肃的工程抽象——可持久化、可中断、可重放、可调试。本文从方法论出发，逐层拆解其功能点、适用场景与最佳实践，代码示例均基于 LangGraph 0.2+ API。
:::

---

## 一、LangGraph 诞生的背景：Agent 需要什么

### 1.1 LangChain 的天花板

LangChain 的核心抽象是**链（Chain）**和 **LCEL（LangChain Expression Language）**，本质是一个有向无环图（DAG）的 Pipe：

```
输入 → [Step1] → [Step2] → [Step3] → 输出
```

这对于简单的 RAG 管道够用，但 Agent 需要的是**循环**：

```
[LLM 思考] → [工具调用] → [观察结果] → [重新思考] → ...
```

DAG 无法表达循环，也无法表达"等待人类审批后继续"或"从上次中断的地方恢复"。LangGraph 在 2024 年初从 LangChain 中独立出来，专门解决这类问题。

### 1.2 生产 Agent 的真实需求

在生产中部署一个可靠的 Agent，至少需要解决以下问题：

| 问题 | 简单实现的缺陷 | LangGraph 的解法 |
|---|---|---|
| Agent 循环 | 容易死循环、无法追踪 | 图结构 + 递归限制 |
| 长任务中断恢复 | 全部重跑，浪费 token | Checkpointer 状态持久化 |
| 人工审批节点 | 无法自然暂停 | `interrupt()` 机制 |
| 多步骤状态管理 | 靠全局变量，难以测试 | TypedDict State + Reducer |
| 并行工具调用 | 手写 asyncio，逻辑分散 | Send API + fan-out/fan-in |
| 多 Agent 协作 | 没有统一的消息路由 | Supervisor / Swarm 模式 |

---

## 二、核心方法论：图即状态机

### 2.1 LangGraph 的本质抽象

LangGraph 把 Agent 的执行过程建模为一个**有限状态机（Finite State Machine）**，用图（Graph）来表达：

```
State（共享数据结构）
   ↕ 读写
Node（Python 函数，接受 State，返回 State 更新）
   ↕ 连接
Edge（确定性路由或条件路由）
```

**核心不变式**：每个节点只需要关心"我收到了什么 State，我应该返回什么更新"，不需要知道前一个节点是谁、后面走哪里。

### 2.2 与 DAG 框架的根本区别

```
DAG（Airflow / LangChain LCEL）:
  A → B → C → D
  每条边固定，数据从左到右单向流动

StateGraph（LangGraph）:
  A → B → C
        ↑   ↓
        ←←←← （条件边可以构成循环）
  同一个节点可以被多次经过，每次 State 不同
```

这个区别让 LangGraph 能自然表达 ReAct 循环、Plan-Replan、Reflexion 等模式，而不需要任何特殊处理。

### 2.3 Reducer 思想：如何合并状态更新

LangGraph 借鉴了 Redux 的 Reducer 概念：多个节点可以并发执行并各自返回部分 State 更新，框架通过 **Reducer 函数**将这些更新合并回全局 State：

```python
from typing import Annotated
from langgraph.graph.message import add_messages
from typing import TypedDict

class AgentState(TypedDict):
    # add_messages 是内置 Reducer：新消息追加，不是覆盖
    messages: Annotated[list, add_messages]
    # 没有 Annotated → 后写的值覆盖前一个值
    current_plan: str
    iterations: int
```

`add_messages` 是最常用的内置 Reducer，自动处理消息列表的追加、去重（按 message id）和工具消息匹配。

---

## 三、核心功能点

### 3.1 StateGraph：图的构建

```python
from langgraph.graph import StateGraph, END, START
from langchain_anthropic import ChatAnthropic

model = ChatAnthropic(model="claude-sonnet-4-6")
tools = [search_tool, calculator_tool]
model_with_tools = model.bind_tools(tools)

def agent_node(state: AgentState):
    response = model_with_tools.invoke(state["messages"])
    return {"messages": [response]}

def tool_node(state: AgentState):
    # 执行最后一条消息里的所有工具调用
    results = []
    for tool_call in state["messages"][-1].tool_calls:
        result = tools_map[tool_call["name"]].invoke(tool_call["args"])
        results.append(ToolMessage(content=str(result), tool_call_id=tool_call["id"]))
    return {"messages": results}

def should_continue(state: AgentState) -> str:
    last_message = state["messages"][-1]
    if last_message.tool_calls:
        return "tools"
    return END

builder = StateGraph(AgentState)
builder.add_node("agent", agent_node)
builder.add_node("tools", tool_node)

builder.add_edge(START, "agent")
builder.add_conditional_edges("agent", should_continue)
builder.add_edge("tools", "agent")  # 工具执行后回到 agent

graph = builder.compile()
```

这就是最基本的 ReAct Agent，~40 行代码，清晰可读，比手写 while 循环多了以下保证：
- 循环次数可通过 `recursion_limit` 硬限制
- 每次迭代的 State 变化可被 Checkpointer 记录
- 任意节点的执行可被 streaming 观测

### 3.2 边与条件路由

LangGraph 有三种边：

**① 固定边**：节点 A 执行完后一定执行节点 B
```python
builder.add_edge("tools", "agent")
```

**② 条件边**：根据函数返回值路由到不同节点
```python
builder.add_conditional_edges(
    "agent",
    should_continue,         # 函数返回节点名或 END
    {"tools": "tools", END: END}  # 可选的路由映射表
)
```

**③ 入口边**：从 START 开始
```python
builder.add_edge(START, "agent")
# 或者设置入口节点
builder.set_entry_point("agent")
```

条件边的路由函数可以任意复杂，访问完整 State、调用外部系统、甚至调用一个 LLM 决策——这是 LangGraph 比硬编码 if-else 更有表达力的地方。

### 3.3 Checkpointer：有状态持久化

Checkpointer 是 LangGraph 的杀手特性。每次节点执行后，框架自动将当前完整 State 序列化存储：

```python
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.checkpoint.postgres import PostgresSaver

# 开发环境：内存或 SQLite
memory = SqliteSaver.from_conn_string(":memory:")
graph = builder.compile(checkpointer=memory)

# 调用时传入 thread_id（对话标识符）
config = {"configurable": {"thread_id": "user-123-session-456"}}
result = graph.invoke({"messages": [HumanMessage("帮我分析这份报告")]}, config)

# 下一轮对话，同一 thread_id 自动恢复上下文
result2 = graph.invoke({"messages": [HumanMessage("刚才分析的第三点展开讲讲")]}, config)
```

Checkpointer 的存储结构：

```
thread_id: "user-123-session-456"
└── checkpoint_id: "ckpt_001"
    ├── state: { messages: [...], current_plan: "..." }
    ├── metadata: { step: 3, source: "loop", writes: {...} }
    └── created_at: "2026-06-13T10:30:00Z"
```

:::方法 Checkpoint 的三个生产价值
**① 长对话自动续接**：无需在应用层维护对话历史，`thread_id` 就是会话 ID。  
**② 故障恢复**：Agent 执行到第 7 步时服务重启，重新调用自动从第 7 步继续，不重跑前 6 步。  
**③ 时间旅行调试**：用 `get_state_history(config)` 查看任意历史 Checkpoint，用 `update_state` 修改后重新运行——Agent 调试的神器。
:::

### 3.4 Human-in-the-Loop：优雅的暂停机制

生产 Agent 经常需要在关键节点等待人工确认，LangGraph 提供了 `interrupt()` 原语：

```python
from langgraph.types import interrupt

def review_plan_node(state: AgentState):
    plan = state["current_plan"]
    # 触发中断，把 plan 展示给人类，等待决策
    human_decision = interrupt({
        "question": "请确认以下执行计划：",
        "plan": plan
    })
    if human_decision["approved"]:
        return {"plan_approved": True}
    else:
        return {"plan_approved": False, "feedback": human_decision["feedback"]}
```

从外部恢复：
```python
# 第一次调用，触发中断，返回 interrupted 状态
result = graph.invoke(input, config)
# result["__interrupt__"] 包含中断时传出的数据

# 人工审批后，用 Command 恢复
from langgraph.types import Command
graph.invoke(Command(resume={"approved": True}), config)
```

`interrupt()` 的机制：
1. 节点抛出一个特殊异常
2. 框架捕获异常，将当前 State 写入 Checkpointer，返回给调用方
3. 调用方展示信息给人类，收到输入后用 `Command(resume=...)` 唤醒
4. 框架从 Checkpoint 恢复，把 `resume` 的值作为 `interrupt()` 的返回值

这比"停轮询/拉状态/传参数"优雅得多，人工干预点可以写在任何节点内部，不需要在图结构层面专门做分叉。

### 3.5 流式输出：三种粒度

```python
# 模式 1：流式 token（适合 UI 实时显示）
for chunk in graph.stream(input, config, stream_mode="messages"):
    if chunk[1]["langgraph_node"] == "agent":
        print(chunk[0].content, end="", flush=True)

# 模式 2：流式 State 更新（适合调试/观测）
for chunk in graph.stream(input, config, stream_mode="updates"):
    print(f"节点 {list(chunk.keys())[0]} 执行完毕")
    print(chunk)

# 模式 3：两者合并（stream_mode=["messages", "updates"]）
for chunk in graph.stream(input, config, stream_mode=["messages", "updates"]):
    ...
```

`stream_mode="messages"` 下每个 chunk 是 `(message_chunk, metadata)` 元组，`metadata` 包含当前执行的节点名，可以在 UI 里展示"正在使用工具：搜索"等状态。

### 3.6 Send API：动态并行

有些任务需要对一批项目并行处理，数量在运行时才确定——这是静态图结构无法表达的。LangGraph 的 `Send` API 解决这个问题：

```python
from langgraph.types import Send

def dispatch_subtasks(state: AgentState):
    # 根据运行时数据动态创建并行任务
    return [
        Send("process_item", {"item": item, "context": state["context"]})
        for item in state["items_to_process"]
    ]

def process_item(state: dict):
    # 这个节点会被并发执行 N 次
    result = analyze(state["item"])
    return {"results": [result]}

builder.add_conditional_edges("dispatch", dispatch_subtasks)
builder.add_edge("process_item", "aggregate")
```

`Send` 的执行模型：
- 同一个节点的多个 `Send` 实例并发执行（默认 asyncio 并发）
- 每个实例有独立的 State 副本
- 执行完毕后，所有实例的返回值通过 Reducer 合并回主 State
- `aggregate` 节点在所有并行分支完成后触发（隐式 fan-in）

### 3.7 多 Agent 协作模式

LangGraph 原生支持两种多 Agent 架构：

**Supervisor 模式**：一个 Supervisor Agent 负责路由，将任务分配给专业 Worker Agent

```python
from langgraph.prebuilt import create_react_agent

researcher = create_react_agent(model, tools=[web_search])
coder = create_react_agent(model, tools=[python_repl])
writer = create_react_agent(model, tools=[file_write])

def supervisor_node(state):
    # Supervisor 决定下一步由谁执行
    response = supervisor_model.invoke(state["messages"])
    return {"next_agent": response.content}

def route_to_agent(state):
    return state["next_agent"]  # "researcher" / "coder" / "writer" / "FINISH"

builder.add_node("supervisor", supervisor_node)
builder.add_node("researcher", researcher)
builder.add_node("coder", coder)
builder.add_conditional_edges("supervisor", route_to_agent)
```

**Swarm 模式（0.2+）**：Agent 之间平等协商，通过 `handoff` 工具把控制权转移给另一个 Agent

```python
from langgraph.prebuilt import create_react_agent
from langgraph.prebuilt.swarm import create_swarm

agents = [
    create_react_agent(model, tools=[search, handoff_to_coder], name="researcher"),
    create_react_agent(model, tools=[code_exec, handoff_to_writer], name="coder"),
    create_react_agent(model, tools=[write_file, handoff_to_researcher], name="writer"),
]

swarm = create_swarm(agents, default_active_agent="researcher")
```

Swarm 更适合对话场景，每次用户消息由一个 active agent 处理，它可以决定是否把控制权移交给另一个更合适的 Agent。

### 3.8 Subgraph：模块化复用

复杂 Agent 系统可以用子图（Subgraph）分层组织：

```python
# 构建一个可复用的 RAG 子图
rag_builder = StateGraph(RagState)
rag_builder.add_node("retrieve", retrieve_node)
rag_builder.add_node("grade", grade_node)
rag_builder.add_node("generate", generate_node)
rag_graph = rag_builder.compile()

# 在主图中使用子图，就像使用普通节点
main_builder = StateGraph(MainState)
main_builder.add_node("rag", rag_graph)  # 子图作为节点
```

子图有独立的 State，与父图的 State 通过字段映射连接，实现真正的模块化封装。

---

## 四、LangGraph 解决了什么核心问题

### 4.1 循环与终止的可控性

手写 Agent 循环最大的风险是失控——无限递归、token 耗尽、工具调用死循环。LangGraph 提供了：
- `recursion_limit`：全局最大步数限制（默认 25）
- 节点执行超时配置
- 条件边的显式终止条件（返回 `END`）

这些保障让 Agent 的"上限成本"在设计时就能估算。

### 4.2 状态的可观测与可调试

传统 Agent 调试靠打日志，问题是日志只有结果没有上下文。LangGraph 的 Checkpointer 保存每一步的完整 State，让你可以：

```python
# 查看完整执行历史
for state in graph.get_state_history(config):
    print(f"步骤 {state.metadata['step']}: {state.values}")

# 回到第 3 步的 State，改一个值，重新运行
graph.update_state(config, {"current_plan": "修改后的计划"}, as_node="planner")
graph.invoke(None, config)  # 从修改后的状态继续
```

这是 LangGraph 独有的**时间旅行（Time Travel）**调试能力，在复杂 Agent 开发中极大降低了调试成本。

### 4.3 多轮对话的状态管理

在没有框架支持时，多轮对话的状态管理常见方案：

```python
# 反模式：在应用层维护历史
history = []
for user_message in conversation:
    history.append(user_message)
    response = llm.invoke(history)
    history.append(response)
    save_to_db(session_id, history)  # 每轮都要手动序列化
```

LangGraph + Checkpointer 把这个逻辑彻底收进框架，应用层只需要传 `thread_id`，对话历史的读写、截断、持久化全部自动处理。

### 4.4 人机协作的工程化

HITL（Human-in-the-Loop）在不同系统里的实现差别很大：
- **弱实现**：Agent 在一个步骤输出"请确认"，然后系统等待用户回复——本质上是把确认逻辑做成了一次对话轮次，没有真正的暂停/恢复。
- **强实现**：系统在任意节点真正暂停，保存状态，允许用户在几小时后继续——这才是生产级 HITL。

LangGraph 的 `interrupt()` 是强实现，它与 Checkpointer 紧密集成，暂停状态完全持久化，Worker 进程挂了都能恢复。

---

## 五、核心使用场景

### 5.1 编码 Agent（Code Agent）

```
用户描述需求
  → [Planner] 分解为子任务
  → [Coder] 生成代码（可循环多轮）
    → [Tester] 运行测试
      ↳ 测试失败 → 回 Coder 修复
      ↳ 测试通过 → [Reviewer] 代码审查
        ↳ 审查不通过，打回 Coder
        ↳ 审查通过 → [PR Writer] 提交 PR
```

LangGraph 的循环和条件边天然适合这种"写-测-改"的迭代模式。Checkpoint 保证每次 LLM 调用的结果都被记录，中途失败可以从上次成功的步骤续跑。

### 5.2 长周期研究 Agent

分析竞争对手、撰写行研报告等任务可能需要几十轮工具调用，执行时间可达数分钟到数小时：

- Checkpointer 保证进度不丢失
- `interrupt()` 在关键节点（如找到关键信息）等待用户确认方向
- Send API 对多个信息源并行检索
- Subgraph 把"搜索→提炼→总结"封装成可复用模块

### 5.3 客服智能体（带人工升级）

```
用户问题
  → [Intent Router] 意图识别
    → [Knowledge Agent] 尝试知识库回答
      ↳ 置信度不足 → interrupt() 等待人工处理
      ↳ 置信度足够 → 直接回答
  → [Human Agent] 人工处理后，Agent 继续跟进
```

`interrupt()` 完美对应"转人工"这个业务动作，而不需要在系统外做复杂的状态同步。

### 5.4 数据分析流水线

```python
# 典型的数据分析 Agent 状态
class AnalysisState(TypedDict):
    task: str
    data_sources: list[str]
    fetched_data: Annotated[list, operator.add]  # 并行 fetch 的结果自动合并
    analysis_results: list[dict]
    final_report: str
```

Send API 并行从多个数据源拉取数据，Supervisor 节点根据数据特征路由到不同的分析子图（统计分析、时序分析、文本分析），最后汇总生成报告。

### 5.5 多 Agent 协作系统

| 场景 | 推荐模式 | 原因 |
|---|---|---|
| 任务明确分工，需要集中控制 | Supervisor | 路由逻辑集中，易审计 |
| 对话场景，Agent 根据上下文自行判断移交 | Swarm | 更自然的控制流转移 |
| 固定流水线，各阶段有专业 Agent | Pipeline（顺序图） | 简单明确，调试容易 |
| 不确定哪个 Agent 该处理 | Supervisor + Router | 灵活但需要好的路由 prompt |

---

## 六、最佳实践

### 6.1 State 设计原则

**① 保持 State 轻量且可序列化**

State 会被 Checkpointer 序列化存储，避免放入不可序列化的对象（如数据库连接、文件句柄）：

```python
# 反模式
class BadState(TypedDict):
    db_connection: psycopg2.connection  # 不可序列化
    file_handle: IO                     # 不可序列化

# 正确做法：存引用，运行时通过依赖注入获取
class GoodState(TypedDict):
    session_id: str      # 用于查数据库
    file_path: str       # 用于打开文件
```

**② 使用 Annotated + Reducer 而不是手动合并**

```python
# 反模式：在节点里手动追加消息
def bad_node(state):
    new_msg = llm.invoke(state["messages"])
    return {"messages": state["messages"] + [new_msg]}  # 容易出 Bug

# 正确：让 Reducer 处理合并
def good_node(state):
    new_msg = llm.invoke(state["messages"])
    return {"messages": [new_msg]}  # 只返回新消息，add_messages 自动追加
```

**③ 分离关注点：短期 vs. 长期状态**

```python
class AgentState(TypedDict):
    # 短期状态：当前任务上下文，会随对话变化
    messages: Annotated[list, add_messages]
    current_task: str
    tool_results: list

    # 长期状态：跨对话的用户信息（配合 Memory Store）
    user_preferences: dict
    learned_facts: list
```

### 6.2 节点设计原则

**① 节点要幂等（Idempotent）**

Checkpoint 恢复时可能重跑最后一个节点（取决于 Checkpoint 时机），节点应该能安全地被执行多次：

```python
# 非幂等：发送邮件节点不能重复执行
def send_email_node(state):
    send_email(state["email_content"])  # 危险：故障恢复时会发重复邮件
    return {}

# 幂等化：加去重 key
def send_email_node(state):
    idempotency_key = f"email-{state['task_id']}"
    send_email(state["email_content"], idempotency_key=idempotency_key)
    return {}
```

**② 节点职责单一**

抵制把"调用 LLM + 处理结果 + 写数据库"全写在一个节点里的诱惑。小节点更容易测试、更容易在图结构中复用。

**③ 节点要返回增量，而不是完整 State**

```python
# 反模式：返回完整 State（冗余，且可能意外覆盖其他字段）
def bad_node(state):
    return {**state, "analysis": "结果"}

# 正确：只返回本节点的变更
def good_node(state):
    return {"analysis": "结果"}
```

### 6.3 条件边设计

**路由函数保持纯函数**：条件边的路由函数应该只读 State，不产生副作用，不调用 LLM（除非有明确理由）。

```python
# 反模式：在路由函数里调用 LLM
def route(state):
    decision = llm.invoke("根据状态决定下一步")  # 危险：不透明、不可测、耗 token
    return decision.content

# 正确：读 State 里已有的字段
def route(state):
    if state["confidence"] > 0.8:
        return "answer"
    elif state["iterations"] > 3:
        return "escalate"
    else:
        return "retry"
```

如果路由决策需要 LLM 参与，在 Planner 节点里把决策结果写入 State，路由函数只读这个字段。

### 6.4 Checkpointer 选型

| 场景 | 推荐 Checkpointer | 理由 |
|---|---|---|
| 开发调试 | `MemorySaver` | 无依赖，进程内 |
| 单机生产 | `SqliteSaver` | 零运维，持久化 |
| 分布式生产 | `PostgresSaver` | 支持并发，ACID 保证 |
| 高吞吐 | `RedisSaver`（社区） | 低延迟，适合高并发 |

生产环境**必须配置 Checkpointer**，不然长任务故障后全量重跑，浪费资源也影响用户体验。

### 6.5 避免的反模式

:::提醒 五个高频反模式
**① State 膨胀**：把所有中间结果都塞进 State，导致 Checkpoint 体积暴涨，序列化/反序列化成为瓶颈。解法：只保留下游节点实际需要的数据。

**② 过度使用 Supervisor**：所有路由都通过 Supervisor LLM 决策，token 消耗翻倍。解法：能用条件函数路由的，不要用 LLM。

**③ 节点太大**：一个节点做了 7 件事，出错了不知道哪步的问题，也无法单独重跑。解法：每个节点对应一个语义清晰的操作。

**④ 忘记设置 recursion_limit**：新手最常见的坑，Agent 进入死循环直到 token 耗尽。解法：`graph.invoke(input, config, {"recursion_limit": 20})`。

**⑤ 在节点外修改 State**：绕过节点直接修改全局 State，导致 Checkpoint 不一致。解法：所有 State 变更必须通过节点的返回值。
:::

### 6.6 LangSmith 集成

LangGraph 与 LangSmith 原生集成，设置环境变量即可获得完整 tracing：

```bash
export LANGCHAIN_TRACING_V2=true
export LANGCHAIN_API_KEY=your_api_key
export LANGCHAIN_PROJECT=my-agent-project
```

LangSmith 会记录每个节点的输入/输出、执行时间、token 用量，并可以可视化整个图的执行轨迹——这是生产环境调试和性能优化的基础。

---

## 七、LangGraph 与其他框架的对比

| 维度 | LangGraph | AutoGen | CrewAI | Temporal |
|---|---|---|---|---|
| 状态模型 | 显式 TypedDict State | 隐式（消息历史） | 隐式（任务对象） | 工作流引擎（代码即状态） |
| 循环支持 | 原生支持 | 原生支持 | 有限 | 原生支持 |
| Human-in-the-Loop | `interrupt()` 优雅支持 | 需要自定义 | 有限 | 原生信号/查询 |
| Checkpoint | 内置，多后端 | 无 | 无 | 内置（持久化是核心） |
| 多 Agent 协作 | Supervisor/Swarm | Group Chat | 角色化 Crew | 子工作流 |
| 学习曲线 | 中等 | 低 | 低 | 高（需要专门服务端） |
| 生产稳定性 | 高（有大厂背书） | 中 | 中 | 高（久经考验） |
| 适合场景 | LLM-heavy Agent 系统 | 快速原型，对话驱动 | 有明确角色的团队任务 | 长时间、高可靠业务流程 |

:::方法 选框架的核心判断
- **需要复杂的 LLM 编排 + 人工审批 + 故障恢复** → LangGraph
- **快速验证想法，需要多个 Agent 对话** → AutoGen（开发快）
- **业务流程长达数天/数月，必须有工业级保证** → Temporal（配合 LangGraph 使用）
- **只是 RAG 管道** → 都不用，LangChain LCEL 够了
:::

---

## 八、一个完整的生产案例：代码审查 Agent

把前面讲的概念串起来，看一个接近生产的例子：

```python
from typing import Annotated, TypedDict
from langgraph.graph import StateGraph, END, START
from langgraph.graph.message import add_messages
from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.types import interrupt

class ReviewState(TypedDict):
    messages: Annotated[list, add_messages]
    pr_url: str
    diff: str
    issues: list[dict]
    severity_score: float  # 0-1，由 LLM 评估
    human_approved: bool | None

def fetch_diff_node(state: ReviewState):
    diff = github_api.get_pr_diff(state["pr_url"])
    return {"diff": diff}

def analyze_code_node(state: ReviewState):
    response = code_review_model.invoke([
        SystemMessage("你是代码审查专家..."),
        HumanMessage(f"审查以下 diff：\n{state['diff']}")
    ])
    issues = parse_issues(response.content)
    score = calculate_severity(issues)
    return {"issues": issues, "severity_score": score, "messages": [response]}

def should_escalate(state: ReviewState) -> str:
    if state["severity_score"] > 0.7:
        return "human_review"   # 高风险，需人工
    return "auto_approve"

def human_review_node(state: ReviewState):
    decision = interrupt({
        "pr_url": state["pr_url"],
        "issues": state["issues"],
        "severity_score": state["severity_score"],
        "message": "检测到高风险问题，请人工决策"
    })
    return {"human_approved": decision["approved"]}

def post_comment_node(state: ReviewState):
    if state.get("human_approved") is False:
        github_api.request_changes(state["pr_url"], state["issues"])
    else:
        github_api.approve_pr(state["pr_url"])
    return {}

# 构建图
builder = StateGraph(ReviewState)
builder.add_node("fetch_diff", fetch_diff_node)
builder.add_node("analyze", analyze_code_node)
builder.add_node("human_review", human_review_node)
builder.add_node("post_comment", post_comment_node)

builder.add_edge(START, "fetch_diff")
builder.add_edge("fetch_diff", "analyze")
builder.add_conditional_edges("analyze", should_escalate, {
    "human_review": "human_review",
    "auto_approve": "post_comment"
})
builder.add_edge("human_review", "post_comment")
builder.add_edge("post_comment", END)

# 生产配置：PostgreSQL Checkpoint
checkpointer = PostgresSaver.from_conn_string(os.environ["DATABASE_URL"])
graph = builder.compile(checkpointer=checkpointer)
```

这个案例展示了：
- State 字段语义清晰，每个节点职责单一
- 条件路由基于 State 字段，不调用 LLM
- `interrupt()` 优雅实现高风险 PR 的人工审批
- PostgreSQL Checkpointer 保证生产环境可靠性

---

## 参考文献

1. LangGraph 官方文档. *LangGraph Concepts & How-To Guides*. https://langchain-ai.github.io/langgraph/ (accessed 2026-06-13)
2. LangChain Blog. *Introducing LangGraph*. LangChain, Jan 2024.
3. Yao, S. et al. *ReAct: Synergizing Reasoning and Acting in Language Models*. ICLR 2023.
4. Shinn, N. et al. *Reflexion: Language Agents with Verbal Reinforcement Learning*. NeurIPS 2023.
5. LangGraph GitHub Repository. *langgraph / examples*. https://github.com/langchain-ai/langgraph/tree/main/examples
6. LangGraph Documentation. *Multi-agent Systems*. https://langchain-ai.github.io/langgraph/concepts/multi_agent/
7. LangGraph Documentation. *Human-in-the-loop*. https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/
8. LangGraph Documentation. *Persistence (Checkpointer)*. https://langchain-ai.github.io/langgraph/concepts/persistence/
9. Harrison Chase. *Why LangGraph?* LangChain Blog, 2024.
10. LangGraph Documentation. *Streaming*. https://langchain-ai.github.io/langgraph/how-tos/stream-tokens/
11. LangGraph Documentation. *Send API — Map-Reduce patterns*. https://langchain-ai.github.io/langgraph/how-tos/map-reduce/
12. LangGraph Documentation. *Subgraphs*. https://langchain-ai.github.io/langgraph/how-tos/subgraph/
13. LangGraph Documentation. *Time Travel (Replay & Branch)*. https://langchain-ai.github.io/langgraph/how-tos/time-travel/
14. Temporal.io Documentation. *What is Temporal?* https://docs.temporal.io/
15. Wu, Q. et al. *AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent Conversation*. arXiv 2023.
16. LangSmith Documentation. *Tracing with LangGraph*. https://docs.smith.langchain.com/
