# Chatbot 标注平台工程：从用例管理到数据飞轮的系统设计

:::观点 评测体系的天花板是标注平台的地基质量
LLM-as-Judge 再准确，也只是在测量"和人工标准的偏差"。人工标准存在哪里——存在标注平台里。标注平台的设计质量决定了整套质量体系的可信度上限：用例管理得混乱，回归就是噪声；标注规范不统一，LLM-judge 就失去校准锚点；case 回流做不好，飞轮就是单向的。
:::

Chatbot 标注平台不只是一个"给人工标注员用的工具"，而是连接**生产流量 → 质量判断 → 系统改进**的数据中枢。本文从产品定位、系统架构、各模块设计到案例全链路，给出一套可以真正落地的工程方案，并参照 Scale AI、Label Studio、Argilla、Langfuse、Braintrust 等主流平台的实践。

---

## 一、定位：标注平台在 Chatbot 工程体系中是什么角色

### 1.1 不是工具，是数据中枢

```
生产系统（Chatbot 服务）
        │ 会话日志 + 用户行为信号
        ▼
┌──────────────────────────────────┐
│        标注平台（本文重点）        │
│                                  │
│  环境管理 → 场景/用例管理         │
│  数据标注 → 黄金集管理            │
│  case 导入 → case 回流           │
│  数据集 API（对外服务）           │
└──────────────────────────────────┘
        │ 黄金数据集 + 标注结果
        ▼
评测层（eval 脚本 + CI 门控）
        │ 优化方向
        ▼
优化层（Prompt / 知识库 / 微调）
        │ 改进后的系统
        └──────────────────────→ 生产系统（闭环）
```

标注平台处于这个闭环的核心位置——它接收来自生产系统的原始数据，经过场景分类、质量标注、黄金集管理，最终输出可信的评测基准和训练信号。

### 1.2 平台要解决的五个核心问题

| 问题 | 如果没解决的代价 |
|---|---|
| **数据管理混乱** | 不同版本、不同环境的数据混在一起，评测结论无法归因 |
| **场景覆盖靠感觉** | 核心场景重复测、边界场景从没测，黄金集是幻觉 |
| **标注不一致** | 标注员 A 和 B 的标准不一样，judge 校准失去意义 |
| **黄金集静态腐化** | 产品迭代了，黄金集还在测旧行为，通过率高 = 测错了 |
| **生产问题无法回流** | 线上发现的 bad case 沉在日志里，下次还会出同样的问题 |

---

## 二、系统架构

### 2.1 整体模块划分

```
┌─────────────────────────────────────────────────────────────────┐
│                        标注平台                                   │
│                                                                   │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────────────┐ │
│  │  环境 & 数据集  │  │  场景 & 用例   │  │     标注工作台        │ │
│  │  管理模块      │  │  管理模块      │  │                       │ │
│  │               │  │               │  │  ·人工标注             │ │
│  │  ·环境隔离     │  │  ·场景树       │  │  ·LLM 辅助标注        │ │
│  │  ·数据集版本   │  │  ·用例 CRUD    │  │  ·规则快速过滤        │ │
│  │  ·数据血缘     │  │  ·批量导入     │  │  ·标注规范管理        │ │
│  └───────────────┘  └───────────────┘  └───────────────────────┘ │
│                                                                   │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────────────┐ │
│  │  黄金集管理   │  │   case 回流   │  │  数据集 API & 集成     │ │
│  │               │  │               │  │                       │ │
│  │  ·晋升审核    │  │  ·生产信号接收 │  │  ·REST API             │ │
│  │  ·版本控制    │  │  ·自动分流     │  │  ·SDK（Python/JS）    │ │
│  │  ·腐化检测    │  │  ·优先级队列   │  │  ·Webhook 推送        │ │
│  └───────────────┘  └───────────────┘  └───────────────────────┘ │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                     数据存储层                               │ │
│  │  案例库（PostgreSQL）| 向量索引（重复检测）| 文件存储（对话轨迹）│ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 数据模型核心实体

```
Environment（环境）
    │ 1:N
Dataset（数据集）
    │ 1:N
TestCase（用例）
    ├── input（用户输入）
    ├── context（对话历史、检索结果）
    ├── expected_output（期望输出，可选）
    ├── expected_slots（期望槽位）
    ├── expected_tool_calls（期望工具调用）
    ├── scenario_tags（场景标签）
    ├── annotations[]（标注列表）
    │       ├── annotator_id
    │       ├── scores（各维度分数）
    │       ├── label（正面/负面/待定）
    │       └── notes
    ├── golden_status（candidate / golden / deprecated）
    └── provenance（来源：生产回流 / 人工构造 / 导入）
```

---

## 三、环境与数据集管理

### 3.1 为什么要环境隔离

生产中同时存在多个不同状态的 Chatbot 系统——不同的 prompt 版本、不同的知识库、不同的模型——对应数据必须隔离，否则评测结论会因为"数据混用"而失去意义。

| 环境类型 | 用途 | 数据特征 |
|---|---|---|
| **production** | 线上真实流量 | 大量、未标注、噪声高 |
| **staging** | 灰度/实验版本 | 中量、部分标注 |
| **golden** | 质量基准 | 小而精、全量标注、版本化 |
| **experiment** | A/B 实验 | 按实验 ID 隔离 |
| **shadow** | 新模型影子测试 | 和 production 同输入，新模型输出 |

### 3.2 数据集版本管理

参考 Git 的思路，每个数据集有完整的版本历史：

```
Dataset: customer-service-golden
├── v1.0.0  (2026-03-01)  初始版本，50 条
├── v1.1.0  (2026-04-10)  +30 条回归 case，修复 3 条过时标注
├── v1.2.0  (2026-05-20)  新增退款场景覆盖，+20 条
└── v2.0.0  (2026-06-01)  产品重构后的完整重建版本
```

每个版本记录：
- **diff**：新增 / 修改 / 废弃的 case 列表
- **reason**：版本升级的原因（产品变更 / bug 修复 / 场景扩充）
- **eval baseline**：该版本对应的 eval 分数基线
- **immutable**：打 tag 后的版本不可修改，只能创建新版本

:::方法 版本命名约定
Major.Minor.Patch 三段式：Major 升级 = 产品重大变更，旧版本评测结论不可比；Minor 升级 = 场景扩充，前向兼容；Patch = 标注修正，不影响覆盖维度。建议在 CI 里用 Patch/Minor 版本做日常回归，Major 升级后需要人工 review 基线。
:::

### 3.3 数据血缘追踪

每条 case 记录完整的来源链，支持追溯和审计：

```json
{
  "case_id": "tc_2026060312345",
  "provenance": {
    "source": "production_feedback",
    "session_id": "prod_sess_abcd1234",
    "trigger": "user_thumbs_down",
    "collected_at": "2026-06-03T10:22:00Z",
    "ingestion_pipeline": "feedback-collector-v2"
  },
  "processing_history": [
    { "stage": "dedup_check", "result": "unique", "ts": "2026-06-03T10:22:05Z" },
    { "stage": "auto_classification", "scenario": "退款申请", "confidence": 0.91 },
    { "stage": "llm_prescoring", "scores": {"relevance": 2.1, "safety": 4.8} },
    { "stage": "human_annotation", "annotator": "ann_007", "completed_at": "2026-06-03T14:00:00Z" },
    { "stage": "golden_promotion", "promoted_at": "2026-06-04T09:00:00Z", "reviewer": "eng_012" }
  ]
}
```

---

## 四、场景与用例管理

### 4.1 场景树结构

场景（Scenario）是用例的组织单元，采用**两级层次**——不要超过三级，太深的层次结构维护成本极高：

```
场景树
├── 核心业务场景
│   ├── 订单查询
│   │   ├── 标准查询（有订单号）
│   │   ├── 模糊查询（无订单号）
│   │   └── 批量查询（多订单号）
│   ├── 退款申请
│   │   ├── 单品退款
│   │   ├── 全单退款
│   │   └── 退款进度查询
│   └── 物流查询
├── 边界场景
│   ├── 极短输入（< 5 字）
│   ├── 极长输入（> 500 字）
│   ├── 纯 emoji / 特殊字符
│   └── 多语言混合
├── 安全场景
│   ├── Prompt 注入
│   ├── 越权访问
│   └── 敏感内容
└── 回归场景（自动生成，每个 bug 对应一条）
```

### 4.2 用例的完整字段

```json
{
  "id": "tc_20260603_001",
  "title": "退货申请-有订单号-质量问题",
  "scenario": ["核心业务场景", "退款申请", "单品退款"],
  "priority": "P0",
  "input": "订单号 2025060312，商品质量太差了，我要退货",
  "conversation_history": [],
  "context": {
    "user_id": "masked_user_001",
    "session_id": "sess_abc123"
  },
  "expected": {
    "intent": "退货申请",
    "slots": {
      "order_id": "2025060312",
      "reason": "质量问题"
    },
    "tool_calls": ["query_order_status", "initiate_return"],
    "should_escalate": false,
    "should_confirm_before_action": true,
    "output_criteria": [
      "必须在执行退货前二次确认",
      "回复中需包含退货所需的下一步操作说明",
      "不能在未查询订单状态前直接发起退货"
    ]
  },
  "tags": ["退货", "质量问题", "写操作"],
  "golden_status": "golden",
  "added_reason": "高频退货核心场景",
  "bug_ref": null,
  "created_at": "2026-06-01T09:00:00Z",
  "last_reviewed_at": "2026-06-03T10:00:00Z"
}
```

### 4.3 用例的批量导入

支持三种导入方式：

**方式一：CSV/JSON 结构化导入**

```python
# SDK 示例
from annotation_platform import AnnotationClient

client = AnnotationClient(api_key="...")
dataset = client.dataset("customer-service-v2")

# 从 JSON 文件批量导入
cases = dataset.import_cases(
    file="cases_batch_001.json",
    scenario_mapping={
        "order_query": ["核心业务场景", "订单查询"],
        "refund_apply": ["核心业务场景", "退款申请"]
    },
    dedup_strategy="skip",        # skip / merge / overwrite
    validation=True               # 导入前校验 schema
)
print(f"导入成功 {cases.imported} 条，跳过重复 {cases.skipped} 条")
```

**方式二：从生产日志直接导入**

```python
# 从日志系统拉取指定时间窗口的会话
dataset.import_from_production(
    time_range=("2026-06-01", "2026-06-03"),
    filters={
        "user_signal": "thumbs_down",      # 只拉用户踩的
        "min_turns": 2,                     # 至少 2 轮对话
        "scenario_confidence_min": 0.7      # 自动分类置信度 > 0.7
    },
    max_cases=500,
    auto_prescore=True             # 导入后自动触发 LLM 预打分
)
```

**方式三：从 Postman/Swagger 测试用例转换**

对于有 API 测试用例的团队，可以直接转换现有的测试 case：

```python
dataset.import_from_postman(
    collection_file="chatbot_api_tests.postman_collection.json",
    endpoint_filter="/api/chat",
    transform_fn=my_custom_transform   # 自定义转换逻辑
)
```

### 4.4 用例去重策略

批量导入时的去重是一个真实工程问题——语义相似但表达不同的 case 会消耗标注资源、稀释黄金集价值：

```python
def dedup_strategy(new_case, existing_cases):
    # 1. 精确匹配（hash）：直接跳过
    if hash(new_case.input) in existing_hashes:
        return "skip"
    
    # 2. 向量相似度（cosine > 0.95）：提示人工确认
    similar = find_similar(new_case, existing_cases, threshold=0.95)
    if similar:
        return "review", similar  # 推入人工 review 队列
    
    # 3. 无重复：正常入库
    return "insert"
```

:::提醒 去重阈值是个权衡点
阈值设太高（> 0.98）：大量语义相似但表达不同的 case 都进库，冗余多；阈值设太低（< 0.90）：真正不同的 case 被误判为重复而跳过。建议 0.93–0.95 区间，加人工确认而不是自动丢弃。
:::

---

## 五、数据标注

### 5.1 标注工作台的设计

标注工作台是标注员的主要界面，设计目标是**减少认知负担、提升标注速度和一致性**。

核心界面模块：

```
┌─────────────────────────────────────────────────────────┐
│  用例详情                              [场景] 退款申请   │
│                                                         │
│  用户输入：订单号 2025001，质量太差，要退货             │
│                                                         │
│  ─────── 机器人实际输出 ───────                         │
│  好的，我来帮您查询订单 2025001 的详情。                 │
│  查询结果：手机一台，下单日期 2026-05-01，已收货。       │
│  请问您确认要申请退货吗？                               │
│                                                         │
│  ─────── 标注维度 ───────                               │
│  意图识别    ○ 正确  ○ 部分正确  ○ 错误                 │
│  槽位提取    ○ 正确  ○ 部分正确  ○ 错误                 │
│  工具调用    ○ 符合预期  ○ 不符合                       │
│  回复质量    ★★★★☆ (4/5)                               │
│  安全合规    ○ 通过  ○ 有风险                           │
│                                                         │
│  标注备注：[文本框]                                      │
│                                                         │
│  ─────── 快捷操作 ───────                               │
│  [推荐晋升黄金集]  [需修复]  [废弃]  [下一条 →]         │
└─────────────────────────────────────────────────────────┘
```

**设计原则**：
- 维度打分粒度不要太细（5 分制而非 10 分制），减少标注员的决策疲劳
- 常见选项用快捷键绑定（A=正确，S=部分正确，D=错误）
- 每屏只显示一条 case，减少干扰

### 5.2 三种标注模式的配合

**模式一：LLM 预打分 + 人工确认（主力模式）**

LLM 先跑一遍，给出预打分和分析，人工在此基础上确认或修改：

```python
def llm_prescore(case: TestCase) -> PreScore:
    prompt = f"""
    你是一个 Chatbot 质量评审员。评估下面这个对话的质量。

    用户输入：{case.input}
    期望行为：{case.expected.output_criteria}
    机器人实际输出：{case.actual_output}
    
    请按以下维度评分（0-5），并说明理由：
    - 意图识别准确性
    - 槽位提取完整性  
    - 工具调用合理性
    - 回复质量
    - 安全合规性
    
    输出 JSON，格式：{{"scores": {...}, "reasoning": "...", "suggested_action": "promote/fix/discard"}}
    """
    return call_judge_llm(prompt)
```

人工标注员看到的是：LLM 的预打分 + 理由，可以快速确认或纠正，而不是从零开始判断。**实测可以把单条 case 的标注时间从 5 分钟降到 1-2 分钟。**

**模式二：规则快速过滤（前置清洗）**

在进入人工标注队列之前，先用规则过滤掉明显的问题 case：

```python
def rule_based_filter(case: TestCase) -> FilterResult:
    # 安全合规：关键词黑名单
    if any(word in case.actual_output for word in FORBIDDEN_WORDS):
        return FilterResult(action="escalate", reason="安全红线")
    
    # 格式校验：期望 JSON 输出但实际不是 JSON
    if case.expected.output_format == "json":
        if not is_valid_json(case.actual_output):
            return FilterResult(action="label_bad", reason="格式错误", auto_score={"format": 0})
    
    # 长度异常：输出过短（可能是拒答或报错）
    if len(case.actual_output) < 20:
        return FilterResult(action="review", reason="输出过短")
    
    return FilterResult(action="pass")
```

规则过滤的 case 不需要进人工标注队列，直接打标签入库，节省人工资源。

**模式三：人工全量标注（黄金集建设专用）**

对于要进黄金集的 case，要求两名标注员独立打分，再做一致性检验：

```python
def annotate_for_golden(case_id: str, annotators: list[str]):
    results = []
    for annotator in annotators:
        result = assign_to_annotator(case_id, annotator)
        results.append(result)
    
    # 检查一致性
    kappa = compute_cohen_kappa(results[0].scores, results[1].scores)
    
    if kappa >= 0.7:
        # 一致性高：取平均分
        final_score = average_scores(results)
        mark_ready_for_promotion(case_id, final_score)
    else:
        # 一致性低：推入仲裁队列
        push_to_arbitration(case_id, results, kappa)
```

### 5.3 标注规范管理

标注规范是平台里最容易被忽视但最重要的模块——规范不在系统里，标注质量就无法保证。

每个场景对应一份标注规范，版本化管理：

```markdown
# 退款申请场景标注规范 v1.2

## 意图识别（正确的标准）
- "退货"、"换货"、"不想要了" → 退款申请
- "退款进度"、"退款到账了吗" → 退款进度查询（不同意图）
- 同时提到退款和投诉 → 标注为组合意图，两个都打标

## 槽位提取（完整性判断）
- order_id：10 位纯数字，必须精确提取，不允许截断或误填时间数字
- reason：质量问题/不喜欢/尺寸不合适 等，允许语义归类
- 容忍：用户表达不完整时 order_id 可以为 null，此时期望行为是追问

## 回复质量评分标准
- 5 分：准确识别意图、查询了订单状态、二次确认后才执行、回复完整说明下一步
- 3-4 分：意图正确但遗漏二次确认，或回复不够清晰
- 1-2 分：未查订单直接执行，或拒答，或答非所问
- 0 分：幻觉（编造了不存在的订单信息）

## 不允许晋升黄金集的情况
- 标注员之间有分歧且无法收敛
- 期望输出本身有歧义（产品定义不清晰）
- 该场景的标注规范尚未确认
```

---

## 六、黄金数据集管理

### 6.1 晋升流程：从普通 case 到黄金 case

普通 case（candidate）不会自动成为黄金 case，必须经过明确的晋升审核：

```
candidate（初始状态）
        │
        │ 满足晋升条件：
        │   ·至少 2 名标注员打分
        │   ·Cohen's kappa ≥ 0.7
        │   ·关键维度均分 ≥ 3.5（或明确的 bad case）
        │   ·符合当前标注规范版本
        ▼
review_pending（等待工程师 review）
        │
        │ 工程师确认：
        │   ·场景覆盖是否符合黄金集需求
        │   ·期望输出是否和产品定义一致
        │   ·是否和已有 golden case 重复
        ▼
golden（黄金状态）
        │
        │ 触发场景：
        │   ·产品行为变更导致期望输出过时
        │   ·发现标注有误
        │   ·场景已经被废弃
        ▼
deprecated（废弃，保留历史，打标记）
```

:::方法 黄金集的晋升配额控制
不要让黄金集无限膨胀。成熟期建议设置场景配额：每个场景在黄金集里最多保留 N 条（N 通常是 10-30），超出配额时，新 case 只有在比现有 case 更有价值（覆盖新边界）时才能替换旧的。这样能保持黄金集的"含金量"，而不是堆规模。
:::

### 6.2 腐化检测

黄金集最大的敌人是时间——期望输出会随着产品迭代而过时。

**触发腐化检测的场景**：

```python
def detect_golden_decay(golden_case: TestCase, current_system):
    signals = []
    
    # 信号 1：当前系统的输出和黄金集期望偏差很大（可能是黄金集过时，也可能是系统退步）
    current_output = current_system.predict(golden_case.input)
    divergence = compute_semantic_similarity(current_output, golden_case.expected.output)
    if divergence < 0.6:
        signals.append(DecaySignal("output_divergence", severity="high"))
    
    # 信号 2：该 case 对应的产品功能有变更记录（接 change log）
    if has_product_change(golden_case.scenario, since=golden_case.last_reviewed_at):
        signals.append(DecaySignal("product_change", severity="medium"))
    
    # 信号 3：长时间未被 review（超过 90 天）
    days_since_review = (now() - golden_case.last_reviewed_at).days
    if days_since_review > 90:
        signals.append(DecaySignal("stale", severity="low"))
    
    return signals
```

**腐化预警看板**：显示黄金集里按场景分桶的"新鲜度"分布，超过 90 天未 review 的 case 标红。

---

## 七、Case 回流

Case 回流是数据飞轮的输入端——把生产中发现的问题自动送回标注平台，而不是沉在日志里。

### 7.1 回流触发条件

| 触发信号 | 优先级 | 自动操作 |
|---|---|---|
| 用户点踩（thumbs down） | P1 | 立即进入标注队列，标注员优先处理 |
| 用户显式纠错（输入了正确答案） | P0 | 立即进入队列，附带"用户期望输出"字段 |
| 转人工（客服接手） | P1 | 进入队列，附带人工客服的处理结果 |
| 重问同一问题（30 分钟内） | P2 | 进入队列，标注为"未解决" |
| LLM-judge 打分 < 2.5 | P2 | 进入队列，附带 judge 的分析 |
| 系统错误（报错、超时） | P0 | 立即进入队列，附带错误堆栈 |

### 7.2 回流数据流

```python
# 生产系统中的回流 hook（伪代码）
class FeedbackCollector:
    def on_user_feedback(self, session_id: str, feedback: Feedback):
        session = load_session(session_id)
        
        # 构造回流 case
        case = {
            "input": session.last_user_input,
            "conversation_history": session.history[-5:],  # 最近 5 轮
            "actual_output": session.last_bot_output,
            "feedback": {
                "type": feedback.type,           # thumbs_down / correction / escalation
                "user_correction": feedback.text, # 用户提供的正确答案（如有）
                "human_resolution": None          # 人工客服的处理结果（异步填写）
            },
            "metadata": {
                "session_id": session_id,
                "model_version": session.model_version,
                "prompt_version": session.prompt_version,
                "timestamp": now()
            }
        }
        
        # 去重检查（避免同一问题多次回流）
        if not annotation_platform.is_duplicate(case):
            annotation_platform.ingest(case, priority=feedback.priority())
    
    def on_llm_judge_alert(self, session_id: str, judge_result: JudgeResult):
        if judge_result.avg_score < 2.5:
            case = build_case_from_session(session_id, judge_result)
            annotation_platform.ingest(case, priority="P2", auto_prescore=judge_result)
```

### 7.3 回流 case 的标注工作流

回流 case 进入平台后，不是直接进普通标注队列，而是有独立的处理路径：

```
回流 case 入库
        │
        ▼
自动分类（场景 + 优先级）
        │
        ├─ P0（报错/用户纠错）→ 即时通知标注员，1小时内处理
        ├─ P1（踩/转人工）→ 当天处理
        └─ P2（重问/judge低分）→ 48小时内处理
        │
        ▼
LLM 预打分（分析失败原因）
        │
        ▼
标注员处理
        ├─ 确认失败原因（prompt / 数据 / 路由 / 模型）
        ├─ 标注正确行为（应该怎么回答）
        └─ 决策：加入黄金集 / 仅修复不入黄金集 / 废弃
        │
        ▼
（如果加入黄金集）→ 走晋升流程
        │
        ▼
触发 bug 修复流程（工程侧）
```

---

## 八、数据集 API：对外服务

### 8.1 API 设计原则

标注平台不只是给内部标注员用的，评测系统、CI/CD、外部合作方都需要访问数据集。API 的设计要满足：

- **版本化**：指定数据集版本，结果可复现
- **过滤灵活**：按场景、优先级、golden_status、标签过滤
- **增量拉取**：只拉自上次同步后新增/修改的 case
- **权限控制**：不同调用方看到的数据范围不同

### 8.2 核心 API 端点

```
# 数据集查询
GET  /api/v1/datasets
GET  /api/v1/datasets/{dataset_id}/versions
GET  /api/v1/datasets/{dataset_id}/versions/{version}

# 用例查询
GET  /api/v1/datasets/{dataset_id}/cases
     ?scenario=核心业务场景/退款申请
     &golden_status=golden
     &priority=P0,P1
     &since=2026-06-01T00:00:00Z    # 增量拉取
     &limit=100&offset=0

# 单条用例
GET  /api/v1/cases/{case_id}

# 回流接口（生产系统调用）
POST /api/v1/feedback/ingest
{
  "session_id": "...",
  "input": "...",
  "actual_output": "...",
  "feedback_type": "thumbs_down",
  "metadata": {...}
}

# 标注写入（供 eval 系统回写 judge 分数）
POST /api/v1/cases/{case_id}/annotations
{
  "annotator_type": "llm_judge",
  "scores": {"relevance": 4.2, "faithfulness": 3.8},
  "reasoning": "..."
}

# Webhook 注册（数据变更时主动推送）
POST /api/v1/webhooks
{
  "url": "https://ci.example.com/hooks/eval-trigger",
  "events": ["golden_case_added", "golden_case_deprecated"],
  "dataset_id": "customer-service-golden"
}
```

### 8.3 Python SDK 使用示例

```python
from annotation_sdk import AnnotationClient

client = AnnotationClient(
    api_key="YOUR_API_KEY",
    base_url="https://annotation.internal.example.com"
)

# eval 系统拉取黄金集
golden_cases = client.cases.list(
    dataset="customer-service-golden",
    version="v1.2.0",
    golden_status="golden",
    scenario="核心业务场景/退款申请"
)

for case in golden_cases:
    # 运行被测系统
    actual = chatbot.predict(case.input, history=case.context.conversation_history)
    
    # 回写 judge 分数
    client.annotations.create(
        case_id=case.id,
        annotator_type="llm_judge",
        model="gpt-4o",
        scores={
            "intent_accuracy": judge_intent(actual, case.expected.intent),
            "slot_accuracy": judge_slots(actual, case.expected.slots),
            "response_quality": judge_quality(actual, case.expected.output_criteria)
        }
    )
```

### 8.4 权限控制

| 调用方 | 权限范围 |
|---|---|
| **内部评测系统** | 读全量 golden / candidate，写 judge 分数 |
| **CI/CD 系统** | 只读 golden，触发指定版本评测 |
| **外部数据合作方** | 读脱敏后的 candidate，不含 golden |
| **标注管理后台** | 全量读写（含敏感字段） |
| **只读 API Key** | 只读 golden，按场景过滤，不含 PII |

---

## 九、主流平台参考与对比

这套平台设计参考了业界多个成熟实践，以下是关键对比和借鉴点：

### 9.1 Label Studio

Label Studio 是目前最流行的开源标注平台，支持文本/图像/音频等多模态，同时支持 LLM 的 agent trace 标注和 RLHF 数据收集。

**借鉴点**：
- **任务模板系统**：预置多种标注界面模板，标注员无需学习复杂配置
- **标注协作**：多人同时对同一批 case 标注，自动计算 inter-annotator agreement
- **ML 后端集成**：支持接入外部模型做预标注（对应我们的 LLM 预打分模块）

**不足**：场景管理较弱，不支持两级场景树和黄金集晋升流程，需要自行扩展。

### 9.2 Argilla

Argilla 是专为 LLM 数据工程设计的开源框架，特别针对偏好标注（RLHF/DPO）和 RAG 评测做了深度支持。

**借鉴点**：
- **Programmatic API 优先**：所有操作都有对应的 Python API，工程师可以把标注流程写成代码管理（对应我们的 SDK 设计）
- **反馈循环**：内置从标注数据到训练数据的转换流程，支持直接输出 DPO 训练格式

**关键差异**：Argilla 没有内置的 case 回流和黄金集管理概念，更多是一个标注工具而非完整的数据中枢。

### 9.3 Langfuse

Langfuse 是 LLM 可观测性平台，但它的评测数据集模块越来越接近本文描述的标注平台定位。

**借鉴点**：
- **Trace 联动**：每条 case 都能直接链接到生产 trace，标注员可以看到完整的 prompt + 检索 + 输出链路
- **Dataset API**：结构化的数据集管理 + API，和 CI/CD 紧密集成
- **Session 级导入**：从 trace 一键导入为 eval case，对应我们的生产日志导入功能

**关键差异**：Langfuse 不做人工标注工作台（只有简单评分），黄金集管理、场景树、标注规范管理都需要自建。

### 9.4 Scale AI / Surge AI

Scale AI 和 Surge AI 是专业的数据标注服务公司，Meta、Google、OpenAI、Anthropic 都是它们的客户。

**借鉴点**：
- **标注质量控制**：实时看板监控 gold-standard accuracy 和 inter-annotator agreement，低质量标注自动重新分配
- **工作流引擎**：支持多阶段标注流程（预标注 → 人工审核 → 仲裁 → 入库），每个阶段有明确的质量门控
- **Tasker 能力分级**：标注员有技能标签（如"金融领域专家"），复杂 case 路由到对应的专业标注员

**应用启发**：
- 标注优先级队列的设计（高风险 case 优先路由给高等级标注员）
- "仲裁员"角色：一般标注员分歧时，由资深仲裁员做最终决定

### 9.5 Braintrust

Braintrust 是近两年兴起的专注 LLM eval 的 SaaS 平台，把评测数据集管理和 CI/CD 集成做得很深。

**借鉴点**：
- **Eval + 数据集一体化**：数据集 API 和 eval 框架原生集成，从标注到跑 eval 的摩擦极低
- **实验追踪**：每次 eval 运行自动关联数据集版本 + 系统版本，方便归因
- **PM 友好界面**：非工程师也能在界面上查看 eval 结果、筛选 bad case

**和本文方案的差异**：Braintrust 没有 case 回流和黄金集晋升流程，更像一个 eval 平台而非完整的数据中枢。

### 9.6 Google 内部实践（公开资料）

Google 的 Responsible Generative AI Toolkit 和 SAIF 框架揭示了其内部评测体系的设计理念：

- **评测即基础设施**：把安全评测、内容质量评测、能力评测都当成 CI/CD 的一部分，而不是发布前的人工检查
- **Red Team 和评测数据联动**：Red Team 构造的攻击 case 直接进入标注平台，成为安全评测的持久化资产
- **分层评测**：单模型评测 → 系统评测 → 用户研究，三层覆盖，黄金集对应系统评测层

### 对比总结

| 能力 | Label Studio | Argilla | Langfuse | Braintrust | Scale AI | 本文方案 |
|---|---|---|---|---|---|---|
| 人工标注工作台 | ✅ 强 | ✅ 中 | ❌ | ❌ | ✅ 强 | ✅ |
| 场景树管理 | ❌ | ❌ | ❌ | ❌ | 部分 | ✅ |
| 黄金集晋升流程 | ❌ | ❌ | ❌ | 部分 | 部分 | ✅ |
| 腐化检测 | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Case 回流 | ❌ | ❌ | 部分 | 部分 | ❌ | ✅ |
| 数据集 API | 部分 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 与 CI/CD 集成 | 部分 | 部分 | ✅ | ✅ | ❌ | ✅ |
| 开源/自建成本 | 低 | 低 | 低 | 高（SaaS） | 高（外包） | 中 |

---

## 十、案例：金融客服 Chatbot 标注平台的三个月建设历程

### 案例背景

- **场景**：某互联网金融公司的用户客服 Chatbot，覆盖账户查询、还款、投诉、风控异常
- **业务特点**：合规要求严格（金融监管），用户情绪敏感（涉及钱），数据不能外发
- **团队**：3 名 AI 工程师，1 名数据工程师，2 名专职标注员，无专职产品经理（工程师兼职）

### Month 1：建平台地基

**Week 1-2：需求梳理和方案选型**

评估了 Label Studio（功能够用但场景管理弱）、Argilla（LLM 支持好但数据合规有疑虑）、自建（成本可控但开发周期）。最终决定：**Label Studio 做标注工作台 + 自建场景管理和黄金集模块 + FastAPI 自建 case 回流和数据集 API**。

这是一个务实的选择：不从零重建标注工作台，但补上主流工具缺少的场景管理和回流能力。

**Week 3-4：场景树初稿 + 黄金集 v0.1**

和产品（兼职的工程师）对齐了一级场景：账户、还款、投诉、风控、闲聊/超范围。每个一级场景下的二级场景由标注员根据历史工单做了 Top 20 分布分析后确定。

第一批黄金集 v0.1：
- 从 2000 条历史工单里人工挑选 60 条 case
- 标注规范草稿（覆盖 5 个主要场景）
- 基础 eval 脚本：跑黄金集，输出意图准确率和槽位准确率

**发现的第一个关键问题**：标注员 A 和 B 在"还款相关问题"的意图分类上的 Cohen's kappa 只有 0.51——远低于可信阈值 0.7。原因是"还款提醒"和"还款失败"在标注规范里没有明确区分。修订规范后重新标注，kappa 升到 0.78。

### Month 2：接入回流 + 打通 CI

**回流系统接入**：

在生产 Chatbot 系统里加了用户反馈 hook，接入 annotation platform 的 ingest API。第一周上线后：
- 每天收到约 80-120 条踩/转人工的回流 case
- 发现最高频的失败场景是"还款失败原因查询"——用户问为什么还款失败，Bot 给的是还款操作指南（答非所问），意图识别漏了"原因查询"这个子意图

修复：在"还款失败"场景下新增"还款失败原因查询"子场景，补了 15 条黄金集 case，更新了意图识别 prompt，eval 分数从 0.71 升到 0.84。

**CI 集成**：

```yaml
# .github/workflows/chatbot-eval.yml
name: Chatbot Eval
on:
  pull_request:
    paths: ["prompts/**", "knowledge_base/**"]

jobs:
  golden-eval:
    runs-on: ubuntu-latest
    steps:
      - name: Pull golden dataset
        run: |
          curl -H "Authorization: Bearer $API_KEY" \
          "https://annotation.internal/api/v1/datasets/financial-service-golden/versions/v1.1.0/cases?golden_status=golden" \
          -o golden_cases.json
      
      - name: Run eval
        run: python eval/run_golden_eval.py --cases golden_cases.json --threshold 0.80
      
      - name: Comment PR with results
        uses: actions/github-script@v6
        with:
          script: |
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              body: require('./eval/results.json').summary
            })
```

**这个阶段的关键指标变化**：

| 指标 | Month 1 末 | Month 2 末 | 变化 |
|---|---|---|---|
| 黄金集规模 | 60 条 | 140 条 | +133% |
| 黄金集通过率 | 0.71 | 0.84 | +0.13 |
| 转人工率（线上） | 34% | 26% | -8pp |
| 每日回流 case 处理率 | — | 78% | 建立指标 |
| 标注员一致性（kappa） | 0.51→0.78 | 0.81 | 持续提升 |

### Month 3：自优化闭环 + 黄金集腐化治理

**第一次腐化事件**：

产品在 Month 3 初把"还款"相关页面做了改版，原来的操作流程有变化。检测到：黄金集里 22 条还款相关 case 的期望工具调用序列已经过时（旧 API 路径）。

如果没有腐化检测，这 22 条 case 会继续作为回归基准，每次改动系统通过"旧的"期望，新的期望却从未被测试到。

处理：标记为 deprecated，重新标注 22 条 case（按新流程），进入晋升流程后更新黄金集到 v1.2.0。

**LLM 辅助标注规模化**：

随着每日回流量增加到 150+ 条，2 名标注员开始成为瓶颈。引入 GPT-4o 做 LLM 预打分，标注员只需确认或纠正，单条处理时间从 4 分钟降到 1.5 分钟，日处理量从 80 条提升到 200 条。

预打分准确率（和最终标注的一致率）：意图识别 89%，槽位提取 82%，回复质量 73%（主观性强，一致性偏低）。

**三个月总结**：

| 指标 | Month 0 | Month 3 末 |
|---|---|---|
| 黄金集规模 | 0 | 210 条 |
| 场景覆盖 | 0 | 5 大类 23 个子场景 |
| 每日 case 处理能力 | 0 | 200 条 |
| 转人工率 | 41% | 23% |
| 回归 CI 覆盖率 | 0% | 100%（所有 prompt/知识库 PR） |
| 已发现并修复的系统性问题 | 0 | 7 个 |

:::观点 三个月能建出什么级别的体系
有 2-3 名 AI 工程师 + 2 名标注员，三个月能建出"可信任"级别的标注平台：黄金集有 200 条、场景有明确覆盖、标注规范清晰、CI 已接入、回流已打通。这不是"理想态"，是"能工作的最小闭环"。从这里继续迭代，才有能力真正谈自优化。
:::

---

## 十一、实施路径：从零到有的优先级

### 第一阶段（2-4 周）：最小可用版本

1. **场景树**：用 spreadsheet 先定义，不用等系统建好
2. **黄金集 v0.1**：50 条 case，人工标注，进 JSON 文件，跑最简单的 eval 脚本
3. **标注规范 v0.1**：5 个核心场景，每个场景 1 页，存在 notion/confluence
4. **接入 CI**：哪怕是手动触发的 eval，先有这个意识

### 第二阶段（1-2 个月）：标注工作台 + 回流

1. **Label Studio**：部署，配置标注界面，把 JSON 黄金集导入
2. **回流接口**：生产系统埋点，重要信号（踩/转人工）推到平台
3. **LLM 预打分**：接 LLM 做预打分，减少标注员工作量
4. **数据集 API v1**：提供给 eval 系统拉取，替换手动 JSON 文件

### 第三阶段（2-3 个月）：黄金集晋升 + 腐化治理

1. **晋升流程**：候选 → 黄金集的审核流程上线
2. **腐化检测**：产品变更联动，定期扫描过时 case
3. **场景配额**：每个场景的黄金集上限，防止无限膨胀
4. **数据血缘**：每条 case 的完整来源链记录

---

## 参考资料

- [Label Studio: Open Source Data Labeling](https://labelstud.io/) — 最流行的开源标注平台，支持 LLM agent trace 标注和 RLHF 数据收集
- [Argilla: Collaboration Tool for AI Engineers](https://github.com/argilla-io/argilla) — 专为 LLM 数据工程设计，偏好标注和 RAG 评测支持强
- [Langfuse: Open Source LLM Engineering Platform](https://langfuse.com/) — Trace 联动 + Dataset API，和 CI/CD 集成深度最好的开源方案
- [Braintrust: Best LLM Evaluation Platforms 2025](https://www.braintrust.dev/articles/best-llm-evaluation-platforms-2025) — 专注 eval 的 SaaS，数据集管理和实验追踪做得很完整
- [Anthropic uses Surge AI's RLHF Platform](https://surgehq.ai/blog/anthropic-surge-ai-rlhf-platform-train-llm-assistant-human-feedback) — Surge AI 的工作流引擎和质量控制机制
- [Scale AI Wikipedia](https://en.wikipedia.org/wiki/Scale_AI) — Scale AI 的产品定位和主要客户（Meta/Google/OpenAI）
- [Sigma AI: Golden Datasets — Evaluating Fine-tuned LLMs](https://sigma.ai/golden-datasets/) — 黄金数据集建设的系统论述
- [Maxim: Building a Golden Dataset for AI Evaluation](https://www.getmaxim.ai/articles/building-a-golden-dataset-for-ai-evaluation-a-step-by-step-guide/) — 黄金集从零建设的实操指南
- [RAGAPHENE: A RAG Annotation Platform with Human Enhancements](https://arxiv.org/pdf/2508.19272) — 学术界的对话标注平台设计，含注释员协作机制
- [DeepEval: Chatbot Evaluation Quickstart](https://deepeval.com/docs/getting-started-chatbots) — 场景驱动评测框架，ConversationalGolden 的设计参考
- [Google: Responsible Generative AI Toolkit — Evaluate for Safety](https://ai.google.dev/responsible/docs/evaluation) — Google 内部评测框架的公开部分，分层评测思路
- [Chatbot Arena: Open Platform for Evaluating LLMs by Human Preference](https://arxiv.org/pdf/2403.04132) — LMSYS 的人类偏好评测平台，偏好标注机制参考
- [Can External Validation Tools Improve Annotation Quality for LLM-as-a-Judge?](https://arxiv.org/pdf/2507.17015) — LLM-judge 一致性提升的学术研究
- [A Practical Guide for Evaluating LLMs and LLM-Reliant Systems](https://arxiv.org/html/2506.13023v1) — 2025 年系统性 LLM 评测综述
