# 意图识别与意图澄清：从规则树到 LLM 的架构演进

用户说"我想买点东西送给朋友"——这不是一个可以直接执行的指令。

电商客服的核心挑战从来不是"回答问题"，而是**先搞清楚用户到底要什么**。意图识别和意图澄清是所有对话产品的地基，却是最容易被低估的一层。

本文沿着演进路径展开，覆盖六个阶段：规则引擎 → ML 分类器 → 联合建模（Joint NLU）→ OOS 检测 → 语义检索 → LLM-native，每一代解决前一代的具体痛点。随后完整覆盖多轮对话状态追踪（DST）、意图澄清设计框架，以及生产中的工程实践，附参考文献。

---

## 一、什么是意图识别，为什么难

意图识别（Intent Recognition / Intent Detection）的任务看起来简单：把用户输入映射到一个预定义的意图类别。

```
用户输入：「我的包裹什么时候到？」
           ↓
意图识别
           ↓
意图标签：ORDER_TRACKING
```

真实场景里有三重难度：

**歧义性**：同一句话对应多个意图。

```
「这个能退吗？」
  → 退款意图（买了不想要）
  → 退换货意图（收到的坏了）
  → 政策咨询意图（下单前问规则）
```

**稀疏性**：用户有数千种说法，但意图只有几十个。

```
「快递怎么还没到」
「这单发货了没有」
「我的东西在哪」
「怎么还没发」
                → ORDER_TRACKING（同一个意图，四种说法）
```

**组合性**：一句话里嵌套多个意图。

```
「这双鞋颜色好看，但尺码偏小，能换大一号的，如果没货就退款」
→ 商品反馈 + 尺码查询 + 换货 + 退款
```

完整的 NLU（自然语言理解）任务不止意图分类，还包括**槽位填充（Slot Filling）**——提取意图相关的结构化参数：

```
输入：「帮我查一下北京到上海明天的票」

意图：TICKET_QUERY
槽位：
  origin:       北京
  destination:  上海
  date:         明天（→ 2026-06-03）
```

两个子任务相互影响：意图决定哪些槽位是必须的，槽位的存在又能反过来确认意图。这个关联是整个 NLU 演进史的核心张力。

---

## 二、演进全景

```
时间线          技术阶段                   解决的核心问题
──────────      ──────────────────────     ──────────────────────────────
~2015 前        规则引擎                   意图路由（但关键词 ≠ 语义）
2015-2018       ML 分类器（流水线）         语义泛化（但 intent/slot 分离传播误差）
2018-2020       Joint NLU（联合建模）       intent + slot 互增强（但不知道自己不懂的）
2019-2021       OOS 检测                   识别意图范围外的输入（但少样本新意图难上）
2019-至今        语义检索式（Embedding）    少样本、快速添加新意图（但复杂槽位仍弱）
2023-至今        LLM-native                开放意图 + 复杂槽位 + 隐含需求
──────────      ──────────────────────     ──────────────────────────────
横向能力         对话状态追踪（DST）        多轮状态的形式化管理（贯穿始终）
```

没有哪个阶段彻底淘汰上一个。真实生产系统通常是多层并存：规则前置过滤，ML 快速路由，LLM 处理长尾和复杂边界。

---

## 三、第一代：规则引擎

### 架构

```
用户输入
   ↓
分词 + 关键词提取
   ↓
规则树匹配（if-else / 正则 / 决策树）
   ↓
意图标签 + 槽位（手写模板提取）
```

### 电商实现示例

```python
def recognize_intent(text: str) -> dict:
    text = text.lower()

    if any(kw in text for kw in ["退款", "退钱", "不想要", "退货"]):
        return {"intent": "REFUND", "confidence": 1.0}

    if any(kw in text for kw in ["快递", "物流", "发货", "到了吗", "在哪"]):
        return {"intent": "ORDER_TRACKING", "confidence": 1.0}

    if any(kw in text for kw in ["尺码", "颜色", "材质", "怎么样"]):
        return {"intent": "PRODUCT_INQUIRY", "confidence": 1.0}

    return {"intent": "UNKNOWN", "confidence": 0.0}
```

### 优缺点

```
优点                            缺点
──────────────────              ────────────────────────────
可解释、可审计                   维护规则库代价极高
零延迟、零成本                   新意图必须手写规则
不需要训练数据                   歧义时无法判断优先级
适合严格合规场景                 无法处理语义变体
```

### 典型失效

```
用户：「我不想要了」
规则引擎：匹配到「不想要」→ REFUND → 触发退款流程

实际：用户正在和朋友聊天，随口说了一句，根本没下单
```

规则引擎的根本问题是**关键词 ≠ 语义**，它识别的是词的出现，不是用户的意图。

---

## 四、第二代：ML 分类器

### 4.1 流水线时代（2015—2018）：意图与槽位分离

ML 分类器用数据替代规则，用向量空间中的语义距离来泛化表达变体。

```
用户输入
   ↓
文本向量化（TF-IDF / Word2Vec / FastText）
   ↓
意图多分类器（SVM / CRF / LSTM）
   ↓
意图标签

                    ↓ （再单独处理）
              NER 模型（序列标注）
                    ↓
              槽位实体（B-I-O 标注）
```

流水线设计的核心问题是**误差传播**：意图识别出错，下游槽位提取就在错误的语义空间里运行，两层错误叠加。

```
输入：「有没有适合老人用的手机，价格便宜的」

流水线（误分类情况）：
  Step 1 意图分类：PRODUCT_SEARCH → 正确
  Step 2 槽位提取（基于"商品搜索"上下文）：
    product: 手机 → 提取到
    user_group: 老人 → 未提取（此槽位未定义）
    price_constraint: 便宜 → 未归一化

若 Step 1 意图误判为 GIFT_SEARCH，
Step 2 会尝试提取 recipient/occasion 槽位，结果全错
```

### 4.2 联合建模：Joint NLU（2018—2020）

联合建模（Joint Intent Classification + Slot Filling）用共享 Encoder 同时优化两个任务，让意图和槽位互相增强。

**架构**（以 BERT-based Joint NLU 为例）：

```
用户输入 Token 序列
        ↓
   BERT Encoder（共享）
   [CLS] t₁ t₂ t₃ t₄ t₅ [SEP]
     │    │  │  │  │  │
     │    └──┴──┴──┴──┘
     │         │
   [CLS] 向量   Token 向量序列
     │                │
意图分类头          槽位标注头（Token-level）
（Softmax）         （BIO 序列标注）
     │                │
意图标签           槽位实体 span
```

两个 loss 联合训练：

```python
total_loss = intent_loss + alpha * slot_loss
```

:::方法 为什么共享 Encoder 能让两个任务互增强
BERT 的 [CLS] 向量汇聚了全句语义；Token 向量携带局部上下文。意图分类用全局信息，槽位标注用局部信息，两者在同一个 Encoder 里训练——识别出"这是换货意图"会让 Encoder 对"颜色""尺码"类 Token 更敏感；反过来，出现"黑色""38码"这类实体 Token 也会强化"换货"意图的概率。误差不再单向传播，而是双向修正。
:::

**与流水线对比（电商换货场景）**：

```
输入：「我买的那双跑鞋颜色不对，想换成黑色42码的」

流水线：
  意图：EXCHANGE（正确）
  槽位：color=黑色, size=42  （但 color 的 BIO 边界在槽位模型里不稳定）

Joint NLU：
  [CLS] → EXCHANGE（置信度 0.93，更高）
  Token 标注：
    「跑鞋」→ B-product
    「黑色」→ B-target_color
    「42」  → B-target_size
  → 槽位准确率提升约 5-8%（实测依数据集而定）
```

:::观点 Joint NLU 是 NLU 工程化成熟期的标志
Goo et al. 的 Slot-Gated 模型（NAACL 2018）和 Chen et al. 的 BERT Joint NLU（2019）将联合建模从学术推向工业。RASA 2.0 采用的 DIET（Dual Intent and Entity Transformer）本质上就是这个思路的工程化实现——单模型完成意图分类和实体提取，延迟低于分别调用两个模型。
:::

### 4.3 OOS 检测：知道自己不知道什么（2019—）

联合建模解决了 intent/slot 精度问题，但没解决一个根本缺陷：**Softmax 分类器总是输出一个类别**，即使用户问的根本不在意图库里。

```
用户：「你们有没有分期付款？」
意图库里没有 INSTALLMENT_INQUIRY 这个意图

Softmax 输出：
  ORDER_TRACKING: 0.31   ← 最高
  REFUND:         0.22
  PRODUCT_SEARCH: 0.19
  ...

系统：路由到物流查询处理器
结果：答非所问，用户懵
```

这类输入叫 **Out-of-Scope（OOS）/ Out-of-Distribution（OOD）**，主要有三种检测方案：

**方案 A：置信度阈值（Confidence Threshold）**

```python
if max(softmax_probs) < OOS_THRESHOLD:
    return {"intent": "OOS", "confidence": 1.0}
```

简单但不可靠：Softmax 的置信度天然虚高（overconfident），OOD 样本的最高概率不一定低。

**方案 B：专用 OOS 二分类器**

在意图分类之前（或并行）加一个二元判断：「这条输入在我的意图覆盖范围内吗？」

```
用户输入
    ↓
OOS 检测器（binary classifier）
    ↓
        ┌────────────────┐
      In-scope          OOS
        ↓                ↓
  意图分类器          兜底处理
  （正常路由）        （澄清/引导/转人工）
```

Larson et al.（EMNLP 2019）提出的 CLINC150 数据集包含 150 个 in-scope 意图和专门的 OOS 测试集，成为 OOS 检测的标准 benchmark。

**方案 C：基于 Embedding 距离的 OOS 检测**

计算用户输入的 Embedding 与所有已知意图中心的最近距离，超过阈值则判定为 OOS：

```python
def detect_oos(user_embedding, intent_centroids, threshold=0.65):
    distances = cosine_distance(user_embedding, intent_centroids)
    min_distance = min(distances)
    if min_distance > threshold:
        return True  # OOS
    return False
```

这个方案与下一节的语义检索式识别天然融合。

:::提醒 OOS 率是系统健康的晴雨表
OOS 率持续升高，往往意味着用户需求已经超出当前意图库覆盖范围，是业务扩张的信号而非系统故障。建立 OOS 样本的自动收集和人工标注流水线，定期把高频 OOS 类型转化为新意图。
:::

---

## 五、语义检索式意图识别（2019—）

ML 分类器和 Joint NLU 都依赖「有足够标注数据的封闭意图集合」。业务快速变化时，新增一个意图需要：收集几百条样本 → 标注 → 重新训练 → 评估 → 上线。周期短则数天，长则数周。

语义检索式方案（Embedding-based Retrieval / Few-shot Intent Detection）用另一种思路解决这个问题：**把意图识别变成最近邻检索**。

### 架构

```
离线：构建意图示例库
  每个意图准备 5-20 条代表性示例
  用 Sentence Encoder 编码成向量
  存入向量库（每条向量带 intent 标签）

在线推理：
  用户输入 → Sentence Encoder → Query 向量
       ↓
  向量库 K-近邻检索（cosine similarity）
       ↓
  Top-K 候选意图（带相似度分数）
       ↓
  投票 / 加权聚合 → 最终意图 + 置信度
```

### 电商场景示例

```
意图库（简化）：
  ORDER_TRACKING:
    - 「我的包裹什么时候到？」  → embedding_1
    - 「快递发出去了吗」        → embedding_2
    - 「物流怎么没动静」        → embedding_3
  
  REFUND:
    - 「我要退款」              → embedding_4
    - 「这个东西不想要了」      → embedding_5

用户输入：「我买的那个东西快到了吗」
Query Embedding → 最近邻检索
  ORDER_TRACKING / embedding_2 → similarity: 0.91
  ORDER_TRACKING / embedding_1 → similarity: 0.88
  REFUND / embedding_5         → similarity: 0.43

Top-3 全是 ORDER_TRACKING → 识别结果：ORDER_TRACKING（置信度高）
```

### 与分类器方案的对比

```
能力维度              分类器（BERT fine-tuned）    语义检索（Embedding KNN）
────────────          ───────────────────────      ──────────────────────────
新增意图              重新训练（天级）              添加示例即可（分钟级）
少样本支持            需要 100+ 条/意图             5-20 条即可
准确率上限            高（大数据量时）              略低（边界不如分类器清晰）
意图数量扩展          标签膨胀后准确率下降          向量库扩展线性可控
可解释性              只有概率                     能展示最相似的参考示例
OOS 处理             需单独检测器                  相似度低 = 自然 OOS 信号
```

:::方法 Sentence Encoder 的选择
语义检索的质量完全取决于 Encoder 的语义对齐能力。中文电商场景推荐：
- **通用**：text2vec-large-chinese（开源，中文优化）
- **领域特化**：在电商对话数据上做对比学习 fine-tune（效果提升 5-15%）
- **云服务**：阿里 EmbeddingModel / 百度 Embedding
同一意图内的不同说法在向量空间中应尽量聚类，不同意图应尽量分离——这是评估 Encoder 质量的直接指标。
:::

### 与 OOS 检测的融合

语义检索自带 OOS 信号——当所有候选相似度都低于阈值，就是 OOS，不需要额外的二分类器：

```python
def retrieve_intent(query_embedding, intent_db, oos_threshold=0.65):
    results = intent_db.search(query_embedding, top_k=5)
    
    if results[0].score < oos_threshold:
        return IntentResult(intent="OOS", confidence=results[0].score)
    
    # 对 top-k 结果按 intent 投票
    vote_counts = Counter(r.intent for r in results)
    top_intent = vote_counts.most_common(1)[0][0]
    confidence = results[0].score
    
    return IntentResult(intent=top_intent, confidence=confidence)
```

---

## 六、第三代：LLM-native（2023—）

前五代方案共享一个假设：**意图是离散的、预先定义的集合**。LLM 打破了这个假设。

```
第一代至第五代：
  用户输入 → 匹配/分类/检索 → 预定义意图集合中的一个标签

LLM-native：
  用户输入 → 语义理解 → 结构化的意图 + 槽位 + 隐含需求 + 情绪信号
```

### 结构化输出设计

```python
INTENT_EXTRACTION_PROMPT = """
你是电商客服的意图解析器。分析用户输入，输出结构化 JSON。

意图类型（不限于此列表，可输出 open_ended）：
- product_search: 找商品
- order_tracking: 查订单/物流
- refund_request: 申请退款
- exchange_request: 申请换货
- product_inquiry: 咨询商品信息
- complaint: 投诉
- gift_recommendation: 礼品推荐
- open_ended: 无法归类的开放问题

输出格式：
{
  "primary_intent": "...",
  "secondary_intents": ["..."],
  "slots": {
    "product_category": null,
    "budget_range": null,
    "recipient": null,
    "urgency": "high|medium|low",
    "emotion": "neutral|frustrated|urgent|satisfied"
  },
  "ambiguity_level": "none|low|high",
  "clarification_needed": true/false,
  "missing_critical_slots": ["..."],
  "implicit_needs": ["..."]
}

用户输入：{user_input}
对话历史：{history}
"""
```

### 六代处理同一输入的完整对比

```
用户输入：「我想给我妈买个护肤品当母亲节礼物，五百块以内，
          她五十多岁，皮肤比较干，平时用国货」

──────────────────────────────────────────────────────

第一代（规则引擎）：
  匹配「护肤品」→ PRODUCT_INQUIRY
  路由：商品详情页
  结果：❌ 无礼品推荐逻辑，无年龄/肤质/预算筛选

第二代（流水线 ML）：
  PRODUCT_SEARCH: 0.68，PRODUCT_INQUIRY: 0.27
  NER：product=护肤品（其余槽位未提取）
  结果：❌ 搜索结果是全量护肤品，意图库无 GIFT_RECOMMENDATION

第三代（Joint NLU）：
  PRODUCT_SEARCH: 0.71（仍然分错）
  Slot：product=护肤品, price_max=500
  结果：❌ 联合建模提升了槽位准确率，但意图类别缺失问题依旧

第四代（+ OOS 检测）：
  检测为 in-scope，但路由到 PRODUCT_SEARCH
  结果：❌ OOS 检测帮助识别了确实超出范围的请求，
       但这条输入在 in-scope 的边界里被错误分类

第五代（语义检索）：
  最近邻：「送朋友礼物找什么好」→ similarity: 0.78
  意图库有 GIFT_RECOMMENDATION 示例 → 正确路由 ✓
  slots 仍需 LLM 提取（检索只解决意图，不解槽位）
  结果：△ 意图对了，但结构化槽位（年龄/肤质/品牌偏好）丢失

第六代（LLM-native）：
  {
    "primary_intent": "gift_recommendation",
    "slots": {
      "product_category": "护肤品",
      "budget_range": "500以内",
      "recipient": "母亲",
      "occasion": "母亲节",
      "recipient_age": "50+",
      "skin_type": "干皮",
      "brand_preference": "国货"
    },
    "implicit_needs": ["礼品包装", "贺卡", "抗老成分"],
    "ambiguity_level": "none"
  }
  路由：礼品推荐模块
  推荐：国货抗衰+补水系列，附礼品包装、贺卡、快递时效提示
  结果：✓ 完整理解场景，隐含需求也捕捉到
```

---

## 七、多轮对话状态追踪（DST）

意图识别处理的是**单轮**：这句话要什么。但真实对话是多轮的，用户会修正、补充、甚至反悔：

```
第 1 轮：「帮我换一双鞋」
  → EXCHANGE, product=鞋

第 2 轮：「换成黑色的」
  → 不是新意图，是补充 target_color=黑色

第 3 轮：「等等，我说错了，换红色」
  → 修正 target_color：黑色 → 红色

第 4 轮：「尺码一样就行」
  → 补充 target_size=same_as_original（推断）
```

对话状态追踪（Dialogue State Tracking，DST）负责在每一轮之后维护一个**信念状态（Belief State）**——当前已确认的所有槽位值的形式化表示。

### DST 的演进

```
阶段                方案                        代表工作
──────────          ──────────────────────      ──────────────────────
规则时代            手写有限状态机              早期 Spoken Dialog System
统计时代            概率图模型（HMM/DBN）        POMDP-based systems
深度学习时代        独立槽位分类器               NBT (Henderson et al. 2014)
端到端时代          Seq2Seq / Copy 机制          TRADE (Wu et al. ACL 2019)
LLM 时代            生成式 DST（T5 / GPT）       SimpleTOD (Hosseini-Asl et al. 2020)
```

### 核心操作

DST 每轮做三件事：

```python
class DialogueState:
    def __init__(self):
        self.belief_state = {}   # 已确认槽位
        self.history = []        # 对话历史
    
    def update(self, new_turn: dict):
        user_utterance = new_turn["user"]
        
        # 1. 新值填充：用户新提供的槽位
        for slot, value in new_turn["extracted_slots"].items():
            self.belief_state[slot] = value
        
        # 2. 值延续（Carry-over）：未提及的槽位保持不变
        # （belief_state 字典不清空，只更新）
        
        # 3. 值修正：若新值与已有值冲突，后者覆盖前者
        # （上面的赋值天然实现了覆盖）
        
        self.history.append(user_utterance)
```

### 电商换货的完整 DST 示例

```
初始状态：belief_state = {}

────────────────────────────────────────────
第 1 轮
用户：「帮我换一双鞋，换黑色的」
提取：{intent: EXCHANGE, product: 鞋, target_color: 黑色}
更新后：{intent: EXCHANGE, product: 鞋, target_color: 黑色}

────────────────────────────────────────────
第 2 轮
用户：「尺码大一号」
提取：{target_size: +1}（相对值）
更新后：{intent: EXCHANGE, product: 鞋,
         target_color: 黑色, target_size: +1}

────────────────────────────────────────────
第 3 轮
用户：「等等黑色改成红色」
提取：{target_color: 红色}  ← 修正
更新后：{intent: EXCHANGE, product: 鞋,
         target_color: 红色,  ← 已修正
         target_size: +1}

────────────────────────────────────────────
第 4 轮
用户：「好，就这样」
提取：{}（无新槽位）
更新后：状态不变，槽位完整 → 触发换货流程

执行参数：product=鞋, target_color=红色, target_size=原码+1
```

:::启发 DST 是澄清策略的信息基础
澄清决策器「知道该问什么」，依赖的就是 DST 的 belief_state——比较「执行所需槽位」与「已确认槽位」的差集，差集就是需要问的内容。没有 DST，每轮都要从头提取所有槽位，多轮修正变得几乎不可能实现。
:::

### 端到端生成式 DST

LLM 时代的 DST 不再是独立的槽位分类器，而是直接生成 belief state 字符串：

```python
DST_PROMPT = """
对话历史：
{history}

当前用户输入：{user_utterance}

已知意图：{current_intent}
上一轮信念状态：{previous_belief_state}

请输出更新后的信念状态（JSON），注意：
- 用户未提及的槽位保持上一轮的值（carry-over）
- 用户明确修正的槽位用新值覆盖
- 推断出的隐含值也纳入（如「大一号」= target_size = original_size + 1）
"""
```

SimpleTOD（Hosseini-Asl et al. 2020）用单个 GPT-2 统一完成 DST、Policy 和 Response Generation，证明了生成式端到端 DST 的可行性。

---

## 八、意图澄清：什么时候问、问什么、问几次

意图识别再好也会遇到真正模糊的输入。澄清是必要的——但**澄清本身是用户体验损耗**，问错了问题比不问更差。

### 澄清决策框架

```
用户输入
   ↓
意图识别 + DST 更新
   ↓
        ┌──────────────────┬──────────────────┐
        │                  │                  │
   歧义度低            歧义度中            歧义度高
   必要槽位完整        缺少关键槽位        意图本身不明
        │                  │                  │
   直接执行         静默补全 or 澄清      必须澄清
```

### 三种澄清策略

**策略 1：静默补全（Silent Slot Filling）**

歧义度低、缺少非关键槽位时，用默认值推断，不打扰用户。

```
用户：「帮我查一下我的单」

静默补全：
  → 查用户最近一笔未签收订单（默认值）
  → 直接回复：「您的单号 XXX 预计明天上午送到」

不问：「请问是哪个订单号？」（用户体验最差的回应）
```

**策略 2：单问题精准澄清**

意图已明确，只缺一个决定性参数。

```
用户：「这件能退吗」

LLM 分析：
  primary_intent: refund_inquiry
  ambiguity: 政策咨询 vs 实际申请（需判断）
  missing_critical_slots: [order_id]

澄清（带选项卡）：
  「您是想咨询退款政策，还是已经要申请退款了？」
  ○ 咨询政策
  ○ 申请退款（我帮您找到最近的订单）
```

**策略 3：引导式多轮槽位收集（Guided Slot Collection）**

意图明确，但缺多个必要槽位。

```
用户：「我想找个礼物」

DST 当前状态：{intent: gift_recommendation}（其余槽位空）

首轮澄清（优先问信息增益最大的槽位）：
  「好的！请问礼物是送给谁的？」

用户：「我妈」
DST 更新：{recipient: 母亲}

隐式推断：occasion 候选：母亲节/生日/日常

继续澄清：「她平时比较喜欢什么？比如护肤、珠宝……」

用户：「护肤吧」
DST 更新：{product_category: 护肤品}

槽位已足够执行，进入推荐流程
```

:::观点 澄清问题设计三原则
(1) 每次只问一件事；(2) 优先问能最大消除歧义的维度（信息增益最大）；(3) 尽量提供选项而非开放填空——用户看到选项时的回答更准确，也更快。把这三条组合起来：每次只问一个带选项的问题，按信息增益排序。
:::

### 多轮澄清的停止条件

```python
MAX_CLARIFICATION_TURNS = 2

def should_clarify(state: DialogueState) -> bool:
    if state.clarification_turns >= MAX_CLARIFICATION_TURNS:
        return False  # 超限：用最佳猜测执行或转人工

    if not state.missing_critical_slots:
        return False  # 槽位已满

    if state.ambiguity_level == "none":
        return False  # 意图明确，缺失槽位用默认值

    return True
```

:::提醒 两轮后强制执行，不要死磕
生产数据表明，超过两轮澄清的对话满意度断崖式下降。两轮后选择置信度最高的解释执行，并附「我理解您的意思是……如果不对请告诉我」——把纠错权交给用户，比无限追问更好。
:::

---

## 九、意图澄清的架构实现

### 完整流程

```
用户输入
   │
   ▼
┌─────────────────────────────┐
│  意图解析（LLM）              │
│  输出：intent + slots +      │
│        ambiguity + missing   │
└─────────────────────────────┘
   │
   ▼
┌─────────────────────────────┐
│  DST 更新                   │
│  • Carry-over 已有槽位       │
│  • 修正冲突槽位              │
│  • 推断隐含值                │
└─────────────────────────────┘
   │
   ▼
┌─────────────────────────────┐
│  澄清决策器                  │
│  • 查历史（避免重复问）      │
│  • 判断是否需要澄清          │
│  • 按信息增益选澄清维度      │
└─────────────────────────────┘
   │              │
   │ 需要澄清      │ 不需要
   ▼              ▼
澄清问题生成    意图路由器
   │              │
   ▼              ▼
返回给用户   对应 Handler
   │         （搜索/退款/物流...）
   ▼
用户回复
   │
   ▼
回到 DST 更新 → 继续循环
```

### 澄清问题的生成（LLM 动态生成）

```python
CLARIFICATION_PROMPT = """
用户想要做：{intent_description}
当前已确认槽位：{resolved_slots}
仍缺少的关键信息：{missing_slots}
对话历史（避免重复提问）：{conversation_history}

生成一个简短友好的澄清问题，只问最重要的缺失信息。
如果适合，提供 2-4 个选项。

输出：
{
  "question": "...",
  "options": ["选项A", "选项B"],
  "slot_to_fill": "...",
  "info_gain_score": 0.0-1.0
}
"""
```

### 避免重复澄清

```python
class ClarificationState:
    def __init__(self):
        self.asked_slots = set()
        self.turns = 0

    def should_ask_slot(self, slot: str) -> bool:
        if slot in self.asked_slots:
            return False
        self.asked_slots.add(slot)
        return True
```

---

## 十、电商完整案例对比

### 案例 A：退款场景（歧义意图 + 缺失订单号）

```
用户：「这个不想要了」

规则引擎：「不想要」→ REFUND → 直接发起退款申请
         问题：用户可能只是随口说，根本没下单

ML 分类器：REFUND 0.61 / COMPLAINT 0.21 / OTHER 0.18
           置信度中等 → 转人工（成本高）

LLM + DST：
  意图：refund_intent（置信中）
  ambiguity_level: high（需确认是否已购买）
  missing_critical_slots: [order_id]

  澄清（带卡片）：
    「您是想申请退款吗？如果是，请选择订单：」
    ○ 昨天购买的跑步鞋 ¥499
    ○ 三天前购买的连衣裙 ¥299

  用户点选 → 槽位填充 → 进入退款流程 ✓
```

### 案例 B：跨轮修正（DST 的价值）

```
第 1 轮：「帮我换一下颜色」
  OOS 检测通过，意图 EXCHANGE
  DST：{intent: EXCHANGE}（product 未知）

澄清：「请问是哪件商品？」
用户：「那件外套」（无订单号）

第 2 轮：系统查到用户唯一一件外套订单
  DST：{intent: EXCHANGE, product: 外套, order_id: #xxx}

澄清：「换成什么颜色？」
用户：「黑色，不对，深蓝色」

第 3 轮：DST 捕捉修正
  DST：{..., target_color: 深蓝色}  ← 修正了「黑色」

槽位完整 → 提交换货申请
```

### 案例 C：上下文感知的 OOS 处理

```
用户：「你们有没有先买后付？」

语义检索：所有意图相似度 < 0.45 → 判定 OOS
OOS 处理：
  「您好，这类问题我还没法直接处理，让我帮您转接人工——
   同时我已记下您的问题，我们运营同学也会跟进是否需要上线此功能。」

系统后台：OOS 样本自动归档到「待扩展意图」队列
```

:::启发 上下文感知澄清 vs 无感知澄清
「您能说清楚吗？」是无感知澄清，负担全在用户。
「您说的是这个吗？」是上下文感知澄清，系统先用已有信息猜测，用户只需确认。
前者把负担甩给用户，后者是真正的理解后确认——差别在于系统是否充分利用了 DST 里的历史状态。
:::

---

## 十一、生产中的六个工程陷阱

### 陷阱 1：澄清成了甩锅

```
❌ 常见错误：
用户「帮我退款」→ 系统「请问您的订单号是多少？」

✓ 正确做法：
用户「帮我退款」→ 系统展示最近 3 笔订单让用户点选
  （用数据替代问题）
```

能从数据源获取的信息，不要让用户口述。

### 陷阱 2：意图标签膨胀

随着业务增长，意图从 50 个变成 500 个，分类器准确率持续下滑。

解法：**层次化意图树**，不要平铺。

```
SHOPPING
├── SEARCH
│   ├── SEARCH_BY_KEYWORD
│   ├── SEARCH_BY_OCCASION
│   └── SEARCH_BY_RECOMMENDATION
├── ORDER_MANAGEMENT
│   ├── ORDER_TRACKING
│   ├── ORDER_CANCEL
│   └── ORDER_MODIFY
└── AFTER_SALE
    ├── REFUND
    ├── EXCHANGE
    └── COMPLAINT
```

### 陷阱 3：置信度阈值一刀切

不同意图的操作成本不同，阈值应该分级：

```
高代价意图（退款、取消订单）：阈值 0.90+
  误触发代价高，宁可多问一步

低代价意图（商品推荐、物流查询）：阈值 0.60+
  误触发代价低，用户会自然纠正
```

### 陷阱 4：忽略情绪信号

```
用户：「你们客服在吗，我实在是太着急了」

纯意图分类：CUSTOMER_SERVICE_REQUEST

加入情绪感知：
  intent: CUSTOMER_SERVICE_REQUEST
  emotion: urgent + frustrated
  → 路由：优先队列 + 资深客服
  → 话术：「我马上为您处理，请告诉我具体情况」
```

### 陷阱 5：DST 忘记 Carry-over

多轮对话中只更新新槽位、忘记保留旧槽位，导致每轮都好像重新开始：

```
❌ 错误实现：每轮只提取当前轮次的槽位
  第 2 轮用户说「换红色」→ {target_color: 红色}（丢失了第 1 轮的 product 和 size）

✓ 正确实现：Carry-over + Update
  第 2 轮结束后：{product: 跑鞋, target_color: 红色, target_size: +1}
```

### 陷阱 6：不建立 OOS 收集流水线

把 OOS 样本当成"噪音"丢弃，就错过了业务扩张最真实的需求信号。应建立：

```
OOS 样本 → 自动归档 → 人工分类（是否值得新建意图）
                  ↓
         高频 OOS 类型（如「先买后付」「会员价」）
                  ↓
         进入意图扩展 Backlog → 标注 → 上线
```

---

## 十二、选型速查

### 意图识别方案

```
场景                           推荐方案
───────────────────────        ─────────────────────────────────
意图 < 20 个、规则稳定          规则引擎（快、可审计、零成本）
意图 50-200 个、有标注数据      Joint NLU（BERT-based，高准确率低延迟）
新意图频繁增加、少样本          语义检索（Embedding KNN，分钟级上线）
长尾意图、复杂槽位、隐含需求    LLM-native（泛化强，无需重训）
高并发、预算敏感                规则 + ML 混合，LLM 兜底长尾
合规严格（金融/医疗）           规则引擎前置过滤 + LLM
OOS 比例高                     Embedding KNN（自带 OOS 信号）
```

### 澄清策略

```
澄清策略                       适用时机
───────────────────────        ─────────────────────────────────
静默补全                        槽位缺失但有合理默认值
单问题澄清（带选项）            意图明确，缺一个决定性参数
引导式多轮收集                  意图明确，缺多个关键槽位（≤ 2 轮）
强制猜测（2 轮后）              歧义无法消除，继续问伤体验
转人工                          意图完全无法识别 or 高风险操作
```

### 三代混合架构（推荐的生产形态）

```
用户输入
   │
   ▼
┌──────────────────┐
│  规则引擎前置     │  ← 处理明确合规拦截（敏感词、黑名单）
│  延迟 < 1ms      │
└──────────────────┘
   │ 未命中
   ▼
┌──────────────────┐
│  Joint NLU       │  ← 快速路由常见意图（覆盖 80% 流量）
│  延迟 10-50ms    │    + OOS 检测
└──────────────────┘
   │ OOS / 低置信度
   ▼
┌──────────────────┐
│  LLM-native      │  ← 处理复杂/长尾/歧义输入（20% 流量）
│  延迟 500ms-2s   │    + DST 更新 + 澄清决策
└──────────────────┘
```

---

## 结语

意图识别的演进，本质上是**对「理解」这件事的边界的持续扩张**：

- 规则引擎：识别**词的出现**
- ML 分类器：识别**语义分布**
- Joint NLU：让**意图与实体互相约束**
- OOS 检测：知道**自己的能力边界**在哪
- 语义检索：实现**少样本泛化**
- LLM-native：理解**意图 + 上下文 + 隐含需求**
- DST：在**多轮时间轴上**维护这些理解的一致性

澄清则是意图识别的"最后一公里"——识别不确定时，由系统发起确认，而不是把负担甩给用户。从「请说清楚」到「您是指这个吗」，系统承担越来越多的理解负担。

澄清的终极目标不是问对问题，是**问更少的问题**。每次系统能从上下文推断的信息，都不应让用户再开口说一遍。

---

## 参考文献

**联合建模（Joint NLU）**

1. Goo, C.-W. et al. **Slot-Gated Modeling for Joint Slot Filling and Intent Prediction**. *NAACL-HLT 2018*. [aclanthology.org/N18-2118](https://aclanthology.org/N18-2118/)
2. Chen, Q. et al. **BERT for Joint Intent Classification and Slot Filling**. *arXiv 2019*. [arxiv.org/abs/1902.10909](https://arxiv.org/abs/1902.10909)
3. Bunk, T. et al. **DIET: Lightweight Language Understanding for Dialogue Systems** (RASA). *arXiv 2020*. [arxiv.org/abs/2004.09936](https://arxiv.org/abs/2004.09936)

**OOS 检测**

4. Larson, S. et al. **An Evaluation Dataset for Intent Classification and Out-of-Scope Prediction**. *EMNLP 2019*. [aclanthology.org/D19-1131](https://aclanthology.org/D19-1131/) （CLINC150 数据集）
5. Lin, T.-E. & Xu, H. **Deep Unknown Intent Detection with Margin Loss**. *ACL 2019*. [aclanthology.org/P19-1548](https://aclanthology.org/P19-1548/)
6. Zhan, L.-M. et al. **Out-of-Scope Intent Detection with Self-Supervision and Discriminative Training**. *ACL 2021*. [aclanthology.org/2021.acl-long.273](https://aclanthology.org/2021.acl-long.273/)

**语义检索 / Few-Shot**

7. Zhang, J. et al. **Discriminative Nearest Neighbor Few-Shot Intent Detection by Transferring Natural Language Inference**. *EMNLP 2020*. [aclanthology.org/2020.emnlp-main.411](https://aclanthology.org/2020.emnlp-main.411/)

**对话状态追踪（DST）**

8. Wu, C.-S. et al. **Transferable Multi-Domain State Generator for Task-Oriented Dialogue Systems** (TRADE). *ACL 2019*. [aclanthology.org/P19-1078](https://aclanthology.org/P19-1078/)
9. Hosseini-Asl, E. et al. **A Simple Language Model for Task-Oriented Dialogue** (SimpleTOD). *NeurIPS 2020 Workshops*. [arxiv.org/abs/2005.00796](https://arxiv.org/abs/2005.00796)

**综合参考**

10. Tur, G. & De Mori, R. **Spoken Language Understanding: Systems for Extracting Semantic Information from Speech**. *Wiley 2011*. （NLU 经典教材）
