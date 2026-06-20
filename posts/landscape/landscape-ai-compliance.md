# AI 合规落地全景：从 KYC 到合同审查的六大场景与最佳实践

:::观点 合规是 AI 最有说服力的企业落脚点之一
合规天然满足 AI 落地的三个条件：**数据量大**（银行每年处理数十亿笔交易和文件）、**规则复杂**（监管法规多到没有人能全量记住并实时跟踪）、**成本高**（BCG 数据：全球金融机构每年合规支出超 2700 亿美元，约 70% 是人工成本）。但合规对 AI 的要求也最苛刻——**可解释、可审计、不能漏报**。这个矛盾是合规 AI 产品的核心张力，也是大多数落地方案在"跑起来"和"真正上生产"之间卡住的地方。
:::

合规不是单一场景，而是一类场景的集合：从金融机构的客户身份核验，到律所的合同风险审查，再到科技公司的数据隐私管理，不同行业的合规需求在技术上高度同构——都涉及大量文本处理、规则匹配和风险判断。本文拆解六个最成熟的落地场景，并给出跨场景的通用最佳实践。

> **阅读提示**：反洗钱（AML）是合规 AI 里技术积累最深的子场景，本站有专文深度拆解（[反洗钱 × AI Agent：从规则引擎到智能体的合规革命](#/post/landscape-aml-agent)），本文不重复，而是聚焦其他五个场景与一个横切视角。

---

## 一、合规 AI 的特殊性

在进入具体场景前，先理解一件事：**合规 AI 和大多数企业 AI 的落地逻辑根本不同**。

| 维度 | 普通企业 AI | 合规 AI |
|---|---|---|
| 优化目标 | 效率最大化 | 不漏报（宁可误报）|
| 可解释性 | 可选 | 必须（监管要看决策依据）|
| 失败后果 | 业务损失 | 监管处罚 + 法律责任 |
| 迭代速度 | 快速 A/B | 需要模型验证 + 治理流程 |
| 决策方式 | 自动化为主 | 大多数场景 HITL（人机协作）|
| 数据约束 | 尽量多 | 数据隐私合规 + 偏见审计 |

:::提醒 合规场景的核心约束：不是"更准"，是"不漏"
合规 AI 的评价体系和 recall/precision 的通常权衡截然不同：**漏掉一个真实风险**（False Negative）的成本远高于**误报一个正常案例**（False Positive）。这直接影响模型选型、阈值设定，甚至整个产品交互设计——误报多了会让分析师疲劳，但基准一定是先保证召回。在不同场景下这个偏向程度不同（AML 宁可 99% 误报率，KYC 证件核验可以相对均衡），落地时要先确认该场景对两类错误的相对成本。
:::

---

## 二、六大核心场景

### 场景一：KYC / 客户尽职调查

**背景**：KYC（Know Your Customer）是金融机构准入的第一道门——核验客户身份、评估风险等级、持续监控状态变化。传统 KYC 依赖人工核查证件加数据库比对，开户周期长达 3–10 天，合规质量参差不齐，且存量客户的定期复审几乎不可能按时完成。

**AI 在 KYC 的应用层次**：

```
L1 文件核验：OCR + 防伪检测 → 证件真实性 + 信息抽取
L2 身份核验：人脸比对 + 活体检测 → 本人在场核实
L3 风险评分：实体解析 + 关系图谱 + LLM 综合 → KYC 风险等级（低/中/高/EDD）
L4 持续监控：制裁名单变更 + 负面新闻监控 + 行为基线 → 存量客户风险动态更新
```

**技术栈与选型**：

| 环节 | 主流方案 | 注意点 |
|---|---|---|
| 证件 OCR | AWS Textract / Google Document AI / 专属证件识别模型 | 多国证件格式差异大，需要按地区适配 |
| 防伪检测 | 分类模型（GAN 生成图检测）+ 元数据分析 | 深度伪造技术持续演进，需要定期更新检测模型 |
| 活体检测 | 挑战-响应式（动作指令）+ 被动式（深度学习） | 高安全场景用双模式，低摩擦场景用被动式 |
| 实体解析 | SpaCy / GLiNER + 自定义 NER，或 LLM 抽取 | PEP（政治公众人物）、UBO（实际受益所有人）识别准确率是关键指标 |
| 名单筛查 | 结构化数据库比对（OFAC、UN、EU 等）+ 模糊匹配 | 多语言姓名音译变体是主要难点，ComplyAdvantage / Refinitiv 等专业库有预处理优势 |
| 负面新闻监控 | LLM 分类 + 向量检索 + 实体链接 | 假正率是最大问题，同名实体消歧是核心难点 |

:::方法 KYC AI 落地的三个关键设计决策
**1. 证件类别分层**：不同国家、不同类型证件的 OCR 精度差异很大。不要用一个通用模型，要按地区和证件类型分流，复杂或可信度低的证件引导人工复核。

**2. 风险评级的确定性 vs. 模型**：最终风险等级（低/中/高）必须有明确的决策规则，可以由 AI 辅助评分，但最终分层逻辑要可审计、可追溯——"因为模型说高风险"不是监管能接受的答案。

**3. 存量客户触发机制**：持续监控不能每天全量跑，要建触发机制——制裁名单变更立即触发；负面新闻当天触发；无变化客户按风险等级定期复审（高风险客户年度复审，低风险三年一次）。全量每日运行成本高且产生大量无效噪声。
:::

**真实案例**：HSBC 部署 LLM 辅助增强尽职调查（EDD）报告撰写，将 EDD 报告生成时间从平均 4 小时缩短至约 45 分钟，合规分析师从"撰写"转为"审核"角色，处理量提升约 5 倍 \[1\]。

---

### 场景二：合同与法律文件智能审查

**背景**：法律文件审查是合规成本最高的人工密集型任务之一——大型并购交易涉及数万页合同，尽职调查期限通常 4–6 周，律师每小时成本数百到数千美元。JP Morgan 著名的 COIN 系统每年处理约 12,000 份商业贷款协议，完成的工作量过去需要律师 36 万小时 \[2\]。AI 在这里的价值不是替代法律判断，而是**大幅缩短人工需要审阅的范围**。

**应用分层**：

```
信息提取层：关键条款定位 + 实体/日期/金额/期限抽取
对比分析层：与标准条款库对比，标注偏差点（高于/低于标准）
风险标注层：高风险条款自动标红（免责上限缺失、不对等赔偿、单方面终止权）
摘要生成层：长合同压缩为关键信息摘要，供律师快速决策
问答层：合同上下文问答（"这份合同的通知期是多少天？"、"哪些条款适用于数据泄露？"）
变更追踪层：对比合同版本迭代，自动标注每轮谈判的条款变化
```

**成熟产品对比**：

| 产品 | 定位 | 核心能力 | 适用场景 |
|---|---|---|---|
| Harvey AI | LLM Native 法律助手 | 合同起草、审查、法律研究 | 律所、企业法务团队 |
| Kira Systems (Litera) | 专业合同 AI | 预训练法律条款分类器 + 抽取 | M&A 尽职调查 |
| Ironclad | 合同生命周期管理 | AI 辅助谈判 + 合规追踪 | 企业合同管理 |
| ContractPodAi | 合同智能平台 | 合同数据库 + 风险分析 + 续期提醒 | 大型企业 CLM |
| Microsoft Copilot + Azure OpenAI | 通用平台 | GPT 驱动的文件理解与生成 | 企业私有化部署 |

:::方法 合同审查 AI 的最佳实践
**定义风险条款的分类体系**：合同 AI 需要一个精确定义的条款分类 taxonomy，才能把"标注高风险"做准确。不要让模型自由判断"这是不是危险"，要给出明确的分类标准（如：免责上限 < 100 万 → 低；无赔偿上限 → 高风险）并由法务团队维护。

**对比标准条款库**：最有价值的功能是和公司自己的"标准合同模板"对比——偏离标准的地方才是审查重点。这比做通用风险判断精确得多，且更容易校准误报率。

**置信度可视化**：对抽取结果一定要展示置信度，让律师知道哪些字段是高置信度直接用、哪些字段需要 double-check。不要把低置信度结果当作确定结论展示，这会侵蚀专业用户的信任。
:::

:::提醒 COIN 案例的重要前提
JP Morgan 的 COIN 是定向优化的——只处理特定格式的商业贷款协议，不是通用合同理解系统。"AI 秒处理 36 万小时工作"的前提是几年的训练数据积累和严格的场景约束。直接把这个数字当作"部署一个通用合同 AI 的预期效果"是不现实的。
:::

---

### 场景三：监管报告自动化

**背景**：金融机构每年要向监管机构提交数百份报告，包括 Basel III 资本充足率报告、SREP（监管审查评估流程）叙述性内容、DORA 运营韧性自评估、MiFID II 最佳执行报告等。这些报告需要从多个异构系统抽取数据、做数学计算、撰写叙述性分析，然后经过多轮内部审核。

**AI 的切入点**：

```
数据汇总层：从 30+ 系统自动拉取、清洗、校验数据一致性 → 消除人工拷贝粘贴
计算引擎：确定性代码（不用 LLM）完成资本计算 + 异常检测
叙述性生成：LLM 根据结构化数据生成标准叙述段落（"本季度资本充足率...主要受...影响"）
差异解释：与上期报告对比，自动生成"本期主要变化原因"初稿
合规检查：对照监管模板，自动标注缺失字段和格式偏差
翻译与本地化：同一报告按不同司法管辖区要求生成对应版本
```

:::提醒 监管报告的核心数字不能用 LLM 算
LLM 不做可靠的数学运算。监管报告里的资本充足率、流动性覆盖率、杠杆比率这类**精确计算必须走确定性代码**——Excel 模型、Python 或专业 BI 工具都行，但绝对不能让 LLM 生成数字本身。LLM 的角色是理解数据、生成叙述、解释变化。这是监管报告 AI 最重要的架构原则：**生成在 LLM，计算在确定性系统，两套系统不能混用**。
:::

**效果参考**：德勤、毕马威的多家欧洲银行客户已部署 LLM 辅助 SREP 叙述段落生成，报告撰写时间减少 40–60%，但所有叙述仍需 Chief Compliance Officer 审核后签字 \[3\]。监管机构的签字要求短期内不会消失，AI 的价值是让签字这件事从"3 天审核"变成"30 分钟确认"。

---

### 场景四：监管变更追踪与影响分析（RegTech）

**背景**：全球监管法规每天都在变——Basel 修正案、MiFID II 补丁、DORA 实施细则、GDPR 执法指南……仅欧美地区每年发布的监管文件超过 5 万份 \[12\]。人工跟踪所有相关法规变化是不可能的，但遗漏关键变化可能导致数百万美元的合规缺口。

**AI 流程**：

```
数据采集：监管机构官网 RSS + API + 新闻聚合
         （覆盖：SEC、FCA、EBA、MAS、HKMA、银保监、证监会等）
分类过滤：LLM 分类 → 与本机构相关的变化（按业务线/地区/产品类型过滤）
变化解析：新版 vs. 旧版 diff → 自动标注新增/删除/修改的条款
影响评估：结合内部业务描述，评估影响的系统、流程、文件清单
工单生成：触发 Jira/ServiceNow 工单，分配给对应合规/技术/法务团队
```

**代表性产品**：

| 产品 | 核心定位 |
|---|---|
| Compliance.ai | 监管法规库 + AI 影响分析，覆盖 400+ 全球监管机构 |
| Clausematch | 监管变更 → 内部政策 mapping + 合规缺口分析 |
| Ascent RegTech | 中小银行监管要求自动化 mapping |
| Thomson Reuters Regulatory Intelligence | 监管新闻 + 变更追踪专业数据库 |

:::方法 RegTech AI 落地的核心难点：监管文本的模糊性
监管文件不是精确规范，充满"应当"、"酌情"、"合理措施"等模糊表述。AI 能做的是**标注出模糊地带，让合规律师聚焦在真正需要判断的地方**，而不是给出确定性的"合规/不合规"结论。产品设计时要避免把 AI 的判断包装成"权威答案"——这是监管机构最反感的做法，也是最容易引发监管质疑的设计错误。
:::

---

### 场景五：员工合规培训与政策问答助手

**背景**：每家金融机构都有几十到几百份内部合规政策文件（反洗钱政策、礼品与款待政策、内幕信息处理规程、个人账户交易申报要求……）。员工培训通过率是合规部门的 KPI，但培训效果差（记了就忘），员工遇到实际问题时很难快速找到正确答案，结果是合规团队每天被琐碎的政策查询淹没。

**这是 RAG Bot 的理想场景**，原因是：

- **知识范围明确**：内部文件有限，不需要通用知识
- **问题结构化**：员工的高频问题是有限集合的（"礼品上限是多少？"、"这笔交易需要申报吗？"）
- **可溯源**：回答必须附出处，合规部门能验证准确性，也满足审计要求
- **误差代价可控**：答错了有人工兜底，比 AML 漏报风险低——适合作为 RAG Bot 的起步场景

:::方法 合规政策 RAG 的四个关键设计点
**1. 政策有效期管理**：政策文件有版本，旧版本要标记过期，否则员工拿到过时答案。检索时要过滤已过期的文档版本，这是最容易被忽视的数据治理问题。

**2. 管辖地过滤**：香港的反洗钱政策和新加坡的不同，员工提问时必须能识别地区上下文（来自用户 profile 或明确追问），避免给出错误地区的政策答案。

**3. 不确定性的明确表达**：政策 AI 一定要在不确定时说"我不确定，建议联系合规部门"，而不是自信地给出可能错误的答案。这是合规场景 RAG 与普通客服 RAG 的最大差异——宁可多转人工，不能给出有把握的错误答案。

**4. 审计日志**：每一次员工查询 + AI 回答都要落库，满足监管检查时"你们如何确保员工获得合规指导"的证明要求。
:::

---

### 场景六：数据隐私合规（GDPR / CCPA / 个人信息保护法）

**背景**：数据隐私法规在全球加速落地——欧盟 GDPR（2018）、美国 CCPA（2020）、中国个人信息保护法（2021）——每一部法律都要求企业知道自己收集了哪些个人数据、存在哪里、如何使用、如何删除。对大型企业来说，仅仅完成一次数据 mapping 就是一个工程级任务。

**AI 在数据隐私合规的角色**：

```
数据发现：扫描数据库/日志/文件，识别 PII
         （姓名/手机/身份证/邮箱/IP/生物特征等）
数据分类：自动打标签（个人数据/敏感数据/匿名化数据/假名化数据）
数据流 mapping：追踪个人数据从采集→存储→使用→共享→删除的完整链路
DSR 处理：自动化处理数据主体请求（删除/访问/更正/可携带）
泄露检测：日志分析 + 异常访问检测 → 识别潜在数据泄露行为
DPIA 辅助：数据保护影响评估文档辅助撰写
```

| 工具 | 核心功能 | 定位 |
|---|---|---|
| BigID | PII 自动发现 + 分类 + 权限分析 | 数据安全 + 隐私合规平台 |
| OneTrust | 同意管理 + 数据 mapping + DSR 自动化 | 综合隐私管理平台 |
| Collibra | 数据目录 + 数据血缘追踪 | 大型企业数据治理 |
| Privacera | 云数据访问控制 + PII 脱敏 | 云原生数据合规 |
| AWS Macie | S3 中 PII 自动发现 + 分类 | AWS 生态原生，快速起步 |

:::提醒 AI 扫描出的 PII，人工复核是必须的
自动 PII 发现工具的召回率通常在 80–90%，意味着仍有 10–20% 的个人数据没有被发现。在 GDPR 最高罚款全球营业额 4% 的背景下，仅靠 AI 扫描不够——要有抽样人工复核机制，尤其是**非结构化数据**（PDF、图片、邮件正文）的 PII 发现准确率远低于结构化数据库字段。
:::

---

## 三、通用最佳实践

跨越以上六个场景，以下是合规 AI 产品落地中反复出现的工程最佳实践。

### 1. 人机协作（HITL）设计

:::方法 合规场景的 HITL 不是"可选项"，是产品设计的起点
合规 AI 产品的核心价值主张是**让人工分析师处理更多、处理得更好**，而不是替代人的判断。这意味着：

- AI 的输出是分析师的工作输入（预填充、优先级排序、风险标注），而不是最终决策
- 产品界面要为"审核→确认→覆写"的工作流设计，不是为了减少人工点击而把确认步骤隐藏
- 分析师的每一次覆写都是宝贵的训练信号，要系统性收集和分析

**不要**把产品设计成"AI 全自动化，再配一个人工审核通道"——这是顺序装错了。应该是"AI 加速了人的判断效率"，而不是"人在确认 AI 的自主决策"。两种设计在监管眼里的责任归属完全不同。
:::

### 2. 可解释性与决策依据

合规 AI 的决策必须能向监管机构解释：

- **逐条归因**：风险评分升高，要能说出"因为实体 X 与制裁名单存在关联，且过去 30 天发生 Y 笔大额转账"
- **引用来源**：LLM 生成的任何合规判断，都要附原始政策/法规片段作为依据
- **决策日志**：每一次 AI 决策都要有 timestamp、输入、输出、规则版本的不可篡改记录

黑盒模型在高风险合规场景通常无法通过模型验证——美联储 SR 11-7 的模型风险管理指引对此有明确要求 \[5\]，欧盟 AI Act 对高风险 AI 系统也规定了强制性透明度义务 \[6\]。

### 3. 审计追踪

每一条合规决策记录需包含：

```
- 决策时间（ISO 8601 精确到秒）
- 输入数据（hash + 可还原的原始值，注意 PII 脱敏存储）
- 模型版本 + 规则集版本
- 决策输出 + 置信度 / 风险评分
- 负责人工审核员 ID（如有）
- 最终决定（系统建议 vs. 人工覆写）
- 覆写原因（结构化选项 + 自由文本）
```

审计日志要写入 append-only 存储（不可篡改），保留期限按监管要求设定（通常 5–7 年，部分司法管辖区更长）。

### 4. 模型治理与验证

:::方法 合规 AI 的模型治理四步
**第一步：模型注册**：所有生产模型要有 model card，记录训练数据来源、评估指标、已知局限性和偏见风险。

**第二步：独立验证**：模型上线前由与开发团队独立的验证团队做第二轮评估（对应 SR 11-7 三线防御原则 \[5\]）。LLM 作为核心判断引擎时，验证要包含对抗测试和分布外测试。

**第三步：生产监控**：持续监控模型输入分布和输出分布，检测概念漂移——监管规则变了，但模型还在按旧规则判断是最常见的生产漂移场景。

**第四步：退休规划**：定义模型退役条件（精度下降超过阈值、法规发生重大变更、底层 LLM 版本被废弃），不要让过期模型在生产继续运行。
:::

### 5. 偏见与公平性审计

合规 AI 在 KYC、信贷等场景存在歧视风险——如果训练数据反映了历史上的不公平做法（如特定地区的客户被拒绝率更高），模型会放大这种偏见。

- 定期做人口统计维度的公平性评估（按性别、地区、国籍分桶对比决策结果）
- 发现统计显著差异时，需要有解释和修正机制，记录在案
- 欧盟 AI Act 对信贷、保险等高风险 AI 系统规定了强制性公平性评估义务 \[6\]

---

## 四、常见落地陷阱

:::提醒 五个在合规 AI 项目里反复出现的失败模式
**1. 把 AI 当"银弹"而非"放大镜"**：AI 最适合有规则可循的重复性任务（名单比对、格式检查、信息抽取）。把它用在需要人类判断边界情况（如新型欺诈模式）的地方，会产生大量错误决策且难以解释。

**2. 忽略数据质量**：合规 AI 的性能上限由历史标注数据质量决定。历史数据包含人工的偏见和不一致标注，未清洗直接训练，模型会放大这些问题，且很难在事后追溯。

**3. 监管沟通不足**：很多机构在自行开发合规 AI 后才发现，监管机构对 AI 决策有明确要求（如"必须有分析师签字"、"不能用 black-box 模型做信贷决策"）。早期与主管机构沟通，或申请监管沙盒，能避免后期大规模返工。

**4. 过度自动化**：把 AI 部署成全自动决策，没有有效的人工复核。出了问题，"是算法决定的"不是合法的免责理由——在 GDPR 框架下，全自动化对个人有重大影响的决策甚至需要获得明确授权。

**5. 黄金集腐化**：合规规则在变，但评测数据集没有同步更新。模型在旧规则上还是 95 分，在新规则下却漏报了 30%。评测集的维护优先级要和模型训练同等对待，合规团队要参与 case 的验收。
:::

---

## 五、行业参与者全景

| 类别 | 代表厂商 | 核心能力 |
|---|---|---|
| **金融合规平台** | Actimize (NICE), Temenos, Fiserv | 交易监控、反洗钱、KYC 全套解决方案 |
| **RegTech** | Compliance.ai, Clausematch, Ascent | 监管变更追踪、法规影响分析 |
| **合同 AI** | Harvey AI, Kira Systems, Ironclad, ContractPodAi | 合同审查、谈判支持、CLM |
| **数据隐私** | OneTrust, BigID, Collibra, Privacera | 数据 mapping、DSR 自动化 |
| **KYC / 身份核验** | Jumio, Onfido, Stripe Identity, ComplyAdvantage | 证件核验、活体检测、名单筛查 |
| **自研（大行）** | JP Morgan (COIN), HSBC (ComplianceAI), Goldman | 定向优化内部场景，技术自研 |
| **咨询 + 平台** | Deloitte RegConnect, Accenture ComplianceEngine, PwC Halo | 咨询 + 技术一体化交付 |

---

## 六、落地优先级决策框架

:::方法 合规 AI 的三步选场景
**第一步：数据量和规则明确性**

数据量大 + 规则明确（如制裁名单比对、格式校验）→ 高度适合自动化，先从这里开始。

数据量小或规则模糊（如新型欺诈判断）→ 先做 AI 辅助，人工主导，积累标注数据后再扩大自动化比例。

**第二步：错误代价非对称性**

漏报代价极高（如 AML 合规）→ 高召回率优先，容忍更高误报率，配强人工二次审核。

误报代价也很高（如 KYC 导致正常客户开户失败）→ 召回率和精确率需要更精细的权衡，不能只优化一侧。

**第三步：监管明确性**

监管已有明确 AI 使用指引（如 EBA 关于 ML 在 IRB 模型中的讨论文件 \[7\]）→ 按指引设计，确保合规 AI 本身合规。

监管态度不明朗 → 早期与主管机构沟通，或申请监管科技沙盒（MAS、FCA、金管局均有运营）后再全量上线。
:::

---

## 参考文献

\[1\] HSBC Group. (2023). *Annual Report and Accounts 2023: Technology and Innovation*, pp. 42–44. HSBC Holdings plc. Retrieved from https://www.hsbc.com/investor-relations/results-and-announcements/annual-results/2023

\[2\] Loten, A. (2017, February 28). JPMorgan Software Does in Seconds What Took Lawyers 360,000 Hours. *The Wall Street Journal*. Retrieved from https://www.wsj.com/articles/jpmorgan-software-does-in-seconds-what-took-lawyers-360-000-hours-1490366279

\[3\] Deloitte. (2023). *AI-Powered Regulatory Reporting: Transforming Compliance in Financial Services*. Deloitte Center for Financial Services. Retrieved from https://www2.deloitte.com/us/en/insights/industry/financial-services/ai-regulatory-reporting.html

\[4\] McKinsey & Company. (2023). *The economic potential of generative AI: The next productivity frontier*, Chapter 5: Financial Services. McKinsey Global Institute. Retrieved from https://www.mckinsey.com/capabilities/mckinsey-digital/our-insights/the-economic-potential-of-generative-ai

\[5\] Board of Governors of the Federal Reserve System & Office of the Comptroller of the Currency. (2011). *Supervisory Guidance on Model Risk Management* (SR 11-7). Retrieved from https://www.federalreserve.gov/supervisionreg/srletters/sr1107.htm

\[6\] European Parliament and Council. (2024). *Regulation (EU) 2024/1689 on Artificial Intelligence (EU AI Act)*, Article 6 and Annex III. Official Journal of the European Union. Retrieved from https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R1689

\[7\] European Banking Authority. (2021). *EBA Discussion Paper on Machine Learning for IRB Models* (EBA/DP/2021/04). Retrieved from https://www.eba.europa.eu/eba-consults-machine-learning-irb-models

\[8\] Financial Action Task Force (FATF). (2021). *Opportunities and Challenges of New Technologies for AML/CFT*. FATF, Paris. Retrieved from https://www.fatf-gafi.org/publications/fatfrecommendations/documents/opportunities-challenges-new-technologies-for-aml-cft.html

\[9\] Financial Stability Board (FSB). (2017). *Artificial Intelligence and Machine Learning in Financial Services*. Retrieved from https://www.fsb.org/2017/11/artificial-intelligence-and-machine-learning-in-financial-services/

\[10\] Bank for International Settlements (BIS). (2022). *Suptech and regtech: issues and considerations* (FSI Insights on policy implementation No. 41). Retrieved from https://www.bis.org/fsi/publ/insights41.htm

\[11\] BCG. (2023). *Global Risk 2023: Building a New Risk Architecture for a New Era*, p. 18. Boston Consulting Group. Retrieved from https://web-assets.bcg.com/a3/b0/ec0e03674b90b45b28be9b2c5ffc/bcg-global-risk-2023.pdf

\[12\] Thomson Reuters Institute. (2023). *Future of Professionals Report: How AI Is Reshaping the Legal Profession*. Retrieved from https://thomsonreuters.com/en-us/posts/legal/future-of-professionals-report/

\[13\] Jumio. (2023). *2023 Global Identity Fraud Report*. Jumio Corporation. Retrieved from https://www.jumio.com/global-identity-fraud-report/

\[14\] IBM Institute for Business Value. (2023). *Augmented work for an automated, AI-driven world: Banking & Financial Markets*. IBM Corporation. Retrieved from https://www.ibm.com/thought-leadership/institute-business-value/en-us/report/augmented-work

\[15\] Accenture. (2023). *Banking Technology Vision 2023: The New Era of Human-AI Collaboration in Compliance*. Accenture Financial Services. Retrieved from https://www.accenture.com/us-en/insights/banking/technology-vision-banking
