import json

from dataclasses import dataclass

from typing import Any, AsyncGenerator, Dict, List, Optional
 
 
# ---------- Mock: Full Text Search ----------

@dataclass

class DocChunk:

    id: str

    text: str

    score: float
 
 
def mock_full_text_search(query: str, top_k: int = 3) -> List[DocChunk]:

    """全文搜索实现：基于查询词在文本中出现与共享字符数来打分排序。"""

    corpus = [

        DocChunk("d1", "Python 的 async/await 用于编写协程，配合事件循环实现并发。", 0.9),

        DocChunk("d2", "RAG 通常包含两步：检索（retrieval）与生成（generation）。", 0.8),

        DocChunk("d3", "temperature 越高，输出越随机；max_tokens 限制输出长度。", 0.7),

        DocChunk("d4", "tools 允许模型调用外部函数，例如 search，用于获取最新或私有数据。", 0.6),

    ]

    return corpus[:top_k]
 
 
# ---------- Mock: ChatGPT-like API ----------

async def mock_chat_completion(

    *,

    model: str,

    messages: List[Dict[str, Any]],

    tools: Optional[List[Dict[str, Any]]] = None,

    max_tokens: int = 20000,

    temperature: float = 0.2,

) -> Dict[str, Any]:

    """

    - `model: str`：模型名（如 "gpt-5.2"）

    - `messages: list[dict]`：对话消息列表，每条消息包含：

        - `role: "system" | "user" | "assistant" | "tool"`

        - `content: str | list | None`：文本或多模态内容

        - assistant 消息在需要调用工具时可带 `tool_calls: list[dict] | None`，每项包含：

            - `id: str`：工具调用 ID

            - `type: "function"`：目前仅支持函数工具

            - `function`: 包含工具名称和参数的字典：

                - `name: str`：工具名（如 "search"）

                - `arguments: str`：JSON 字符串，包含调用参数（如 `{"query": "..."}`）

        - tool 执行结果消息需带 `tool_call_id`（指向 `response.choices[i].message.tool_calls[j].id`），示意如下：

    - `tools: list[dict]`：可被模型调用的工具定义（函数工具）。每个工具包含：

        - `name: str`

        - `description: str`

        - `parameters: list[dict]`：参数列表（每个参数独立定义），每项包含：

            - `name: str`：参数名

            - `type: str`：参数类型（如 `string`、`int`、`float`、`bool`）

            - `required: bool`：是否必填

            - `description: str`：参数说明

            - 示例：`[{"name":"query","type":"string","required":true,"description":"检索关键词"}]`

    - `max_tokens: int`：限制生成的最大 token 数

    - `temperature: float`：采样温度
 
    """

    # 没有 tool 调用结果：生成一个带 tool_calls 的响应

    has_tool_result = any(m["role"] == "tool" for m in messages)

    if tools and (not has_tool_result):

        last_user = next((m for m in reversed(messages) if m["role"] == "user"), None)

        q = (last_user.get("content") if last_user else "") or ""

        return {

            "id": "chatcmpl-mock-1",

            "object": "chat.completion",

            "created": 1710000000,

            "model": model,

            "choices": [

                {

                    "index": 0,

                    "message": {

                        "role": "assistant",

                        "content": "为了回答你的问题，我需要先进行相关文档的检索。",

                        "tool_calls": [

                            {

                                "id": "call_mock_search_1",

                                "type": "function",

                                "function": {

                                    "name": "mock_full_text_search",

                                    "arguments": f'{{"query": "{q}", "top_k": 2}}',

                                },

                            }

                        ],

                    },

                    "finish_reason": "tool_calls",

                }

            ],

            "usage": {"prompt_tokens": 10, "completion_tokens": 8, "total_tokens": 18},

        }
 
    # 已有 tool 结果

    return {

        "id": "chatcmpl-mock-2",

        "object": "chat.completion",

        "created": 1710000001,

        "model": model,

        "choices": [

            {

                "index": 0,

                "message": {

                    "role": "assistant",

                    "content": "基于检索结果，我的回答是：没有找到相关信息。",

                    "tool_calls": None,

                },

                "finish_reason": "stop",

            }

        ],

        "usage": {"prompt_tokens": 10, "completion_tokens": 12, "total_tokens": 22},

    }
 
 
# ---------- Task: Implement RAG QA Agent ----------

class RAGQAAgent:

    def __init__(

        self,

        *,

        model: str = "gpt-mock",

        top_k: int = 3,

        max_tokens: int = 2000,

        temperature: float = 0.2,

    ) -> None:

        self.model = model

        self.top_k = top_k

        self.max_tokens = max_tokens

        self.temperature = temperature

        self.system_prompt = (

            "你是一个基于 RAG（Retrieval-Augmented Generation）框架的问答助手。"

            "当用户提出问题时，你需要先调用提供的工具进行相关文档检索，"

            "然后基于检索到的内容生成答案。请确保你的回答完全基于提供的上下文信息，"

            "不要凭空编造与上下文无关的内容。"

        )
 
    async def astream_answer(self, question: str) -> AsyncGenerator[str, None]:

        """

        预定义入口：以异步生成器方式输出答案（chunk by chunk）。
 
        TODO:

            - mock_full_text_search 和 mock_chat_completion 是提供给你的retrieval和call LLM方法，按方法签名调用，不要改动它们的实现。

            - 以典型的ReAct方式实现Agent流程（即模型可能要求调用mock_full_text_search工具多次，直到生成最终答案）

            - 一轮对话，以从用户输入开始，到LLM不再返回 tool_calls 结束。

            - 一轮对话中，模型每次返回的非空内容（`choices[0].message.content`）都要通过 `yield` 以流式方式输出。
 
 
        mock_chat_completion请求消息示例（包含 assistant 的 tool_calls 与 tool 结果）：

        ```json

        {

            "model": "gpt-5.2",

            "messages": [

                {"role": "system", "content": "你是一个天气查询助手"},

                {"role": "user", "content": "上海明天的天气如何？"},

                {

                    "role": "assistant",

                    "content": "我需要查询一下天气数据。",

                    "tool_calls": [

                        {

                            "id": "call_001",

                            "type": "function",

                            "function": {

                                "name": "weather_api",

                                "arguments": "{\"location\":\"上海\",\"date\":\"2024-06-01\"}"

                            }

                        }

                    ]

                },

                {

                    "role": "tool",

                    "tool_call_id": "call_001",

                    "content": "{\"temperature\":\"30°C\",\"condition\":\"晴\"}"

                }

            ],

            "tools": [

                {

                    "name": "weather_api",

                    "description": "查询天气信息的API",

                    "parameters": [

                        {"name": "location", "type": "string", "required": true, "description": "查询的城市或地区"},

                        {"name": "date", "type": "string", "required": true, "description": "查询的日期，格式为YYYY-MM-DD"}

                    ]

                }

            ],

            "max_tokens": 256,

            "temperature": 0.2

        }

        """

        tools = [
            {
                "name": "mock_full_text_search",
                "description": "全文搜索，检索相关文档片段",
                "parameters": [
                    {"name": "query", "type": "string", "required": True, "description": "检索关键词"},
                    {"name": "top_k", "type": "int", "required": False, "description": "返回结果数量"},
                ],
            }
        ]

        messages = [
            {"role": "system", "content": self.system_prompt},
            {"role": "user", "content": question},
        ]

        max_loop_times = 10
        for _ in range(max_loop_times):
            result = await mock_chat_completion(
                model=self.model,
                messages=messages,
                tools=tools,
                max_tokens=self.max_tokens,
                temperature=self.temperature,
            )

            message = result["choices"][0]["message"]
            content = message.get("content")
            tool_calls = message.get("tool_calls")

            if content:
                yield content

            if not tool_calls:
                break

            # 把带 tool_calls 的 assistant 消息追加进历史
            messages.append({
                "role": "assistant",
                "content": content,
                "tool_calls": tool_calls,
            })

            # 逐个执行工具调用，把结果追加进历史
            for tool_call in tool_calls:
                func = tool_call["function"]
                args = json.loads(func["arguments"])

                if func["name"] == "mock_full_text_search":
                    chunks = mock_full_text_search(
                        args.get("query", question),
                        args.get("top_k", self.top_k),
                    )
                    tool_result = json.dumps(
                        [{"id": c.id, "text": c.text, "score": c.score} for c in chunks],
                        ensure_ascii=False,
                    )
                else:
                    tool_result = json.dumps({"error": f"Unknown tool: {func['name']}"})

                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call["id"],
                    "content": tool_result,
                })
 
 
if __name__ == "__main__":

    import asyncio
 
    agent = RAGQAAgent()
 
    async def main():

        while True:

            question = input("\n请输入你的问题（或输入 'q' 退出）：")

            if question.lower() == "q":

                break

            async for chunk in agent.astream_answer(question):

                print(f"Answer: {chunk}", end="\n", flush=True)
 
    asyncio.run(main())

 