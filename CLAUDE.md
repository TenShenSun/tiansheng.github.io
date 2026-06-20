# CLAUDE.md

## 项目概述

纯前端 SPA 博客（Agent Architect 技术博客），hash 路由 + marked.js 渲染 Markdown，**没有构建步骤**。`_config.yml` 是 Jekyll 遗留配置，实际渲染全部由 `assets/js/app.js` 驱动。

本地预览：用任意静态文件服务器打开根目录（如 `npx serve .` 或 VS Code Live Server），不需要 Jekyll。

## 目录结构

```
posts/
  manifest.json          # 文章目录（唯一真相来源，驱动导航和角标）
  notes.json             # 独立札记（id 索引，用于 ![[id]] 嵌入）
  <layer>/<slug>.md      # 文章 Markdown
  _drafts/               # 草稿/废弃文件
assets/js/app.js         # SPA 路由 + 渲染引擎
assets/css/style.css     # 样式
index.html               # 入口
```

Layer 与子目录一一对应：`intro / app / orchestration / runtime / model / frontier / interview / career / landscape / distributed`。

## 核心工作流

### 新增体系化文章

1. 新建 `posts/<layer>/<slug>.md`
2. 在 `posts/manifest.json` 的 `posts` 数组里插入一条记录：

```json
{
  "slug": "slug-name",
  "label": "短标签",
  "layer": "orchestration",
  "title": "文章标题",
  "summary": "一段摘要",
  "tags": ["tag1", "tag2"],
  "readingTime": "20 分钟",
  "date": "2026-06"
}
```

**不要写 `order` 字段、不要手动加数字编号**——角标（`00 · 标签`）由 app.js 按数组顺序自动计算。前沿层不占序号。

### 新增前沿条目

1. 新建 `posts/frontier/frontier-YYYY-MM.md`
2. manifest 加一条 `"layer": "frontier"`、带 `date` 字段的记录
3. 角标自动显示日期，同层按日期倒序排列

### 文章内联标注块（callout）

```markdown
:::方法 可选标题
正文，支持 **markdown**。
:::
```

类型只能取：`方法` / `观点` / `启发` / `提醒`（其他视为通用笔记）。由 app.js 的 marked 扩展渲染，不是标准 Markdown 语法。

### 独立札记

在 `posts/notes.json` 的 `notes` 数组加一条：

```json
{
  "id": "unique-id",
  "type": "观点",
  "title": "标题",
  "date": "2026-06",
  "body": "正文，支持 **markdown**。",
  "tags": ["tag"]
}
```

无需创建 `.md` 文件。`id` 用于在文章里引用。

### 在文章里引用札记

在 Markdown 里单独一行写：

```
![[unique-id]]
```

渲染为虚线框卡片 + 「札记 ↗」回链。

## 关键约束（务必遵守）

**单一来源原则**：每条洞见只写在一处。
- 依附某篇文章的观点 → 写成 `:::` callout（自动汇入札记墙，不要重复写进 notes.json）
- 独立的洞见 → 写进 notes.json（需要时用 `![[id]]` 引用）
- **不要两边都写**，否则札记墙 `#/notes` 上会重复出现

**不要手动维护编号**：manifest.json 数组顺序即角标顺序，插入/删除条目后编号自动重算。

**不要修改 loadPost 的路径拼接逻辑**：`app.js` 的 `loadPost` 已按 `post.layer` 自动拼 `posts/<layer>/<slug>.md`，无需手动指定路径。
