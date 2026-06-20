# 提示词工程实战：利用注意力分布写出真正有效的 Prompt

Prompt 工程被很多人当成玄学——试了 A 不行换 B，加了几个形容词好像有用，说不清楚为什么。

这篇文章试图把它变成工程：从 Transformer 注意力的物理机制出发，推导出一套**可解释、可重复的 Prompt 结构原则**，然后给出生产中直接能用的模板。

---

## 一、先理解模型在"读"什么

在讲怎么写之前，先讲模型怎么看你写的内容。

Transformer 生成每个 token 时，对上下文里所有 token 计算注意力权重——权重越高，那个位置的内容对当前输出的影响越大。

实验测量下来，注意力权重的分布是 **U 形**（Liu et al., 2023¹）：

```
注意力强度
    ▲
高  │▓▓▓                          ▓▓▓
    │▓▓▓▓                        ▓▓▓▓
中  │    ▓▓▓▓              ▓▓▓▓▓▓
    │        ▓▓▓▓▓▓▓▓▓▓▓▓▓
低  │
    └─────────────────────────────────▶ 上下文位置
    [开头]         [中间]           [结尾]
```

**开头高**：模型被训练成优先遵循最前面的指令（system prompt 的权威性来源于此）。

**结尾高**：自回归生成中，越靠近当前 token 的位置，注意力越强——最近说的话影响最大。

**中间低**：这就是"Lost in the Middle"——你塞在中间的内容，模型大概率会忽视关键细节。论文¹ 的实测显示，文档放在上下文的中段，模型对其中信息的利用率最低，放头尾效果最好。

这个机制直接决定了 Prompt 应该怎么组织。

---

## 二、Prompt 的空间布局原则

基于 U 形注意力，内容的放置位置应该和其重要程度匹配：

:::方法 开头（高注意力区）
- 角色定义 / 任务框架
- 必须遵守的约束（格式、语言、边界）
- 最重要的一两条上下文前提
:::

:::提醒 中间（低注意力区）
- 背景资料 / 参考文档
- RAG 检索内容
- Few-shot 示例（位置有讲究，见第四节）
:::

:::方法 结尾（高注意力区）
- 当前轮次的具体任务指令
- 输出格式要求（再次强调）
- 最近对话历史
:::

**核心原则：重要的东西放两端，参考材料放中间。**

如果某个约束非常关键，在开头写一次不够——结尾再写一次。重复不是啰嗦，是利用两个高注意力区的双重保险。

### 工业界的印证

这个原则不只是学术论文里的结论，各家工程团队的实践文档都有明确表述：

**OpenAI** 在 GPT-4.1 Prompting Guide² 里直接写道：
> "If you have long context in your prompt, ideally place your instructions at **both the beginning and end** of the provided context, as this performs better than only above or below."

**Anthropic** 在《Prompt engineering for Claude's long context window》³ 里测量了：文档放在上下文顶部、查询放最后，相比其他布局，复杂多文档任务的回答质量提升最高达 30%。

**Google** 在 Gemini 提示设计指南⁴ 里给出同样建议：
> "Supply all the context first and place your specific instructions or questions at the very end of the prompt."

三家的建议方向完全一致，只是措辞不同。背后是同一个机制：U 形注意力。

---

## 三、System Prompt 的内部组织

System prompt 整体在开头，但它本身也有内部结构，顺序很重要。

### 推荐顺序

```
1. 角色声明（1-2 句）
   "你是一个专注于 Python 后端的代码审查助手。"

2. 核心能力边界（做什么 / 不做什么）
   "你只审查代码质量，不修改代码，不讨论需求变更。"

3. 输出格式规范
   "每次回复用以下结构：..."

4. 重要约束（安全、语气、语言等）
   "始终用中文回复。发现安全漏洞时明确标注 [SECURITY]。"

5. 背景知识（可选，如果必须在 system 里给）
   "本项目使用 FastAPI + PostgreSQL，Python 3.12。"
```

越往后越"软"——越靠前的内容越难被覆盖，越靠后的越容易被用户的问题稀释。所以**强约束放前面**，背景信息放后面。

### 反模式：把最重要的约束埋在段落中间

```
❌ 错误写法：
你是一个助手，擅长回答各种问题。你有丰富的知识储备，
可以帮助用户解决很多复杂问题。请注意，不要生成任何
涉及竞品的内容。你的回复应该友好而专业，保持礼貌的
语气，并且使用用户的母语进行回复。

问题在哪：关键约束"不要涉及竞品"埋在第三句，低注意力区。

✓ 正确写法：
禁止规则（必须遵守）：
- 不生成任何涉及竞品的内容
- 始终用用户的母语回复

你是一个助手，擅长回答各种问题……
```

---

## 四、Few-shot 示例的放置策略

Few-shot 示例的效果和位置强相关，有三条规律：

### 规律一：示例越靠近任务指令越有效

```
❌ 示例放开头，任务指令放结尾（中间隔了大段背景）：
  [示例 1][示例 2][示例 3] ... [大量背景文本] ... [当前任务]

✓ 示例紧跟在任务指令前面：
  [背景文本] ... [示例 1][示例 2][示例 3][当前任务]
```

原因：示例的作用是"格式化"模型的输出模式，放在靠近任务指令的位置（结尾高注意力区），对当前输出的约束力更强。

### 规律二：最后一个示例影响最大

如果只有一个示例，放在最后（紧跟任务之前）。如果有多个示例，把**最典型、最希望模型模仿的那个**放在最后。

```python
# 示例排列建议
messages = [
    {"role": "system", "content": system_prompt},
    # 背景、文档放这里（中间）
    {"role": "user", "content": "示例输入 1"},
    {"role": "assistant", "content": "示例输出 1（一般案例）"},
    {"role": "user", "content": "示例输入 2"},
    {"role": "assistant", "content": "示例输出 2（最典型案例，放最后）"},
    # ↑ 这条示例影响最大
    {"role": "user", "content": "当前实际任务"},  # 紧跟在最佳示例后
]
```

### 规律三：示例数量的边际效益递减

```
0-shot → 1-shot：收益最大（建立输出格式）
1-shot → 3-shot：明显收益（建立规律感）
3-shot → 5-shot：小幅收益
5-shot 以上：边际效益极低，主要是占 token
```

超过 5 个示例通常意味着任务本身需要 fine-tune 而不是 prompt 调整。

---

## 五、长上下文的信息布局

当上下文超过 8k token，"放哪里"的决策变得更重要。

### 5.1 RAG 召回内容的放置

RAG 检索的文档通常 2000-5000 token，是典型的"中间低注意力区"受害者。

```
低效布局：
  [System Prompt]
  [检索文档 1][检索文档 2][检索文档 3]   ← 直接堆在开头之后
  [对话历史]
  [当前问题]

高效布局：
  [System Prompt]
  [对话历史（前几轮摘要）]
  [检索文档 1][检索文档 2][检索文档 3]   ← 放在中间，但做了摘要压缩
  [最近 2-3 轮对话历史]
  [当前问题 + 提示"请参考上面的文档回答"]  ← 结尾再次指向文档
```

**关键技巧**：在结尾的任务指令里**显式引用中间的内容**，强迫模型回顾：

```
✓ "请基于上面提供的三篇文档（文档1: xxx，文档2: xxx，文档3: xxx），回答以下问题……"

这句话在结尾（高注意力区），用关键词把模型的注意力"拉回"到中间文档。
```

### 5.2 工具定义的放置

工具定义（function calling schema）通常由框架自动插入，但如果可以控制位置，推荐放开头附近：

```
[System Prompt]
[工具定义]      ← 靠近开头，模型能"记住"有哪些工具
[对话历史]
[当前任务]
```

原因：工具定义影响的是模型的能力边界（"我能做什么"），属于约束类信息，适合放高注意力的开头区。

---

## 六、对话历史的管理

对话历史既要放靠后（保证连贯性），又不能无限增长（把整个结尾区撑满）。

### 6.1 保留策略

```python
def trim_history(
    history: list[dict],
    max_tokens: int = 4000,
    always_keep_last_n: int = 3
) -> list[dict]:
    # 最近 N 轮无论如何保留（结尾高注意力区）
    must_keep = history[-always_keep_last_n * 2:]  # *2 因为 user+assistant

    # 剩余历史按 token 预算填充
    optional = history[:-always_keep_last_n * 2]
    result = []
    budget = max_tokens - count_tokens(must_keep)

    for msg in reversed(optional):
        tokens = count_tokens(msg)
        if budget - tokens < 0:
            break
        result.insert(0, msg)
        budget -= tokens

    return result + must_keep
```

### 6.2 摘要压缩的时机

不是历史一长就摘要，而是**超过预算才触发**：

```python
async def get_context(history, budget=6000):
    trimmed = trim_history(history, max_tokens=budget)

    # 如果丢掉了超过一半的历史，生成一个摘要放在最前
    if len(trimmed) < len(history) * 0.5:
        summary = await summarize(history[:-len(trimmed)])
        return [{"role": "system", "content": f"[之前对话摘要] {summary}"}] + trimmed

    return trimmed
```

---

## 七、指令强调的三种手法

当模型反复忽视某个约束，不要只靠加感叹号——换位置和结构。

### 手法一：头尾重复

```
[System Prompt 开头]
规则：回复必须在 200 字以内。

... （中间大量内容）...

[用户消息结尾]
请回答上面的问题。注意：回复控制在 200 字以内。
```

### 手法二：负面示例强化

光说"要做什么"不如加一条"不要做什么"——两者激活不同的训练模式：

````
✓ 输出格式要求：
  - 只输出 JSON，不要有任何额外解释
  - 不要在 JSON 前后加 markdown 代码块

❌ 错误示例（不要这样输出）：
  好的，这是结果：
  ```json
  {...}
  ```
````

### 手法三：结构化而非散文

大段散文指令中，关键约束容易被视觉噪声稀释：

```
❌ 散文风格：
请你帮我分析这段代码，找出其中的问题，给出修改建议，
使用中文回复，保持专业语气，不要超过 300 字，重点关注性能问题。

✓ 结构化风格：
任务：分析代码问题并给出修改建议

约束：
- 语言：中文
- 长度：300 字以内
- 重点：性能问题

输出格式：
1. 问题列表（每条一行）
2. 修改建议（对应每条问题）
```

结构化写法让每条指令都"独占一行"，减少被周围内容干扰的概率。

---

## 八、生产中的实战模板

### 模板一：RAG 问答 Agent

```
[SYSTEM]
你是 {公司名} 的客服助手，只基于提供的文档回答问题。
- 如果文档中没有相关信息，明确说"文档中未找到相关信息"
- 不要根据自身知识补充答案
- 回复用中文，控制在 300 字以内

[USER - 历史摘要（如有）]
{之前对话的摘要}

[USER - 检索文档]
以下是与用户问题相关的文档片段：

文档1（{来源}）：
{内容}

文档2（{来源}）：
{内容}

[USER - 近期对话]
{最近 2-3 轮对话}

[USER - 当前问题]
{用户的问题}

请基于上面文档1和文档2的内容回答，如果文档中没有答案请直说。回复控制在 300 字以内。
```

注意：核心约束在开头写一次（高注意力），在结尾任务里再强调一次（高注意力），文档放中间。

---

### 模板二：代码生成 Agent

```
[SYSTEM]
你是一个 Python 代码生成助手。

硬性约束（必须遵守）：
- 只输出代码，不输出任何解释
- 代码必须通过 mypy 严格模式
- 不使用任何第三方库（只用标准库）

技术栈：Python 3.12，类型注解风格参考 PEP 695

[Few-shot 示例 1]
需求：写一个反转字符串的函数
输出：
def reverse_string(s: str) -> str:
    return s[::-1]

[Few-shot 示例 2 - 最典型案例，放最后]
需求：写一个线程安全的计数器
输出：
import threading

class ThreadSafeCounter:
    def __init__(self) -> None:
        self._value = 0
        self._lock = threading.Lock()

    def increment(self) -> int:
        with self._lock:
            self._value += 1
            return self._value

[USER]
需求：{具体需求}

只输出代码，不输出任何解释。
```

---

### 模板三：结构化数据提取

```
[SYSTEM]
从用户提供的文本中提取结构化信息，严格按 JSON 格式输出。

输出格式：
{
  "name": "string | null",
  "date": "YYYY-MM-DD | null",
  "amount": "number | null",
  "currency": "string | null"
}

规则：
- 找不到的字段填 null，不要猜测
- 只输出 JSON，不要加任何解释或代码块标记

[USER]
{待提取的文本}

提取上述字段，只输出 JSON。
```

---

## 九、快速自查清单

写完 Prompt 后，用这个清单过一遍：

```
位置检查：
  □ 最关键的约束在开头？
  □ 当前任务指令在结尾？
  □ 参考文档/背景信息在中间？
  □ 关键约束有没有在结尾再重复一次？

结构检查：
  □ 指令是结构化列表，不是散文段落？
  □ 有负面示例（不要做什么）？
  □ Few-shot 示例靠近任务指令，最佳示例放最后？

长度检查：
  □ 对话历史有 token 上限，不会无限增长？
  □ RAG 内容做了摘要压缩，不是原文直接堆叠？
  □ Few-shot 示例不超过 5 个？
```

---

## 结语

好的 Prompt 不是"魔法咒语"，是对模型注意力机制的工程利用。

U 形注意力是物理事实：开头和结尾总是被更认真地"阅读"，中间总是容易丢失细节。Prompt 写法的核心就是把这个事实变成设计原则——重要的放两端，约束要重复，指令要结构化。

这套方法可以解释大部分"玄学"现象：为什么加了一句话突然效果变好（你把约束从中间移到了结尾）、为什么 few-shot 有时没用（示例离任务太远、被淹在中间）、为什么同样的指令换个位置结果不同（注意力分布不同）。

理解机制，写 Prompt 才有底气。

---

## 参考文献

**论文**

1. Nelson F. Liu et al. **Lost in the Middle: How Language Models Use Long Contexts**. *TACL 2024*. [arxiv.org/abs/2307.03172](https://arxiv.org/abs/2307.03172)

**工程博客**

2. OpenAI. **GPT-4.1 Prompting Guide** — 长上下文下指令放头尾的实测建议。[cookbook.openai.com](https://cookbook.openai.com/examples/gpt4-1_prompting_guide)
3. Anthropic. **Prompt engineering for Claude's long context window** — 文档位置对回答质量的影响实测。[anthropic.com](https://www.anthropic.com/news/prompting-long-context)
4. Google. **Gemini API Prompting Strategies** — 大段资料先放、指令放最后的官方指导。[ai.google.dev](https://ai.google.dev/gemini-api/docs/prompting-strategies)
5. Anthropic. **Effective context engineering for AI agents** — 把 prompt 工程升级为 context 工程的工程实践。[anthropic.com](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
