# 反洗钱 × AI Agent：从规则引擎到智能体的合规革命

:::观点 这个场景为什么值得深度研究
AML（Anti-Money Laundering）是金融合规里规模最大、技术债最重、误报率最高的场景之一。全球每年洗钱规模约 $2 万亿，而传统基于规则的交易监控系统误报率高达 90%——也就是说，大量合规团队的人力都消耗在"找到针但大部分是草"的低效筛查上。AI+Agent 在这里的价值不是"用 AI 替代合规官"，而是"把人从海量误报中解放出来，聚焦真正可疑的案件"。
:::

---

## 一、AML 背景：为什么这是一个刚需且高压的赛道

### 1.1 监管压力持续升温

反洗钱是全球性强制合规要求，核心监管框架包括：

| 组织/地区 | 关键法规 | 核心要求 |
|---|---|---|
| FATF（金融行动特别工作组） | 40 项建议 + 灰名单/黑名单机制 | 风险为本方法（RBA）、客户尽调、可疑交易申报 |
| 美国 FinCEN | BSA（银行保密法）、AML Act 2020 | SAR 申报、CTR（大额现金申报）、制裁筛查 |
| 欧盟 | AMLD5/AMLD6 | 受益所有人登记、加密资产纳管 |
| 中国人民银行 | 《反洗钱法》（2006/2024 修订）、《金融机构反洗钱和反恐怖融资监督管理办法》 | 大额和可疑交易申报、客户身份识别（KYC）、风险评估 |
| 加密监管 | FATF Travel Rule、MiCA（欧盟） | 虚拟资产服务商（VASP）尽调、链上信息随行 |

**处罚力度极重**：近年典型罚款案例——HSBC 2012 年 $19 亿（美国 DOJ）、渣打银行 2019 年 $11 亿、法国巴黎银行 2014 年 $89 亿（含制裁违规）、Binance 2023 年 $43 亿（FinCEN + OFAC + CFTC）。一旦被列为"高风险机构"，对应的融资成本、声誉损失远超罚款本身。

### 1.2 行业规模

- **全球洗钱规模**：联合国毒品和犯罪问题办公室（UNODC）估算每年约全球 GDP 的 2-5%，即 $8000 亿至 $2 万亿
- **合规成本**：LexisNexis 2023 年报告显示全球金融机构 AML 合规年度总成本已超过 $2140 亿
- **加密领域**：Chainalysis 2024 年报告显示链上非法交易金额约 $246 亿（占总链上交易量约 0.34%，但绝对值仍巨大）

---

## 二、AML 核心场景全景

AML 不是一个单一任务，而是一套覆盖客户生命周期的**合规控制链**：

```
客户准入
  ↓
KYC / EDD（身份核验 + 增强尽调）
  ↓
持续交易监控（Transaction Monitoring）
  ↓
可疑交易识别 → SAR 申报
  ↓
制裁筛查（Sanctions Screening）
  ↓
案件调查（Case Investigation）
```

### 2.1 KYC / EDD（客户身份识别与增强尽调）

**场景**：用户注册时验证身份，评估其风险等级，对高风险客户（PEP——政治敏感人士、高风险国家居民）实施增强尽调。

**难点**：
- 文件真实性校验（证件 OCR + 防伪）
- 受益所有人穿透（多层壳公司架构识别）
- 动态风险更新（用户情况变化时及时重评）

### 2.2 交易监控（Transaction Monitoring, TM）

**场景**：对实时/批量交易流进行分析，识别洗钱模式（分拆 Structuring、分层 Layering、循环转账 Round-trip）。

**核心挑战**：规则引擎的阈值难以覆盖新型洗钱手法；正常业务波动（节假日、促销）会触发大量误报。

:::方法 三层洗钱模型（Placement / Layering / Integration）
洗钱通常分三步：**置入**（将非法现金注入金融系统，如换零钱、购买赌场筹码）→ **分层**（通过多步转账掩盖来源，如 wire transfer → 房产 → 信托）→ **整合**（将"干净"资金回流到合法经济体中）。AI 系统需要针对不同阶段设计不同的检测策略。
:::

### 2.3 制裁筛查（Sanctions Screening）

**场景**：在每笔交易、每次 KYC 时，实时比对 OFAC SDN 名单、联合国制裁名单、各国本地黑名单。

**难点**：姓名的多语言变体、拼写错误、真名+别名混用，模糊匹配的精度-召回平衡。

### 2.4 SAR 撰写与申报（Suspicious Activity Report）

**场景**：当分析师判定某交易或客户行为可疑后，需要按监管格式撰写并提交 SAR 报告。

**难点**：SAR 撰写是高度人力密集型工作——需要综合多条线索、用规范语言描述可疑行为、附上证据链。一个成熟分析师每月能处理约 20-30 个案件。

### 2.5 链上合规（Crypto / Blockchain AML）

**场景**：对加密货币交易进行链上溯源，识别与已知非法地址（混币器、黑市、被盗资产）的关联。

**特殊难点**：
- 隐私币（Monero、Zcash）的分析受限
- 跨链桥（Cross-chain Bridge）和混币器（Mixer/Tumbler）的资金流向追踪
- Travel Rule 要求发送方/接收方信息随交易传递，但 DeFi 协议天然无法落实

---

## 三、传统 AML 系统：规则引擎时代的架构与痛点

### 3.1 主流传统系统

金融机构长期依赖几套专业 AML 平台：

| 产品 | 厂商 | 定位 |
|---|---|---|
| Actimize（AML 套件） | NICE Systems | 银行交易监控、制裁筛查、SAR 管理 |
| Mantas / FCCM | Oracle Financial Services | 大型银行全周期 AML |
| Fircosoft | Fircosoft（现 LexisNexis） | 制裁名单筛查引擎 |
| SAS AML | SAS Institute | 基于统计模型的交易监控 |
| Tonbeller / Siron | Wolters Kluwer | 欧洲银行合规套件 |

### 3.2 传统方案的核心逻辑

传统系统高度依赖**专家规则（Expert Rules）**：

```python
# 典型规则示例（伪代码）
if transaction.amount > 10000 and transaction.currency == "USD":
    flag_as_ctr()   # 大额现金交易申报

if (
    sum_transactions_24h(customer) < 10000
    and num_transactions_24h(customer) > 3
    and each_transaction < 3000
):
    flag_as_structuring()  # 分拆洗钱
```

规则库通常由合规专家积累，一个大型银行的规则集可达数百条。每条规则的阈值由历史经验或监管要求确定。

### 3.3 传统方案的系统性痛点

:::提醒 90% 误报率不是小问题，是结构性问题
业界普遍数据：传统规则引擎触发的告警中，真正可疑（需要 SAR 申报）的比例不到 10%，有的系统低至 1-3%。这意味着一个合规团队 90% 的精力都在"确认没问题"上，真正的风险侦测效率极低。这是 AI 切入的核心价值点，不是"追求 0% 误报"，而是"把误报率从 90% 降到 60%"就能大幅解放人力。
:::

**误报率问题的根源**：
1. **规则阈值静态**：同样的 $10,000 阈值，对个人账户和企业账户的意义完全不同，规则无法区分上下文
2. **规则相互独立**：每条规则独立触发，无法捕捉跨多维度的联合异常
3. **时间窗口固定**：规则通常基于固定时间窗口（24h/7d），无法发现跨越更长时间的缓慢洗钱
4. **网络盲区**：规则只看单账户，无法发现多账户协同（俗称"车轮洗钱"——多个账户分工配合）

**人工调查的效率瓶颈**：
- 分析师需要手动查阅交易历史、账户关联、外部数据库（PEP 名单、企业注册信息）
- 撰写 SAR 报告平均耗时 2-4 小时
- 系统割裂：交易数据在 TM 系统，客户信息在 CRM，外部名单在另一套工具，分析师需要频繁跨系统

---

## 四、AI + Agent 方案：技术路径与架构设计

### 4.1 机器学习层：更准的异常检测

**图神经网络（GNN）是这个场景的杀手锏**

洗钱本质上是一个**网络问题**——资金在账户之间流转，形成可识别的拓扑结构。GNN 天然适合捕捉这类关系特征：

```
账户节点 ─[转账边]─ 账户节点
     ↓
节点特征：余额、活跃历史、KYC 等级
边特征：金额、时间、频率
     ↓
图卷积 → 聚合邻域信息 → 节点嵌入
     ↓
分类头：该节点/该交易是否可疑
```

代表工作：
- **GraphSAGE + 动态图**：用于捕捉账户关系随时间变化
- **Temporal Graph Networks (TGN)**：处理交易流的时序特征
- **IEEE-CIS Fraud Detection / Elliptic Dataset**：学术界常用的金融图数据集

**行为序列模型（Transformer-based）**

用 Transformer 建模用户的交易序列，捕捉"行为突变"：

```
[登录, 小额入金, 大额出金, 换汇, 国际转账]
           ↓ BERT-style 预训练
[CLS token] → 风险分类
```

蚂蚁集团"天盾"系统、阿里云金融风控均有类似实践。

### 4.2 LLM 层：语义理解与文本生成

**SAR 自动撰写**是 LLM 最直接的应用场景：

```
输入：
- 触发告警的交易明细（JSON）
- 客户画像摘要
- 关联实体列表
- 分析师的初步结论标注

↓ LLM（GPT-4 / Claude）

输出：
- 符合 FinCEN SAR 格式的叙述文本
- 关键事实的引用标注
- 风险等级建议
```

实际效果：SAR 撰写时间从 2-4 小时压缩到 30-45 分钟（人工复核+修改阶段保留）。

**新闻/公告的负面信息提取**：

合规团队需要持续监控媒体新闻，看客户是否出现负面报道（AML/制裁相关）。传统方案靠关键词匹配，漏报严重。LLM 可以：
- 准确识别实体（公司名多语言变体）
- 判断新闻与客户的相关性
- 提取风险等级（制裁点名 vs. 一般负面报道）

### 4.3 Agent 层：自动化案件调查

这是整个方案最有价值、也最难落地的部分。

:::方法 AML 调查 Agent 的工具集设计
一个 AML 调查 Agent 需要具备以下工具访问权限：
- **query_transaction_history(account_id, date_range)**：拉取账户交易历史
- **query_account_relationships(account_id, depth)**：图查询关联账户网络
- **check_sanctions_list(entity_name, entity_type)**：制裁名单实时查询
- **search_external_news(entity_name)**：外部媒体负面信息检索
- **lookup_business_registry(company_name, jurisdiction)**：企业注册信息核查
- **query_blockchain_address(address)**：链上地址溯源（接 Chainalysis/Elliptic API）
- **create_sar_draft(case_id, findings)**：生成 SAR 草稿
- **escalate_to_analyst(case_id, priority)**：升级给人工分析师

Agent 的编排逻辑采用 Plan-and-Execute：先制定调查计划，再逐步调用工具，每步结果影响下一步决策。
:::

**典型案件调查 Agent 执行流程**：

```
告警触发（TM 系统）
      ↓
Agent: "分析告警 #12345，账户 A 在 3 天内拆分 12 笔转账，总额 $98,500"
      ↓
Tool call: query_transaction_history(A, last_30d)
→ 发现账户 A 上月几乎无活动，本周突然活跃
      ↓
Tool call: query_account_relationships(A, depth=2)
→ 发现 A 与 B、C、D 三个账户均在同日开户，共享同一注册地址
      ↓
Tool call: check_sanctions_list("A公司")
→ 未命中制裁名单
      ↓
Tool call: lookup_business_registry("A公司", "HK")
→ 壳公司，无实质运营记录，注册地址为某律师事务所
      ↓
Agent 判断：高风险，建议升级 + 提供 SAR 草稿
      ↓
Tool call: create_sar_draft(case_id=12345, findings={...})
      ↓
Tool call: escalate_to_analyst(12345, priority="HIGH")
```

**自动化率的边界**：并非所有案件都适合全自动处理。实践中的分层策略：

| 风险等级 | Agent 动作 | 人工介入 |
|---|---|---|
| 低风险（可解释的正常偏差） | 自动关闭告警，记录理由 | 周期抽查 |
| 中风险（需进一步核实） | 自动完成数据收集，草拟结论 | 分析师 30 分钟复核 |
| 高风险（强指标可疑行为） | 自动完成调查，生成 SAR 草稿 | 分析师完整复核后提交 |
| 极高风险（涉及制裁/恐融） | 立即冻结账户 + 告警合规官 | 高级合规官主导 |

---

## 五、头部机构的实践：OKX、Binance、蚂蚁、传统金融大厂

### 5.1 OKX：合规优先的加密交易所建设路径

OKX 在 2022-2023 年大规模重组合规团队（同期 Binance 受罚），核心建设方向：

**链上分析集成**：
- 深度接入 Chainalysis KYT（Know Your Transaction）和 Elliptic，实现实时链上地址评分
- 自研链上溯源能力，对提现地址做 N 跳关联分析（判断是否与混币器/暗网市场关联）

**Travel Rule 合规**：
- 接入 Notabene 和 Sygna（Travel Rule 信息交换协议），实现 VASP 间交易信息随行
- 对 $1,000 以上跨交易所转账强制触发 Travel Rule 流程

**智能 KYC**：
- 引入文档 AI（OCR + 活体检测）加速 KYC 处理
- 基于风险等级分层：标准用户 EDD lite，高风险用户人工复核

**合规 Agent 原型**（据内部分享）：
- 正在测试将 LLM 接入案件调查流程，重点场景是"可疑提现模式+链上溯源"的联合分析
- 当前阶段：Agent 生成调查报告草稿，人工合规官最终判定

### 5.2 Binance：$43 亿罚款后的合规重建

2023 年 11 月，Binance 与 FinCEN、OFAC、CFTC 达成和解，支付 $43 亿罚款。核心问题是早期对制裁筛查和 KYC 执行不到位。此后：

**制裁筛查升级**：
- 从依赖第三方 API 到自建实时筛查系统，覆盖 OFAC SDN、EU Consolidated、UN Security Council 等多个名单
- 引入 TRM Labs 进行链上地址风险评分，对高风险地址实施实时拦截

**SAR 自动化**：
- 2024 年起接入 LLM 辅助 SAR 撰写，分析师转为"审核员"而非"撰写员"角色
- 据 CoinDesk 报道，Binance 合规团队已扩充至 700 人+，技术工具投入大幅增加

**地理围栏升级**：
- 基于 IP + 身份文件 + 链上资金来源三重判断，识别制裁地区（伊朗、俄罗斯受制裁方）用户

:::观点 加密交易所的 AML 难度高于银行
银行的客户身份清晰，资金来源有链路记录。加密交易所面临的挑战是：链上资金的来源是"公开但匿名"的，需要区块链分析能力；用户可通过 VPN + 他人身份文件绕过 KYC；DeFi 交互（从 DeFi 桥接资金到 CEX）几乎无法追溯真实来源。这就是为什么 Chainalysis、Elliptic、TRM Labs 这类链上分析服务成为合规基础设施的一部分。
:::

### 5.3 蚂蚁集团：金融 AI 风控的中国样本

蚂蚁集团（支付宝）在 AML/反欺诈方向积累了国内最完整的技术栈：

**天盾（Tianshield）系统**：
- 覆盖支付宝 10 亿+用户的实时风控引擎
- 核心技术：图计算（识别账户团伙关联）+ 行为序列模型（Transformer）+ 规则引擎三层串联
- 每秒处理峰值超过百万笔交易决策

**图计算在 AML 中的应用**：
蚂蚁自研的 Graph Compute Engine（GraphScope），用于：
- 资金环路检测（循环转账）：在 10 亿节点图上找到 N 步内的资金回路
- 团伙挖掘：通过 GNN 识别多个账户共享设备指纹/IP/注册信息的关联集群
- 动态图更新：新交易发生后实时更新图结构，不需要批量重算

**可疑交易申报自动化**：
接入大模型后，蚂蚁合规团队将 STR（可疑交易报告）撰写效率提升约 60%，并构建了内部的 AML 知识库，供 LLM 参考生成符合人民银行格式要求的报告文本。

**监管科技（RegTech）输出**：
蚂蚁通过阿里云 / 蚂蚁金融云向中小银行、农信社输出 AML 能力，采用"SaaS + 私有化部署"双模式，覆盖金融机构 200+。

### 5.4 JP Morgan：大型银行的 AI AML 转型

**COIN（Contract Intelligence）→ 延伸到合规**：
JP Morgan 最著名的 AI 项目 COIN（合同解析）被延伸到合规文档领域，包括：
- 自动分析客户提交的公司结构文件，识别受益所有人
- 交易记录的自动摘要生成，用于案件调查

**与 Google Cloud 的 AI 合规合作**：
2023 年 JP Morgan 宣布与 Google Cloud 合作，将 LLM 应用于：
- 实时交易监控告警的语义增强（从纯数字告警到自然语言解释）
- 分析师工作台：AI 助理自动准备案件调查所需的背景材料

**误报率改善**：
JP Morgan 合规技术团队公开表示，引入 ML 模型（取代纯规则）后，同等检测率下告警量减少了约 20-30%，分析师工作量相应降低。

### 5.5 HSBC：与 Google Cloud 的 AI AML 专项

2023 年，HSBC 与 Google Cloud 签署合规 AI 合作协议，核心是：

**AI-powered Financial Crime Risk Surveillance**：
- 使用 Google Cloud 的 BFSI（银行金融服务保险）行业 AI 方案
- 将 HSBC 内部的交易图谱与 GNN 模型结合，提升团伙洗钱识别率
- 评估目标：在不增加分析师的情况下将告警精度提升 2-4 倍

**闭环反馈**：HSBC 构建了一套"分析师决策 → 标注 → 模型再训练"的闭环，利用人工判定结果持续优化 ML 模型，解决金融机构长期面临的"有标签数据稀缺"问题。

---

## 六、技术实现的关键挑战

### 6.1 标注数据稀缺

AML 里真正的"正样本"（确认洗钱行为）极其稀少：
- 监管机构不公开已确认的洗钱案例细节
- 金融机构自己的历史 SAR 数据数量有限（年均几千到几万条）
- 假阴性（漏报）难以被标注——未被发现的洗钱行为根本没有标签

**常见应对**：
- 半监督学习（大量无标签数据 + 少量有标签数据）
- 合成数据生成（AMLSim 等模拟器生成洗钱行为的图数据）
- 迁移学习（从欺诈检测任务迁移特征）

### 6.2 数据隐私与监管合规的矛盾

银行无法随意把客户交易数据送到云端大模型 API。实际架构选择：

| 方案 | 适用场景 | 代价 |
|---|---|---|
| 私有化部署 LLM（llama 系列 / 内部微调） | 大型金融机构、数据不能出境 | 推理成本高，需 GPU 基础设施 |
| 脱敏后 API 调用（结构化数据替换真实姓名/账号） | 中小机构，合规审查通过 | 脱敏可能丢失部分语义 |
| Federated Learning（联邦学习） | 多机构联合建模（不共享原始数据） | 工程复杂度极高，落地少 |

### 6.3 可解释性要求

监管要求金融机构能够**解释**为什么对某笔交易或客户提交 SAR。"黑盒模型说可疑"无法满足监管审查。

**实践方案**：
- LIME/SHAP 提供特征重要性解释（"账户在 72 小时内连续小额转账是触发因素，权重 0.38"）
- LLM 生成人类可读的解释文本（基于模型输出特征）
- 规则引擎与 ML 模型并联：规则提供"明显理由"，ML 提供"补充信号"

### 6.4 实时性与批量的权衡

不同场景对延迟要求差异极大：

| 场景 | 延迟要求 | 常见架构 |
|---|---|---|
| 支付拦截（提交交易时） | < 100ms | 轻量规则 + 浅层 ML，无 Agent |
| 交易监控告警生成 | 分钟级 | 批流结合，触发后异步处理 |
| 案件调查 Agent | 分钟到小时级 | 异步 Agent，不阻塞正常业务 |
| SAR 申报 | 监管要求 30 天内 | 人机协作，不要求实时 |

Agent 的使用场景集中在**告警后的调查阶段**，而不是交易的实时拦截决策。这是一个重要的架构边界。

---

## 七、端到端架构蓝图

```
实时数据流（交易、登录、KYC 事件）
           ↓
┌─────────────────────────────┐
│  第一层：实时拦截（<100ms）   │
│  规则引擎 + 轻量 ML 模型      │
│  只做"拦截/放行/标记"三选一   │
└──────────────┬──────────────┘
               ↓ 标记的交易进入调查队列
┌─────────────────────────────┐
│  第二层：告警优先级排序       │
│  GNN 风险评分 + 行为模型      │
│  输出：风险分 0-100           │
└──────────────┬──────────────┘
               ↓ 高风险告警
┌─────────────────────────────┐
│  第三层：自动化调查 Agent     │
│  工具调用：交易图谱 + 制裁    │
│  名单 + 企业注册 + 链上数据   │
│  输出：调查报告草稿 + 建议    │
└──────────────┬──────────────┘
               ↓
┌─────────────────────────────┐
│  第四层：人工审核工作台       │
│  LLM 辅助 SAR 撰写           │
│  分析师确认 → 监管申报        │
└─────────────────────────────┘
```

**人在回路（HITL）的位置**：Layer 3→4 的边界是"机器建议，人做决定"——这是监管可接受的、也是当前 LLM 可靠性水平下合理的边界。完全自动化的 SAR 申报目前监管尚未明确允许，且 LLM 的幻觉风险在法律后果明确的场景下不可接受。

---

## 八、这个方向的产品机会与护城河

:::启发 AML 的数据飞轮比技术更难被复制
金融机构积累的洗钱案例标注数据、分析师的决策记录、SAR 的历史库，是构建 AML AI 的核心资产。有这些数据的大型银行和头部加密交易所，在技术能力之外还有数据壁垒。纯技术 AML 创业公司（如 ComplyAdvantage、Sardine、Unit21）的护城河往往在覆盖多个客户后形成的跨机构信号网络——单一机构看不到的模式，跨机构数据能看到。
:::

**主要玩家分类**：

| 类型 | 代表公司 | 核心壁垒 |
|---|---|---|
| 链上分析 | Chainalysis、Elliptic、TRM Labs | 链上地址标注数据库（亿级） |
| 全栈合规 SaaS | ComplyAdvantage、Sardine | 跨机构风险网络 |
| 银行端 AML 平台 | NICE Actimize、Oracle FCCM | 深度集成、替换成本高 |
| 云厂商 AI 合规 | Google BFSI、Azure 金融服务 | 大模型能力 + 云基础设施 |
| 内部系统 | 蚂蚁天盾、JP Morgan、汇丰 | 海量自有数据 + 内部迭代 |

**AI Agent 创业的机会窗口**：
- **中间市场**（中小银行、区域性金融机构）：大厂 AML 系统价格高昂（年费数百万美元），但监管压力一样存在；AI-native 的轻量级 AML Agent 平台有机会以更低成本切入
- **跨境支付 + Fintech**：Stripe、Wise、Airwallex 这类公司需要 AML 能力但不想自建，SaaS 化的 AML Agent 服务需求明确
- **加密合规工具**：Travel Rule、链上溯源与 CEX 合规集成，仍是相对蓝海（相比传统银行领域）

---

## 九、从 0 到 1 构建 AML 智能平台：场景、技术栈与落地路径

:::观点 从 0 到 1 不等于从头造轮子
AML 平台"从 0 到 1"的挑战不在技术难度，而在**场景优先级选错**和**架构过早复杂化**。大多数失败的建设项目都死于第一年——要么上来就做 Agent，在数据还不干净的时候陷入幻觉；要么照抄大厂架构，用 50 人团队的方案做 5 人 MVP。正确的起点是：找到一个可以在 3 个月内用数据证明价值的具体子场景，其余的等有了 ROI 再说。
:::

### 9.1 场景优先级决策矩阵

并非所有 AML 场景都适合作为起点。以下矩阵按**构建难度**和**业务价值**两个维度评分：

| 场景 | 业务价值 | 构建难度 | 推荐阶段 | 理由 |
|---|---|---|---|---|
| 制裁筛查（名单比对） | ★★★★★ | ★★ | **Phase 0（优先）** | 规则明确、数据外部可购、漏报后果最严重 |
| 交易监控（规则增强） | ★★★★★ | ★★★ | **Phase 1** | 告警量大、误报优化 ROI 显著、有历史数据 |
| SAR 撰写辅助 | ★★★★ | ★★ | **Phase 1** | LLM 直接接入人工流程、效果肉眼可见 |
| 负面新闻监控 | ★★★ | ★★ | **Phase 1** | 数据公开、LLM 擅长文本分类 |
| KYC 风险评分 | ★★★★ | ★★★ | **Phase 2** | 依赖实体图谱建设完成后才准确 |
| GNN 团伙识别 | ★★★★★ | ★★★★ | **Phase 2** | 需要干净的交易图数据和标注 |
| 全自动调查 Agent | ★★★ | ★★★★★ | **Phase 3** | 工具调用链长、幻觉风险高，需 Phase 2 积累 |
| 链上 AML（加密） | ★★★★ | ★★★★ | **专项** | 依赖链上分析 API（Chainalysis/Elliptic），适合加密机构单独建设 |

:::方法 Phase 0 先做制裁筛查的三个理由
一是监管零容忍——制裁漏报罚款是 AML 里单次最贵的错误；二是技术简单——本质是模糊字符串匹配，无需训练数据；三是名单外购——OFAC/UN/EU 制裁名单有成熟 API（Refinitiv、ComplyAdvantage、Dow Jones）可以直接集成，不需要标注数据。Phase 0 大约 6-8 周可以上线，是建立合规团队信任的最佳切入点。
:::

### 9.2 分阶段落地路径

#### Phase 0（第 1-2 个月）：把最高风险的缺口堵上

**目标**：让监管基线合规，不发生可追责的漏报。

```
数据基础
├── 接入核心交易流水（实时 or 日终批量均可）
├── 客户基础数据（姓名、国籍、账号）
└── 制裁名单订阅（OFAC + UN + 本地监管机构）

制裁筛查引擎
├── 多语言模糊匹配（编辑距离 + 音译变体）
├── 实体消歧（同名不同人的区分）
└── 命中 → 人工复核队列（workflow 系统，Jira/自建均可）

审计日志
└── append-only 存储，字段：时间戳/输入实体/名单命中/处理结果/审核人
```

**技术选型**（Phase 0 保持简单）：
- 名单匹配：`rapidfuzz`（Python）+ 自建名单索引，或直接用 ComplyAdvantage API
- 存储：PostgreSQL（交易 + 审计）
- 任务队列：Celery + Redis，或 Temporal（更适合合规审计）
- 前端审核台：内部 Admin 页面，或用 Retool/AppSmith 快速搭

---

#### Phase 1（第 3-5 个月）：把人从误报里解放出来

**目标**：将现有告警误报率降低 30-50%，SAR 撰写时间减半。

**子任务 1：交易监控规则增强**

不要马上做 ML，先把规则做对：

```python
# 规则引擎框架设计原则
class Rule:
    id: str           # 可追溯
    name: str
    risk_type: str    # STRUCTURING / LAYERING / SANCTIONS_EVASION 等
    threshold: dict   # 参数化，不要硬编码
    context: dict     # 客户类型 / 账户类型 / 地区的过滤条件
    score: float      # 风险分贡献（叠加式，不是非此即彼）

# 关键：规则必须可以根据客户段位差异化配置
# 同样 $10,000 转账，个人账户触发，企业流水账户不触发
```

规则运行结果进入**告警优先级队列**，按规则叠加分数排序，分析师优先处理高分告警。

**子任务 2：LLM 辅助 SAR 撰写**

这是 Phase 1 中技术最简单但业务价值最直接的模块：

```
输入数据包（案件触发时自动打包）
├── 账户基本信息（姓名/类型/开户时间/KYC 等级）
├── 告警交易明细（JSON 格式，近 30 天关键交易）
├── 触发规则列表（规则 ID + 触发原因）
├── 制裁名单比对结果
└── 分析师初步标注（如有）

↓ Prompt Template（SAR 撰写专用，含 FinCEN/央行格式要求）

↓ LLM 推理（私有化部署 or 脱敏后 API）

输出
├── SAR 草稿（符合格式、引用原始数据）
├── 关键事实引用（每句附数据来源）
└── 建议风险等级（Low/Medium/High/Urgent）
```

注意：**LLM 只生成草稿，人工分析师必须审核修改后才能提交**。不要绕过这一步，监管逻辑和法律责任都在此处。

**子任务 3：负面新闻监控**

```
数据源：Google News API / Bing News API + 主流财经媒体 RSS
频率：关键客户日监控，全量客户周监控

处理流程：
1. 按客户名称 + 关联实体（公司名/高管名）检索
2. LLM 分类：是否涉及 AML/欺诈/制裁/腐败
3. 实体链接：确认新闻中的实体与本系统客户是同一人（消歧）
4. 相关性评分 + 自动升级到分析师队列
```

---

#### Phase 2（第 6-10 个月）：加入 ML 层，把准确率推到规则的上限之外

**前提条件**：Phase 1 至少积累了 6 个月的人工审核决策记录（有标注数据才能训练）。

**GNN 风险评分**

```
数据准备
├── 构建账户关系图（节点：账户/公司/个人；边：转账/控股/关联地址）
├── 节点特征：KYC 等级、账户年龄、历史风险评分、活跃度
├── 边特征：交易金额、频率、时间间隔
└── 标签：Phase 1 人工审核的案件结果（可疑/正常/未确认）

模型选型
├── 静态图：GraphSAGE（入门，工程简单）
├── 动态图（推荐）：TGN（Temporal Graph Networks）处理交易时序
└── 工具：PyTorch Geometric（PyG）或 DGL

输出：每个账户/交易节点的风险分（0-100），叠加到 Phase 1 的规则分上
```

:::提醒 GNN 训练数据的稀缺问题不要假装不存在
真实的洗钱标注数据极少（大型银行年均几千条确认案件），正负样本比例可能 1:1000。必须用**类别权重调整 + 欠采样/过采样（SMOTE-N）+ 半监督学习**组合应对。不要用 accuracy 评估模型，用 F1（正类）和 PR-AUC；不要在不平衡数据集上调阈值时看 ROC-AUC，它会误导你。
:::

**行为序列模型（补充 GNN）**

```python
# 交易序列 BERT-style 预训练（伪代码）
# 每笔交易 token 化：金额区间 + 交易类型 + 对手方类型 + 时间位置

transaction_tokens = [
    "T_LARGE_INTL_OUT",    # 大额国际汇出
    "T_SMALL_IN",          # 小额入账
    "T_CASH_IN",           # 现金存入
    "T_WIRE_OUT",          # 电汇汇出
    ...
]

# 预训练：MLM（掩码语言模型）在无标签的大量交易序列上
# Fine-tune：有标注的可疑/正常账户序列
# 输出：[CLS] token 的 embedding → 二分类头 → 风险分
```

蚂蚁天盾、京东风控均有类似实践；此模型和 GNN 互补（GNN 捕捉网络结构，序列模型捕捉行为时序），生产中通常集成融合输出。

---

#### Phase 3（第 10 个月以后）：Agent 自动化调查

只有 Phase 2 的 ML 评分稳定可靠、误报率已经降到合理水平后，再做 Agent 才有意义。过早做 Agent 等于让 AI 在噪声数据上自主决策，产出的调查报告会让分析师失去信任。

**Agent 的最小工具集**（参考第四章的设计，Phase 3 实际落地时的工程重点）：

```python
# 每个工具函数都必须满足：
# 1. 幂等（重复调用不产生副作用）
# 2. 有明确的输入/输出 schema（LLM 依赖 schema 描述来正确调用）
# 3. 有超时保护（外部 API 可能慢，不能阻塞整个 Agent）
# 4. 返回置信度 or 数据来源（供 LLM 在报告中引用）

tools = [
    query_transaction_graph,    # 图查询，返回关联账户和路径
    check_sanctions_realtime,   # 制裁名单实时查询
    search_news_entity,         # 负面新闻检索
    lookup_corporate_registry,  # 企业注册信息（接 OpenCorporates 等）
    query_blockchain_address,   # 链上溯源（仅加密机构需要）
    create_sar_draft,           # 生成 SAR 草稿（写入草稿库，不自动提交）
    escalate_to_analyst,        # 升级给人工，附带调查摘要
    auto_close_alert,           # 自动关闭低风险告警（需合规团队授权的场景清单）
]
```

**Agent 编排框架选型**：

| 框架 | 适合场景 | 注意点 |
|---|---|---|
| LangGraph | 有明确状态机的调查流程（推荐） | 图结构编排，支持循环和条件分支，便于审计 |
| LlamaIndex Agent | 以 RAG 为核心的案件信息检索 | 文档密集型调查（KYC 文件分析）效果好 |
| 自研 Plan-Execute | 定制化要求高、需要深度合规审计 | 工程量大，但可控性最强，大机构最终往往自研 |

:::方法 Agent 的自动化率分层是工程决策，不是技术决策
Phase 3 上线时，建议初始只开放"低风险告警自动关闭"的自动化权限，其余全走人工复核。自动化率的提升要基于**数据审计**（对比 Agent 自动关闭的告警与人工追踪结果，确认没有漏报），不要一开始就设定高自动化目标。这既是监管要求，也保护你的 Agent 系统在分析师中建立信任。
:::

### 9.3 完整技术栈清单

```
┌────────────────────────────────────────────────────────────────┐
│  数据层                                                         │
│  Kafka/Pulsar（实时交易流）                                      │
│  Flink / Spark Streaming（流处理，窗口聚合）                     │
│  ClickHouse / BigQuery（OLAP，历史分析）                         │
│  PostgreSQL（交易明细 + 审计日志）                               │
│  Neo4j / TigerGraph / Nebula Graph（账户关系图）                 │
│  Redis（低风险缓存 + 制裁名单热缓存）                             │
├────────────────────────────────────────────────────────────────┤
│  ML/AI 层                                                       │
│  PyG / DGL（GNN 训练 + 推理）                                   │
│  Hugging Face Transformers（行为序列模型）                        │
│  scikit-learn / XGBoost（规则辅助特征工程）                       │
│  MLflow / Weights & Biases（模型实验管理 + 版本追踪）             │
│  SHAP / LIME（可解释性，监管要求）                               │
├────────────────────────────────────────────────────────────────┤
│  LLM 层                                                         │
│  Claude 3.5 / GPT-4o（API 调用，脱敏数据场景）                   │
│  LLaMA 3 / Qwen 2.5（私有化部署，敏感数据场景）                  │
│  vLLM / SGLang（私有化推理服务）                                 │
│  LangSmith / Langfuse（LLM 调用 tracing + 评测）                │
├────────────────────────────────────────────────────────────────┤
│  Agent 编排层                                                    │
│  LangGraph（状态机编排，带循环控制）                              │
│  Temporal（工作流引擎，审计友好，支持长时间任务）                  │
│  自定义 Plan-Execute 框架（大机构合规要求高时）                   │
├────────────────────────────────────────────────────────────────┤
│  基础设施层                                                      │
│  Kubernetes（服务编排）                                          │
│  Prometheus + Grafana（系统监控）                                │
│  OpenTelemetry（分布式 tracing）                                 │
│  Weaviate / Pinecone（向量检索，外部新闻/文件 RAG）              │
│  HashiCorp Vault（密钥管理，API 凭证轮换）                       │
└────────────────────────────────────────────────────────────────┘
```

**外部数据服务集成（不需要自建）**：

| 数据类别 | 推荐供应商 | 用途 |
|---|---|---|
| 制裁名单 | Refinitiv World-Check、ComplyAdvantage、Dow Jones | OFAC/UN/EU 名单 + 模糊匹配 |
| 链上地址分析 | Chainalysis KYT、Elliptic、TRM Labs | 加密地址风险评分 |
| 企业注册信息 | OpenCorporates API、Dun & Bradstreet | 受益所有人穿透 |
| 新闻/媒体 | Dow Jones Factiva、LexisNexis | 负面新闻结构化数据 |
| PEP 数据库 | WorldCompliance、Acuris | 政治公众人物名单 |

### 9.4 三个关键工程决策

:::方法 决策一：私有化部署 LLM 还是用 API？
判断框架：**客户个人信息（姓名、账号、交易金额）是否会出现在 LLM 输入中？**

- 如果是 → 必须私有化部署（LLaMA/Qwen/Mistral 系列），或对输入做完整脱敏（用占位符替换 PII）再调 API
- 如果否（仅结构化统计摘要，无 PII）→ 可以调用外部 API

大多数 SAR 撰写场景是前者，因为 SAR 内容本身包含客户信息。私有化部署的推理成本已经大幅下降（A100 节点跑 Llama3-70B 的推理成本约 $0.3/M tokens），对于中等规模金融机构是可接受的。
:::

:::方法 决策二：图数据库选什么？
- **起步阶段**：用 PostgreSQL 的递归 CTE 查询账户关系，省去引入额外组件的成本；一跳关联查询延迟 < 50ms，足够支撑 Phase 1
- **Phase 2 规模化**：账户节点超过千万后迁移到专用图数据库；Neo4j 社区版有免费额度，适合国际场景；国内大厂偏向 NebulaGraph（开源）或自研图计算引擎（蚂蚁 GraphScope）
- **实时图更新**：每笔新交易要能实时更新图结构，不能等批量重建；TigerGraph 在这点上工程成熟度较高

选型的核心是：不要在 Phase 0 就引入图数据库，把架构复杂化的决策推迟到数据量真正需要的时候。
:::

:::方法 决策三：告警工作流用自建还是买现成？
- **自建**：适合有 2 人以上后端工程师的团队，用 Temporal 做工作流引擎（天然支持审计日志、重试、长时间流程）
- **买现成**：ServiceNow（大机构）或 Linear/Jira（早期小团队）配合 webhook 触发 Agent；低成本起步，代价是和现有合规系统集成时灵活性差
- **合规 SaaS 托管**：如果机构规模小（< 20 人合规团队），直接用 Unit21、Sardine 这类 AML SaaS 买告警管理功能，而不是自建；只在有充分 ROI 依据时才考虑自建

判断标准：年处理告警量 > 10 万条，或有明确的定制化监管要求，才有必要自建工作流系统。
:::

### 9.5 第一年最容易踩的五个坑

:::提醒 AML 平台从 0 到 1 的五个高频陷阱
**1. 数据接入低估了一倍的工作量**：交易数据在不同系统（核心银行、支付网关、外汇系统）格式各异，字段含义不一致，时区和货币换算错误，脏数据远比预期多。预留 30% 的工程资源做数据清洗和对齐，不要假设数据"差不多能用"。

**2. GNN 在训练集上看起来很好，上线后立刻漂移**：洗钱手法在变，旧的历史案例标注不代表新的洗钱模式。必须设立**月度模型性能审查**机制，当 F1（正类）下降超过 5% 时触发再训练；不要把 ML 模型当"训练一次、用三年"的系统。

**3. 合规团队不信任 AI 输出，导致 Agent 实际使用率极低**：合规分析师对 AI 的信任是赢出来的，不是要求出来的。建议先从"AI 帮你搜集信息"（工具层）开始，不要直接推"AI 给结论"。让分析师看到 AI 省了他们的哪些具体时间，信任会自然建立。

**4. 可解释性接口是事后补的**：监管审查时要求解释某个案件的风险评分来源，临时加解释性接口往往数据已经不完整。可解释性要从 Phase 1 就内嵌到每个告警记录中——告警记录不只有风险分，必须附上"触发规则列表 + 每条规则的贡献权重"。

**5. 忽略审计日志的不可篡改性**：把审计日志和业务数据放在同一个 PostgreSQL 表里，开发时为了方便偶尔 UPDATE 了一条记录——这会在监管检查时产生严重问题。审计日志必须用 append-only 存储（PostgreSQL 的 `INSERT ONLY`表或专用审计库如 Immudb），且要设置删除权限管控。
:::

### 9.6 三个月 MVP 检查清单

拿着这份清单评估 Phase 1 MVP 是否可以向合规团队演示：

```
数据接入
□ 核心交易流水接入，延迟 < 5 分钟
□ 客户基础数据同步，含 KYC 等级
□ 制裁名单每日自动更新（含 OFAC + 本地监管名单）

制裁筛查
□ 模糊匹配命中率 > 95%（用历史制裁案例验证）
□ 假阳性率（误报）< 5%（经合规团队确认）
□ 命中 → 人工队列延迟 < 30 秒

交易监控
□ 至少 5 条核心规则上线（分拆/循环/大额阈值/新账户异常/地区高风险）
□ 告警优先级排序，分析师不需要手动决定处理顺序
□ 告警队列处理率 > 80%（不积压）

SAR 辅助
□ 案件触发时自动打包输入数据（< 10 秒）
□ LLM 草稿生成 < 60 秒
□ 草稿准确率：分析师修改率 < 30%（经第一个月使用数据验证）

审计与合规
□ 每条告警有完整的 trace（触发原因 / 规则版本 / 处理人 / 最终决定）
□ 审计日志 append-only，不可修改
□ SAR 草稿不能直接提交，必须有人工确认步骤
□ 合规团队已完成系统使用培训并签字确认
```

---

## 参考文献

### 监管与行业报告

1. FATF (2023). Virtual Assets and Virtual Asset Service Providers. Financial Action Task Force. [fatf-gafi.org](https://www.fatf-gafi.org/en/topics/virtual-assets.html)
2. FinCEN (2020). Anti-Money Laundering Act of 2020. U.S. Financial Crimes Enforcement Network. [fincen.gov](https://www.fincen.gov/anti-money-laundering-act-2020)
3. LexisNexis Risk Solutions (2023). True Cost of Financial Crime Compliance Study — Global Report. [risk.lexisnexis.com](https://risk.lexisnexis.com/global/en/insights-resources/research/true-cost-of-financial-crime-compliance-study-global-report)
4. Chainalysis (2024). Crypto Crime Report 2024. Chainalysis Inc. [go.chainalysis.com](https://go.chainalysis.com/crypto-crime-2024.html)
5. 中国人民银行 (2024). 中华人民共和国反洗钱法（2024年修订）. [pbc.gov.cn](https://www.pbc.gov.cn/tiaofasi/144941/144951/5548765/index.html)

### 学术论文

6. Weber, M., et al. (2019). Anti-Money Laundering in Bitcoin: Experimenting with Graph Convolutional Networks for Financial Forensics. KDD Workshop on Anomaly Detection in Finance. [arxiv 1908.02591](https://arxiv.org/abs/1908.02591)
7. Pareja, A., et al. (2020). EvolveGCN: Evolving Graph Convolutional Networks for Dynamic Graphs. AAAI 2020. [arxiv 1902.10191](https://arxiv.org/abs/1902.10191)
8. Liu, Y., et al. (2021). Pick and Choose: A GNN-based Imbalanced Learning Approach for Fraud Detection. WWW 2021. [acm.org](https://dl.acm.org/doi/10.1145/3442381.3449989)
9. Alarab, I., et al. (2020). Competence of Graph Convolutional Networks for Anti-Money Laundering in Bitcoin Blockchain. ICMLT 2020. [acm.org](https://dl.acm.org/doi/10.1145/3409073.3409080)
10. Rossi, E., et al. (2020). Temporal Graph Networks for Deep Learning on Dynamic Graphs. ICML GRL Workshop. [arxiv 2006.10637](https://arxiv.org/abs/2006.10637)

### 技术博客与白皮书

11. Ant Group (2021). GraphScope: A One-Stop Large-Scale Graph Processing System. VLDB 2021. [arxiv 2111.00333](https://arxiv.org/abs/2111.00333)
12. Google Cloud (2023). How HSBC fights money launderers with artificial intelligence. Google Cloud Blog. [cloud.google.com](https://cloud.google.com/blog/topics/financial-services/how-hsbc-fights-money-launderers-with-artificial-intelligence)
13. Chainalysis (2023). Binance Compliance Program: Noah Perlman on rebuilding after the DOJ settlement. Chainalysis Blog. [chainalysis.com](https://www.chainalysis.com/blog/binance-compliance-program-ep-105/)
14. ComplyAdvantage (2023). The State of Financial Crime 2024 Report. [get.complyadvantage.com](https://get.complyadvantage.com/insights/the-state-of-financial-crime)
15. TRM Labs (2024). 2024 Crypto Adoption and Illicit Activity Report. [trmlabs.com](https://www.trmlabs.com/reports-and-whitepapers/2024-crypto-adoption-and-illicit-exposure-report)

### 行业新闻与官方公告

16. U.S. Department of Justice (2023). Binance and CEO Plead Guilty to Federal Charges in $4B Resolution. [justice.gov](https://www.justice.gov/archives/opa/pr/binance-and-ceo-plead-guilty-federal-charges-4b-resolution)
17. OFAC (2023). OFAC Settles with Binance Holdings Limited. U.S. Treasury. [ofac.treasury.gov](https://ofac.treasury.gov/system/files/2023-11/20231121_binance.pdf)
18. CoinDesk (2023). Binance to Settle Charges with US DOJ. [coindesk.com](https://www.coindesk.com/policy/2023/11/21/binance-to-settle-charges-with-us-doj-source)
19. Google Cloud Press Corner (2023). Google Cloud Launches AI-Powered Anti Money Laundering Product for Financial Institutions. [googlecloudpresscorner.com](https://www.googlecloudpresscorner.com/2023-06-21-Google-Cloud-Launches-AI-Powered-Anti-Money-Laundering-Product-for-Financial-Institutions)
20. Google Cloud. Anti Money Laundering AI — product overview. [cloud.google.com](https://cloud.google.com/anti-money-laundering-ai)
