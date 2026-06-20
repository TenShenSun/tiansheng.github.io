/* Agent Architect 博客站 —— 纯前端 SPA（hash 路由 + Markdown 渲染） */
(() => {
  "use strict";

  const view = document.getElementById("view");
  const searchEl = document.getElementById("search");
  const yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  let MANIFEST = null;          // { layers: [...], posts: [...] }
  let POSTS = [];               // 扁平文章列表（按 order 排序）
  let NOTES = null;             // 札记列表（按日期倒序）
  const NOTE_INDEX = new Map();  // id -> 札记（供文章内 ![[id]] 引用）
  const CACHE = new Map();      // slug -> markdown 文本

  /* 标注类型：内联 callout（:::方法）与札记卡片共用 */
  const CALLOUT_TYPES = {
    "方法": { cls: "method",  icon: "💡", label: "方法" },
    "观点": { cls: "opinion", icon: "🗣", label: "观点" },
    "启发": { cls: "insight", icon: "✨", label: "启发" },
    "提醒": { cls: "warn",    icon: "⚠️", label: "提醒" },
    "阅读": { cls: "reading", icon: "📖", label: "阅读" },
  };
  const CALLOUT_DEFAULT = { cls: "note", icon: "📌", label: "笔记" };

  /* ---------- 主题 ---------- */
  const themeToggle = document.getElementById("themeToggle");
  const savedTheme = localStorage.getItem("theme");
  function applyTheme(t) {
    document.body.setAttribute("data-theme", t);
    document.getElementById("hljs-dark").disabled  = (t === "light");
    document.getElementById("hljs-light").disabled = (t === "dark");
  }
  applyTheme(savedTheme || "dark");
  themeToggle?.addEventListener("click", () => {
    const next = document.body.getAttribute("data-theme") === "dark" ? "light" : "dark";
    applyTheme(next);
    localStorage.setItem("theme", next);
  });

  /* ---------- 工具 ---------- */
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- 内联标注块 callout ----------
     语法：
       :::方法 可选标题
       正文（支持 markdown）…
       :::
     类型：方法 / 观点 / 启发 / 提醒（其它视为通用笔记）。 */
  function setupMarked() {
    if (!window.marked || window.__calloutReady) return;
    window.__calloutReady = true;
    window.marked.use({
      extensions: [{
        name: "callout",
        level: "block",
        start(src) { const i = src.indexOf(":::"); return i < 0 ? undefined : i; },
        tokenizer(src) {
          const m = /^:::([^\s\n]+)[ \t]*([^\n]*)\n([\s\S]*?)\n:::[ \t]*(?:\n|$)/.exec(src);
          if (!m) return;
          const token = { type: "callout", raw: m[0], ctype: m[1], title: (m[2] || "").trim(), tokens: [] };
          this.lexer.blockTokens(m[3], token.tokens);
          return token;
        },
        renderer(token) {
          const meta = CALLOUT_TYPES[token.ctype] || CALLOUT_DEFAULT;
          const head = token.title || meta.label;
          const inner = this.parser.parse(token.tokens);
          return `<div class="callout callout-${meta.cls}">`
            + `<div class="callout-head"><span class="callout-ico">${meta.icon}</span><span>${esc(head)}</span></div>`
            + `<div class="callout-body">${inner}</div></div>`;
        },
      }, {
        // 引用札记：单独一行 ![[id]] —— 把 notes.json 里的某条札记嵌进正文
        name: "noteembed",
        level: "block",
        start(src) { const i = src.indexOf("![["); return i < 0 ? undefined : i; },
        tokenizer(src) {
          const m = /^!\[\[([^\]\n]+)\]\][ \t]*(?:\n|$)/.exec(src);
          if (!m) return;
          return { type: "noteembed", raw: m[0], id: m[1].trim() };
        },
        renderer(token) {
          const n = NOTE_INDEX.get(token.id);
          if (!n) {
            return `<div class="callout callout-warn callout-embed"><div class="callout-head">`
              + `<span class="callout-ico">⚠️</span><span>未找到札记：${esc(token.id)}</span></div></div>`;
          }
          const meta = CALLOUT_TYPES[n.type] || CALLOUT_DEFAULT;
          const head = n.title || meta.label;
          return `<div class="callout callout-${meta.cls} callout-embed">`
            + `<div class="callout-head"><span class="callout-ico">${meta.icon}</span><span>${esc(head)}</span>`
            + `<a class="callout-ref" href="#/notes">札记 ↗</a></div>`
            + `<div class="callout-body">${n._html || ""}</div></div>`;
        },
      }],
    });
  }
  setupMarked();

  async function loadManifest() {
    if (MANIFEST) return MANIFEST;
    const res = await fetch("./posts/manifest.json", { cache: "no-cache" });
    MANIFEST = await res.json();

    // 按 layers 的声明顺序铺平文章：前沿层按日期倒序，其余层按 manifest 中的书写顺序。
    // 这样加文章只需插进数组，无需手动维护 order/编号。
    POSTS = MANIFEST.layers.flatMap((layer) => {
      const items = MANIFEST.posts.filter((p) => p.layer === layer.id);
      if (layer.id === "frontier") {
        items.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
      }
      return items;
    });

    // 自动生成角标编号：前沿层用日期（如 2026.05），其余层按出现顺序生成 00 / 01 …
    let seq = 0;
    for (const p of POSTS) {
      const label = p.label ? ` · ${p.label}` : "";
      if (p.layer === "frontier") {
        p.code = `${String(p.date || "").replace(/-/g, ".")}${label}`;
      } else {
        p.code = `${String(seq).padStart(2, "0")}${label}`;
        seq++;
      }
    }
    return MANIFEST;
  }

  async function loadPost(slug) {
    if (CACHE.has(slug)) return CACHE.get(slug);
    const post = POSTS.find((p) => p.slug === slug);
    const path = post ? `./posts/${post.layer}/${slug}.md` : `./posts/${slug}.md`;
    const res = await fetch(path, { cache: "no-cache" });
    if (!res.ok) throw new Error("not found");
    const md = await res.text();
    CACHE.set(slug, md);
    return md;
  }

  async function loadNotes() {
    if (NOTES) return NOTES;
    const res = await fetch("./posts/notes.json", { cache: "no-cache" });
    const data = await res.json();
    // 自动按日期倒序，无需手动维护顺序/编号
    NOTES = [...(data.notes || [])].sort((a, b) =>
      String(b.date || "").localeCompare(String(a.date || "")));
    // 建立 id 索引并预渲染正文，供文章内 ![[id]] 同步引用
    NOTE_INDEX.clear();
    for (const n of NOTES) {
      n._html = window.marked ? window.marked.parse(n.body || "") : `<p>${esc(n.body || "")}</p>`;
      if (n.id) NOTE_INDEX.set(n.id, n);
    }
    return NOTES;
  }

  function setActiveNav(name) {
    document.querySelectorAll(".topnav a").forEach((a) =>
      a.classList.toggle("active", a.dataset.nav === name));
  }

  /* ---------- 首页 ---------- */
  async function renderHome() {
    setActiveNav("home");
    await loadManifest();
    const tags = [...new Set(POSTS.flatMap((p) => p.tags || []))].slice(0, 10);

    const layersHtml = MANIFEST.layers.filter((layer) => !layer.menu).map((layer) => {
      const items = POSTS.filter((p) => p.layer === layer.id);
      if (!items.length) return "";
      return `
        <div class="layer">
          <div class="layer-bar">
            <h3>${esc(layer.name)}</h3>
            <span class="layer-en">${esc(layer.en)}</span>
          </div>
          <p class="section-sub">${esc(layer.desc)}</p>
          <div class="grid">${items.map(cardHtml).join("")}</div>
        </div>`;
    }).join("");

    view.innerHTML = `
      <section class="hero">
        <div class="hero-inner">
          <div class="eyebrow">Full-Stack Agent Engineering</div>
          <h1>全栈智能体架构博客<br/>从原理到端到端应用落地</h1>
          <p class="lead">一个资深 Agent 架构师的系统性技术博客。长期工作在大模型与智能体系统的第一线——做过应用、写过编排、调过 Harness、读过模型。</p>
          <div class="hero-pillars">
            <div class="pillar"><span class="pillar-label">应用层</span><span class="pillar-desc">Chatbot 落地 · 风控与 Guardrails · 增长体系 · AIGC 工程</span></div>
            <div class="pillar"><span class="pillar-label">编排层</span><span class="pillar-desc">ReAct / Multi-Agent · 上下文工程 · 工具调用与 MCP</span></div>
            <div class="pillar"><span class="pillar-label">运行时</span><span class="pillar-desc">Harness 设计 · Agent Loop · 评测与可观测性</span></div>
            <div class="pillar"><span class="pillar-label">模型层</span><span class="pillar-desc">Transformer · 后训练与对齐 · 推理优化与部署</span></div>
          </div>
          <p class="lead-sub">每篇文章尽量做到：讲清原理 → 对照 Anthropic / OpenAI / Manus 等一线案例 → 给出可落地的工程方案。另有大佬访谈纪要、面试双向复盘与前沿追踪，记录判断，不只搬运。</p>
          <div class="stack-tags">
            ${tags.map((t) => `<span>${esc(t)}</span>`).join("")}
          </div>
        </div>
      </section>
      <div class="wrap">
        <section class="section">
          <div class="section-head"><h2>技术栈分层 · 系列文章</h2><span class="count">${POSTS.length} 篇</span></div>
          <p class="section-sub">按"应用层 → 编排层 → 运行时层 → 模型层"自上而下组织，每一层都给出原理推导、业界对照案例与可落地的工程方案。</p>
          ${layersHtml}
        </section>
      </div>`;
    bindCards();
    window.scrollTo(0, 0);
  }

  function cardHtml(p) {
    return `
      <div class="card" data-slug="${esc(p.slug)}">
        <div class="num">${esc(p.code || "")}</div>
        <h4>${esc(p.title)}</h4>
        <p>${esc(p.summary)}</p>
        <div class="meta">
          ${(p.tags || []).slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}
          ${p.source ? (p.sourceUrl
            ? `<a class="source" href="${esc(p.sourceUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">via ${esc(p.source)}</a>`
            : `<span class="source">via ${esc(p.source)}</span>`) : ""}
          <span class="read">${esc(p.readingTime || "")}</span>
        </div>
      </div>`;
  }

  function bindCards() {
    document.querySelectorAll(".card").forEach((c) =>
      c.addEventListener("click", () => { location.hash = `#/post/${c.dataset.slug}`; }));
  }

  /* ---------- 系列页（目录） ---------- */
  async function renderSeries() {
    setActiveNav("series");
    await loadManifest();
    const seriesLayers = MANIFEST.layers.filter((l) => !l.menu);
    const list = seriesLayers.map((layer) => {
      const items = POSTS.filter((p) => p.layer === layer.id);
      if (!items.length) return "";
      return `
        <div class="layer">
          <div class="layer-bar"><h3>${esc(layer.name)}</h3><span class="layer-en">${esc(layer.en)}</span></div>
          <div class="grid">${items.map(cardHtml).join("")}</div>
        </div>`;
    }).join("");
    const seriesCount = POSTS.filter((p) => seriesLayers.some((l) => l.id === p.layer)).length;
    view.innerHTML = `<div class="wrap"><section class="section">
      <div class="section-head"><h2>完整系列目录</h2><span class="count">${seriesCount} 篇</span></div>
      <p class="section-sub">点击任意卡片进入文章。建议按顺序阅读，也可按需跳读。</p>
      ${list}</section></div>`;
    bindCards();
    window.scrollTo(0, 0);
  }

  /* ---------- 面试页 ---------- */
  async function renderInterview() {
    setActiveNav("interview");
    await loadManifest();
    const html = MANIFEST.layers
      .filter((l) => l.menu === "interview")
      .map((layer) => {
        const items = POSTS.filter((p) => p.layer === layer.id);
        if (!items.length) return "";
        return `
          <div class="layer">
            <div class="layer-bar">
              <h3>${esc(layer.name)}</h3>
              <span class="layer-en">${esc(layer.en)}</span>
            </div>
            <p class="section-sub">${esc(layer.desc)}</p>
            <div class="grid">${items.map(cardHtml).join("")}</div>
          </div>`;
      }).join("");
    const total = POSTS.filter((p) => MANIFEST.layers.some((l) => l.menu === "interview" && l.id === p.layer)).length;
    view.innerHTML = `<div class="wrap"><section class="section">
      <div class="section-head"><h2>面试备战</h2><span class="count">${total} 篇</span></div>
      ${html}
    </section></div>`;
    bindCards();
    window.scrollTo(0, 0);
  }

  /* ---------- AI落地场景页 ---------- */
  async function renderLandscape() {
    setActiveNav("landscape");
    await loadManifest();
    const html = MANIFEST.layers
      .filter((l) => l.menu === "landscape")
      .map((layer) => {
        const items = POSTS.filter((p) => p.layer === layer.id);
        if (!items.length) return "";
        return `
          <div class="layer">
            <div class="layer-bar">
              <h3>${esc(layer.name)}</h3>
              <span class="layer-en">${esc(layer.en)}</span>
            </div>
            <p class="section-sub">${esc(layer.desc)}</p>
            <div class="grid">${items.map(cardHtml).join("")}</div>
          </div>`;
      }).join("");
    const total = POSTS.filter((p) => MANIFEST.layers.some((l) => l.menu === "landscape" && l.id === p.layer)).length;
    view.innerHTML = `<div class="wrap"><section class="section">
      <div class="section-head"><h2>AI落地场景</h2><span class="count">${total} 篇</span></div>
      <p class="section-sub">拆解市面上真实 AI 产品的落地逻辑：场景选择、产品形态、技术路径与商业模式——什么方向在跑通，什么方向在踩坑。</p>
      ${html || `<div class="empty">文章准备中，敬请期待。</div>`}
    </section></div>`;
    bindCards();
    window.scrollTo(0, 0);
  }

  /* ---------- 关于页 ---------- */
  async function renderAbout() {
    setActiveNav("about");
    await loadManifest();
    view.innerHTML = `<div class="about">
      <div class="eyebrow">About</div>
      <h1>关于作者</h1>
      <div class="profile-card">
        <p>资深 <b>Agent 架构师</b>，长期工作在大模型与智能体系统的第一线。研究与实践横跨完整技术栈：</p>
        <p class="muted">Agent 应用层（对话产品、内容风控、增长体系、AIGC 工程） → Agent 编排（多智能体协作、规划与记忆） → Agent 运行时（Harness 设计、工具调用、MCP） → 模型底层（架构、后训练、推理优化）。</p>
        <div class="skills">
          <div class="skill"><b>应用 & 风控</b><span>对话产品、Prompt 注入防御、内容安全、Guardrails、合规</span></div>
          <div class="skill"><b>增长 & AIGC</b><span>AARRR、留存飞轮、多模态生成、RAG、内容质量</span></div>
          <div class="skill"><b>Agent 编排</b><span>ReAct / Plan-Execute、Multi-Agent、上下文工程、记忆</span></div>
          <div class="skill"><b>运行时 & Harness</b><span>Agent Loop、工具沙箱、MCP、评测与可观测性</span></div>
          <div class="skill"><b>模型底层</b><span>Transformer、注意力、RLHF/DPO、对齐、推理加速</span></div>
          <div class="skill"><b>生态对照</b><span>Anthropic、OpenAI、Google、阿里云、Manus、开源社区</span></div>
        </div>
      </div>
      <p>这个系列博客记录我对"如何把一个想法做成可靠、可规模化、安全合规的 Agent 系统"的完整思考路径。每篇文章尽量做到：<b>讲清原理 → 对照业界标杆案例 → 给出可落地的工程方案</b>。</p>
      <p>欢迎从 <a href="#/series">系列目录</a> 开始阅读。</p>
    </div>`;
    window.scrollTo(0, 0);
  }

  /* ---------- 札记页（方法 / 观点 / 启发 卡片墙） ----------
     单一来源：独立卡片来自 notes.json，文章内的 ::: 标注自动汇集进来（带回链）。
     同一句话只在一处写。 */
  const CALLOUT_RX = /^:::([^\s\n]+)[ \t]*([^\n]*)\n([\s\S]*?)\n:::[ \t]*$/gm;

  async function collectNotes() {
    await loadManifest();
    const standalone = (await loadNotes()).map((n) => ({ ...n, source: null }));
    // 从所有文章 markdown 里汇集内联 callout（loadPost 带缓存，重复访问不重新请求）
    const perPost = await Promise.all(POSTS.map(async (p) => {
      let md;
      try { md = await loadPost(p.slug); } catch { return []; }
      const rx = new RegExp(CALLOUT_RX.source, "gm");   // 每篇独立实例，避免 lastIndex 串扰
      const out = [];
      let m;
      while ((m = rx.exec(md))) {
        out.push({
          type: m[1], title: (m[2] || "").trim(), body: m[3],
          date: p.date || "", source: { slug: p.slug, title: p.title },
        });
      }
      return out;
    }));
    return [...standalone, ...perPost.flat()]
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  }

  async function renderNotes() {
    setActiveNav("notes");
    const notes = await collectNotes();
    const cards = notes.map(noteCardHtml).join("");
    view.innerHTML = `<div class="wrap"><section class="section">
      <div class="section-head"><h2>札记 · 方法与观点</h2><span class="count">${notes.length} 条</span></div>
      <p class="section-sub">实验方法、概念提示与个人观点——给自己提示，也给读者启发。独立卡片来自 notes.json，文章里的 <code>:::</code> 标注会自动汇集到这里（带回链）。按时间倒序。</p>
      <div class="grid notes-grid">${cards || `<div class="empty">还没有札记。</div>`}</div>
    </section></div>`;
    window.scrollTo(0, 0);
  }

  function noteCardHtml(n) {
    const meta = CALLOUT_TYPES[n.type] || CALLOUT_DEFAULT;
    const body = window.marked ? window.marked.parse(n.body || "") : `<p>${esc(n.body || "")}</p>`;
    const tags = (n.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
    const src = n.source
      ? `<a class="note-src" href="#/post/${esc(n.source.slug)}">→ 出自《${esc(n.source.title)}》</a>`
      : "";
    return `
      <div class="card note-card note-${meta.cls}">
        <div class="num"><span class="callout-ico">${meta.icon}</span>${esc(n.type || meta.label)} · ${esc(n.date || "")}</div>
        ${n.title ? `<h4>${esc(n.title)}</h4>` : ""}
        <div class="note-body">${body}</div>
        ${tags ? `<div class="meta">${tags}</div>` : ""}
        ${src}
      </div>`;
  }

  /* ---------- 文章页 ---------- */
  async function renderPost(slug) {
    setActiveNav("series");
    await loadManifest();
    await loadNotes();   // 预载札记索引，让正文里的 ![[id]] 能同步解析
    const idx = POSTS.findIndex((p) => p.slug === slug);
    const post = POSTS[idx];
    if (!post) { view.innerHTML = `<div class="empty">未找到该文章。<a href="#/">返回首页</a></div>`; return; }

    let md;
    try { md = await loadPost(slug); }
    catch { view.innerHTML = `<div class="empty">文章加载失败。请通过本地服务器访问（见 README）。<br/><a href="#/">返回首页</a></div>`; return; }

    // 去掉 markdown 顶部的一级标题（用元数据渲染）
    const body = md.replace(/^#\s+.*\n+/, "");
    const html = window.marked ? window.marked.parse(body) : `<pre>${esc(body)}</pre>`;

    const prev = POSTS[idx - 1];
    const next = POSTS[idx + 1];
    view.innerHTML = `
      <div class="article-layout">
        <article class="article">
          <a class="back" href="#/series">← 返回系列目录</a>
          <div class="post-meta">
            <span>${esc(post.code || "")}</span>
            <span>${esc(post.readingTime || "")}</span>
            <span>${esc(post.date || "")}</span>
          </div>
          <h1>${esc(post.title)}</h1>
          <div class="post-tags">${(post.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
          <div class="article-body">${html}</div>
          <nav class="post-nav">
            ${prev ? `<a href="#/post/${esc(prev.slug)}"><div class="dir">← 上一篇</div><div class="ttl">${esc(prev.title)}</div></a>` : `<span style="flex:1"></span>`}
            ${next ? `<a class="next" href="#/post/${esc(next.slug)}"><div class="dir">下一篇 →</div><div class="ttl">${esc(next.title)}</div></a>` : `<span style="flex:1"></span>`}
          </nav>
        </article>
        <aside class="toc"><button class="toc-toggle-btn" id="tocToggle" title="点击收起 / 拖动调宽"><span class="toc-btn-arrow">›</span><span class="toc-btn-text">收起</span></button><div class="toc-content"><div class="toc-title">本页目录</div><div id="tocList"></div></div></aside>
      </div>`;

    // 代码高亮
    if (window.hljs) document.querySelectorAll(".article-body pre code").forEach((b) => window.hljs.highlightElement(b));
    buildToc();
    const layout = document.querySelector(".article-layout");
    const tocToggle = document.getElementById("tocToggle");
    const toc = document.querySelector(".toc");
    const getTocWidth = () => +localStorage.getItem("tocWidth") || 360;
    const setGrid = (w) => { layout.style.gridTemplateColumns = `minmax(0, 960px) ${w}px`; };
    if (layout) setGrid(getTocWidth());
    // 折叠 / 展开
    if (tocToggle) {
      tocToggle.addEventListener("click", () => {
        const hidden = layout.classList.toggle("toc-hidden");
        if (hidden) {
          layout.style.gridTemplateColumns = `minmax(0, 960px) 26px`;
          layout.style.gap = "12px";
        } else {
          setGrid(getTocWidth());
          layout.style.gap = "";
        }
        tocToggle.querySelector(".toc-btn-arrow").textContent = hidden ? "‹" : "›";
        tocToggle.querySelector(".toc-btn-text").textContent = hidden ? "展开" : "收起";
      });
    }
    // 左边缘拖拽调宽（30px 热区）
    if (toc && layout) {
      toc.addEventListener("mousemove", (e) => {
        toc.style.cursor = e.clientX < toc.getBoundingClientRect().left + 30 ? "ew-resize" : "";
      });
      toc.addEventListener("mouseleave", () => { toc.style.cursor = ""; });
      toc.addEventListener("mousedown", (e) => {
        if (e.clientX >= toc.getBoundingClientRect().left + 30) return;
        let dragged = false;
        const startX = e.clientX;
        const startW = getTocWidth();
        layout.style.transition = "none";
        document.body.style.userSelect = "none";
        const onMove = (mv) => {
          if (!dragged && Math.abs(mv.clientX - startX) > 4) dragged = true;
          if (dragged) {
            document.body.style.cursor = "ew-resize";
            setGrid(Math.max(160, Math.min(560, startW + startX - mv.clientX)));
          }
        };
        const onUp = () => {
          layout.style.transition = "";
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
          if (dragged) {
            localStorage.setItem("tocWidth", parseFloat(layout.style.gridTemplateColumns.split(" ").pop()));
            if (e.target === tocToggle || tocToggle.contains(e.target)) {
              tocToggle.addEventListener("click", (ev) => ev.stopImmediatePropagation(), { once: true, capture: true });
            }
          }
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        e.preventDefault();
      });
    }
    window.scrollTo(0, 0);
  }

  function buildToc() {
    const body = document.querySelector(".article-body");
    const tocList = document.getElementById("tocList");
    if (!body || !tocList) return;
    const heads = body.querySelectorAll("h2, h3");
    const links = [];
    heads.forEach((h, i) => {
      const id = "h-" + i;
      h.id = id;
      const a = document.createElement("a");
      a.href = `#${id}`;
      a.textContent = h.textContent;
      if (h.tagName === "H3") a.className = "h3";
      a.addEventListener("click", (e) => { e.preventDefault(); h.scrollIntoView({ behavior: "smooth" }); });
      tocList.appendChild(a);
      links.push({ a, el: h });
    });
    // 滚动高亮
    const onScroll = () => {
      let cur = links[0];
      for (const l of links) { if (l.el.getBoundingClientRect().top < 120) cur = l; }
      links.forEach((l) => l.a.classList.toggle("active", l === cur));
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  /* ---------- 搜索 ---------- */
  async function renderSearch(q) {
    await loadManifest();
    const k = q.trim().toLowerCase();
    const hits = POSTS.filter((p) =>
      [p.title, p.summary, (p.tags || []).join(" ")].join(" ").toLowerCase().includes(k));
    view.innerHTML = `<div class="wrap"><section class="section">
      <div class="section-head"><h2>搜索：“${esc(q)}”</h2><span class="count">${hits.length} 篇</span></div>
      ${hits.length ? `<div class="grid">${hits.map(cardHtml).join("")}</div>` : `<div class="empty">没有匹配的文章。</div>`}
    </section></div>`;
    bindCards();
  }

  let searchTimer = null;
  searchEl?.addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value;
    searchTimer = setTimeout(() => {
      if (q.trim()) renderSearch(q);
      else router();
    }, 180);
  });

  /* ---------- 路由 ---------- */
  async function router() {
    const hash = location.hash || "#/";
    try {
      if (hash.startsWith("#/post/")) return await renderPost(decodeURIComponent(hash.slice(7)));
      if (hash.startsWith("#/series")) return await renderSeries();
      if (hash.startsWith("#/interview")) return await renderInterview();
      if (hash.startsWith("#/landscape")) return await renderLandscape();
      if (hash.startsWith("#/notes")) return await renderNotes();
      if (hash.startsWith("#/about")) return await renderAbout();
      return await renderHome();
    } catch (err) {
      view.innerHTML = `<div class="empty">页面加载出错：${esc(err.message)}<br/>请确认通过本地服务器访问（见 README）。</div>`;
    }
  }

  window.addEventListener("hashchange", router);
  router();
})();