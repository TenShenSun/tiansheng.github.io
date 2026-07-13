# Agent Eval 平台工程：数据收集、打标、评测与 Benchmark 体系

:::观点 评测是 Agent 的第二套神经系统
写 Agent 逻辑是第一步；知道它在每个版本上跑得有多好、哪里变好了、哪里退步了，才是让系统持续演进的真正基础。评测平台不是锦上添花的工具，它是 Agent 工程的第二套神经系统。
:::

本文覆盖一套完整 Agent Eval 平台的五个核心模块：**数据收集 → 数据打标 → 数据评测 → Benchmark → 本地评测**，并在最后深入对比自建平台与 LangGraph/LangSmith 生态的取舍。每节附可直接落地的架构设计与代码骨架。

---

## 一、为什么 Agent 需要专属评测平台

传统软件测试：输入确定 → 输出确定 → 用断言验证。

Agent 评测：输入确定 → **多步骤轨迹不确定** → 工具调用序列不确定 → 最终答案不确定 → **无法用断言验证**。

这个根本差异催生了四个评测工程难题：

| 难题 | 传统软件测试 | Agent 评测 |
|---|---|---|
| **输出验证** | 字符串/值断言 | 语义等价判断（需要 LLM-as-Judge） |
| **测试覆盖** | 代码行覆盖率 | 场景覆盖率（意图 × 工具 × 错误类型） |
| **回归检测** | diff 即回归 | 轨迹变化 ≠ 退步（不同路径可达同一目标） |
| **失败归因** | 栈追踪 | 哪一步工具调用导致了最终失败？ |

更重要的是：Agent 能力随 Prompt 版本、底层模型版本、工具接口变化而漂移——**没有持续评测，你甚至不知道系统今天是否比上周好**。

:::提醒 评测债和技术债一样会利滚利
很多团队在 Prompt 迭代了十几个版本后才第一次做系统性评测，结果发现：某个"优化"在 A 场景提升了 15%，在 B 场景退步了 25%。评测债越晚还越贵。
:::

---

## 二、数据收集：从生产流量到评测语料

### 2.1 Trace 数据模型

评测的原材料是**执行轨迹（Trace）**，不是单次的输入输出对。一条完整的 Agent Trace 结构如下：

```python
@dataclass
class AgentTrace:
    trace_id: str
    session_id: str              # 多轮对话关联
    user_id: str                 # 脱敏后的用户标识
    started_at: datetime
    ended_at: datetime

    # 输入
    input: AgentInput            # 用户消息 + 系统上下文

    # 轨迹：每个步骤的完整快照
    steps: list[TraceStep]

    # 最终输出
    output: AgentOutput
    final_status: Literal["success", "error", "timeout", "user_aborted"]

    # 元数据（用于分层采样）
    metadata: TraceMetadata      # model_version, prompt_version, tool_versions...

@dataclass
class TraceStep:
    step_id: str
    step_type: Literal["llm_call", "tool_call", "user_interrupt", "checkpoint"]
    started_at: datetime
    duration_ms: int

    # LLM 调用时
    llm_input: dict | None       # 完整的 messages 列表
    llm_output: dict | None      # 模型原始输出（含 reasoning tokens）
    token_usage: TokenUsage | None

    # 工具调用时
    tool_name: str | None
    tool_input: dict | None
    tool_output: dict | None     # 工具返回值（可能很大，考虑截断策略）
    tool_error: str | None
```

### 2.2 采样策略：不是所有流量都要存

全量存储既昂贵又没必要。生产中用**分层采样**：

```python
class TraceSampler:
    """
    分层采样：保证评测集覆盖边界情况，不只是成功的普通案例
    """
    def should_sample(self, trace: AgentTrace) -> bool:
        # 层 1：所有失败 trace 全量保留（最有学习价值）
        if trace.final_status in ("error", "timeout"):
            return True

        # 层 2：长轨迹抽样（步骤数 > 10，复杂任务）
        if len(trace.steps) > 10:
            return random.random() < 0.3  # 30% 采样率

        # 层 3：用户反馈信号（点踩、投诉、重试）
        if trace.metadata.has_negative_signal:
            return True

        # 层 4：新场景触发（意图分类命中新 cluster）
        if self._is_new_intent_cluster(trace):
            return True

        # 层 5：普通成功 trace 低频采样（保持基线分布）
        return random.random() < 0.05  # 5% 采样率
```

:::方法 用户反馈信号是最高质量的采样触发器
点踩、重试、截断输出后自己重新输入——这些隐式反馈比 5% 随机采样更能命中真实失败案例。把所有负向信号 trace 全量收录是成本最低的数据质量提升手段。
:::

### 2.3 数据脱敏：在收集层而非存储层处理

```python
class TraceSanitizer:
    SENSITIVE_PATTERNS = [
        (r'\b\d{16,19}\b', '[CARD_NUMBER]'),          # 信用卡号
        (r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b', '[EMAIL]'),
        (r'\b\d{3}[-.]?\d{3}[-.]?\d{4}\b', '[PHONE]'),
    ]

    def sanitize(self, trace: AgentTrace) -> AgentTrace:
        # 深拷贝后在收集层就脱敏，不要依赖存储层过滤
        sanitized = deepcopy(trace)
        for step in sanitized.steps:
            if step.tool_input:
                step.tool_input = self._mask_sensitive(step.tool_input)
        return sanitized

    def _mask_sensitive(self, data: dict) -> dict:
        text = json.dumps(data, ensure_ascii=False)
        for pattern, replacement in self.SENSITIVE_PATTERNS:
            text = re.sub(pattern, replacement, text)
        return json.loads(text)
```

### 2.4 存储架构

```
生产 Agent 服务
    ↓（OpenTelemetry Span + 自定义 Trace Event）
Trace Collector（Kafka Topic: agent-traces-raw）
    ├─→ 采样器（Flink Streaming Job）
    │       ↓ 通过采样
    │   脱敏器
    │       ↓
    │   Trace Store（PostgreSQL + S3）  ← 评测数据库
    │       ↓ 按 version/date/intent 分区
    └─→ 实时监控（直接写 Prometheus/Grafana，不经过采样）
```

---

## 三、数据打标：人工 + LLM-as-Judge 混合流水线

### 3.1 标注维度设计

Agent Eval 的标注维度比 Chatbot 更复杂，需要覆盖**轨迹层**和**结果层**：

```python
@dataclass
class AgentTraceAnnotation:
    trace_id: str
    annotator: str               # human:{user_id} | model:{model_id}:{prompt_version}
    annotated_at: datetime

    # === 结果层 ===
    task_completion: Literal["complete", "partial", "failed", "undefined"]
    answer_quality: int          # 1-5，最终答案的质量
    answer_faithfulness: int     # 1-5，答案是否基于工具返回的事实

    # === 轨迹层 ===
    trajectory_efficiency: int   # 1-5，步骤数是否合理（有无多余工具调用）
    tool_selection: int          # 1-5，工具选择是否正确
    error_recovery: int | None   # 1-5，出现错误时的恢复策略（无错误时为 None）

    # === 安全层 ===
    has_hallucination: bool
    has_harmful_content: bool
    has_prompt_injection: bool   # 工具返回值里是否有注入尝试

    # 自由文本
    failure_reason: str | None   # 失败时的根因说明
    improvement_suggestion: str | None
```

### 3.2 LLM-as-Judge 实现

自动标注的核心是 Judge Prompt 的设计。Agent 评测的 Judge 和 Chatbot 评测的最大区别：**Judge 必须同时看轨迹和结果，不能只看最终答案**。

```python
AGENT_JUDGE_PROMPT = """
你是一个专业的 Agent 评测专家。你需要评估一次 Agent 执行的完整过程。

## 任务
用户意图：{user_intent}
任务完成标准：{success_criteria}

## Agent 执行轨迹
{trajectory_formatted}

## 最终输出
{final_output}

## 评估维度

### 1. 任务完成度（task_completion）
- complete：完全完成了用户意图
- partial：部分完成（核心意图完成，边缘情况遗漏）
- failed：未能完成用户意图
- undefined：无法判断（任务本身定义模糊）

### 2. 轨迹效率（trajectory_efficiency，1-5 分）
- 5：工具调用序列最优，无多余步骤
- 3：有 1-2 个多余工具调用，但不影响最终结果
- 1：大量冗余调用，或明显应该先搜索再总结却反了顺序

### 3. 工具选择（tool_selection，1-5 分）
评估每一步工具选择是否合理，是否存在：
- 选错工具（有更合适的工具未使用）
- 参数传错（工具调用参数与上下文不符）
- 未处理工具错误（工具报错后仍继续而非重试）

### 4. 幻觉检测（has_hallucination）
最终答案中是否存在工具返回值里没有依据的事实陈述？

请以 JSON 格式输出评估结果，不要输出其他内容：
{{
  "task_completion": "...",
  "trajectory_efficiency": <1-5>,
  "tool_selection": <1-5>,
  "has_hallucination": <true/false>,
  "reasoning": "评分依据，重点说明扣分原因"
}}
"""

class LLMJudge:
    def __init__(self, model: str = "claude-opus-4-8"):
        self.client = anthropic.Anthropic()
        self.model = model

    async def judge(self, trace: AgentTrace, criteria: SuccessCriteria) -> AgentTraceAnnotation:
        trajectory_formatted = self._format_trajectory(trace.steps)

        response = await self.client.messages.create(
            model=self.model,
            max_tokens=1024,
            system="你是一个严格、公正的 Agent 评测专家。",
            messages=[{
                "role": "user",
                "content": AGENT_JUDGE_PROMPT.format(
                    user_intent=trace.input.user_message,
                    success_criteria=criteria.description,
                    trajectory_formatted=trajectory_formatted,
                    final_output=trace.output.content,
                )
            }]
        )

        result = json.loads(response.content[0].text)
        return AgentTraceAnnotation(
            trace_id=trace.trace_id,
            annotator=f"model:{self.model}",
            task_completion=result["task_completion"],
            # ...
        )

    def _format_trajectory(self, steps: list[TraceStep]) -> str:
        lines = []
        for i, step in enumerate(steps):
            if step.step_type == "tool_call":
                lines.append(f"Step {i+1} [工具调用]: {step.tool_name}")
                lines.append(f"  输入: {json.dumps(step.tool_input, ensure_ascii=False)[:200]}")
                if step.tool_error:
                    lines.append(f"  错误: {step.tool_error}")
                else:
                    lines.append(f"  返回: {str(step.tool_output)[:200]}")
            elif step.step_type == "llm_call":
                lines.append(f"Step {i+1} [LLM 决策]: {step.llm_output.get('content', '')[:300]}")
        return "\n".join(lines)
```

### 3.3 标注一致性检验

LLM Judge 和人工标注的一致性是平台可信度的基础：

```python
class AnnotationConsistencyChecker:
    def compute_agreement(
        self,
        human_annotations: list[AgentTraceAnnotation],
        llm_annotations: list[AgentTraceAnnotation],
    ) -> ConsistencyReport:
        # task_completion（分类任务）：Cohen's Kappa
        kappa = cohen_kappa_score(
            [a.task_completion for a in human_annotations],
            [a.task_completion for a in llm_annotations],
        )

        # trajectory_efficiency（回归任务）：Spearman 相关
        rho, _ = spearmanr(
            [a.trajectory_efficiency for a in human_annotations],
            [a.trajectory_efficiency for a in llm_annotations],
        )

        # 二元标签（幻觉）：F1
        f1 = f1_score(
            [a.has_hallucination for a in human_annotations],
            [a.has_hallucination for a in llm_annotations],
        )

        return ConsistencyReport(kappa=kappa, trajectory_spearman=rho, hallucination_f1=f1)
```

**经验基准**：Kappa > 0.6 说明 LLM Judge 可以替代人工承担大部分标注；Kappa < 0.4 说明 Judge Prompt 需要重写或任务定义需要细化。

### 3.4 黄金集（Golden Set）管理

黄金集是手工精标的高质量案例，用于：① 回归测试；② 校准 LLM Judge；③ 新模型 / Prompt 的上线门控。

```python
class GoldenSetManager:
    def promote_to_golden(
        self,
        trace_id: str,
        expected_annotation: AgentTraceAnnotation,
        promotion_reason: str,
    ) -> GoldenCase:
        """
        晋升条件：
        - 人工标注，且标注者 calibration score > 0.8
        - 至少 2 名标注者达成一致（Cohen's Kappa > 0.7）
        - 覆盖至少一个尚未被充分覆盖的场景 cluster
        """
        trace = self.trace_store.get(trace_id)
        return GoldenCase(
            case_id=f"golden-{uuid4().hex[:8]}",
            trace=trace,
            expected=expected_annotation,
            scenario_tags=self._classify_scenario(trace),
            promoted_at=datetime.now(),
            reason=promotion_reason,
        )

    def detect_golden_decay(self) -> list[DecayedCase]:
        """
        黄金集腐化检测：当前系统在旧黄金集上的表现下降
        说明系统行为已经漂移，需要重新标注
        """
        decayed = []
        for case in self.get_all_golden():
            current_result = self.runner.run(case.trace.input)
            current_score = self.judge.judge(current_result, case.expected)
            if current_score.task_completion != case.expected.task_completion:
                decayed.append(DecayedCase(case=case, current_score=current_score))
        return decayed
```

---

## 四、数据评测：离线评测管道

### 4.1 评测管道架构

```
黄金集 / 采样集
    ↓
Task Runner（并行执行 Agent，记录 Trace）
    ↓
Annotation Engine（LLM Judge + 规则检查）
    ↓
Metrics Aggregator
    ↓
Report Generator → 评测 Dashboard + CI 门控
```

```python
class EvalPipeline:
    def __init__(self, agent: AgentRunner, judge: LLMJudge):
        self.agent = agent
        self.judge = judge

    async def run(
        self,
        dataset: EvalDataset,
        concurrency: int = 20,
    ) -> EvalReport:
        semaphore = asyncio.Semaphore(concurrency)

        async def run_one(case: EvalCase) -> CaseResult:
            async with semaphore:
                trace = await self.agent.run(case.input)
                annotation = await self.judge.judge(trace, case.criteria)
                return CaseResult(case=case, trace=trace, annotation=annotation)

        results = await asyncio.gather(*[run_one(c) for c in dataset.cases])
        return self._aggregate(results)

    def _aggregate(self, results: list[CaseResult]) -> EvalReport:
        return EvalReport(
            total=len(results),
            task_completion_rate=mean(
                r.annotation.task_completion == "complete" for r in results
            ),
            avg_trajectory_efficiency=mean(
                r.annotation.trajectory_efficiency for r in results
            ),
            hallucination_rate=mean(r.annotation.has_hallucination for r in results),
            avg_steps=mean(len(r.trace.steps) for r in results),
            avg_latency_ms=mean(r.trace.duration_ms for r in results),
            avg_total_tokens=mean(
                sum(s.token_usage.total for s in r.trace.steps if s.token_usage)
                for r in results
            ),
            # 按场景分类的细粒度指标
            by_scenario=self._group_by_scenario(results),
        )
```

### 4.2 指标体系

| 维度 | 指标 | 公式 | 目标 |
|---|---|---|---|
| **任务完成** | Task Completion Rate | `complete / total` | > 85% |
| **效率** | Avg Steps | 平均工具调用步数 | 与基准对比 |
| **质量** | Hallucination Rate | `has_hallucination / total` | < 5% |
| **延迟** | P95 Latency | 轨迹总耗时 P95 | < SLA 目标 |
| **成本** | Avg Token Cost | 平均每次 trace token 消耗 | 成本控制 |
| **鲁棒性** | Error Recovery Rate | 遇到工具错误后成功恢复的比率 | > 70% |

:::方法 在时间序列上看指标，比单次绝对值更有价值
Task Completion Rate 从 87% 到 84% 本身可能在误差范围内。但连续三个版本下降，说明有系统性漂移。把所有指标存 time-series，告警基于趋势而非阈值。
:::

### 4.3 多维度切分分析

```python
class EvalAnalyzer:
    def slice_by(self, report: EvalReport, dimension: str) -> dict[str, MetricSlice]:
        """
        按维度切分评测结果，快速定位问题来源

        常用切分维度：
        - scenario_type：场景类型（信息查询 / 代码生成 / 多步骤工作流）
        - tool_involved：涉及的工具集合
        - input_length：输入长度分桶（短/中/长）
        - failure_step：失败发生在第几步
        """
        slices = defaultdict(list)
        for result in report.results:
            key = getattr(result.case.metadata, dimension)
            slices[key].append(result)

        return {
            key: MetricSlice(
                completion_rate=mean(r.annotation.task_completion == "complete" for r in cases),
                count=len(cases),
            )
            for key, cases in slices.items()
        }
```

---

## 五、Benchmark：业界基准与自建基准

### 5.1 业界主流 Agent Benchmark

| Benchmark | 核心场景 | 评测粒度 | 适用阶段 |
|---|---|---|---|
| **SWE-bench** | GitHub Issue → 代码修复 | 任务完成（单元测试通过率） | 代码 Agent 能力基线 |
| **SWE-bench Verified** | 同上，经人工验证的子集 | 同上，噪声更低 | 精确对比 |
| **GAIA** | 多步骤通用任务（搜索+推理+工具） | 最终答案准确率 | 通用 Agent 能力 |
| **τ-bench** | 零售/航空客服工具调用 | 任务完成 + 对话自然性 | 垂直领域工具调用 |
| **AgentBench** | 8 类任务（OS/DB/知识图谱/游戏...） | 场景完成率 | 跨域综合能力 |
| **WebArena** | 真实网页任务自动化 | 任务完成（有功能性验证） | Browser Agent |
| **OSWorld** | 桌面 GUI 操作自动化 | 截图验证 + 程序验证 | GUI Agent |

:::提醒 开源 Benchmark 的污染问题
SWE-bench、GAIA 的测试集已被大量模型训练数据覆盖。发现某个模型 SWE-bench 得分极高但在你的实际任务上表现平平，大概率是 benchmark 污染。**自建垂域 benchmark 才是你系统的真实照妖镜**。
:::

### 5.2 自建垂域 Benchmark

自建 Benchmark 的三个关键设计决策：

**决策 1：任务完成标准的自动化验证**

```python
class AutoVerifier:
    """
    不同任务类型的自动化验证策略
    """
    async def verify(self, task: BenchmarkTask, output: AgentOutput) -> VerifyResult:
        match task.verification_type:
            case "exact_match":
                # 适合：查询类任务（返回值有确定答案）
                return VerifyResult(passed=output.content.strip() == task.expected)

            case "code_execution":
                # 适合：代码生成任务（执行测试用例）
                return await self._run_tests(output.code, task.test_cases)

            case "structured_output":
                # 适合：信息提取任务（验证 JSON schema + 字段值）
                parsed = json.loads(output.content)
                return VerifyResult(
                    passed=self._validate_schema(parsed, task.schema)
                    and self._validate_values(parsed, task.expected_fields)
                )

            case "llm_judge":
                # 适合：开放式任务（无确定答案）
                return await self.judge.verify(task, output)
```

**决策 2：任务难度分级**

```python
DIFFICULTY_CRITERIA = {
    "L1": {
        "description": "单步工具调用，明确意图，标准答案",
        "max_steps": 3,
        "example": "查询某公司今日股价",
    },
    "L2": {
        "description": "多步工具调用，意图明确，需要组合信息",
        "max_steps": 8,
        "example": "比较 A、B 两家公司过去一季度的营收增速",
    },
    "L3": {
        "description": "意图模糊，需要澄清或假设，存在多条可行路径",
        "max_steps": 15,
        "example": "帮我分析一下这个市场的竞争格局",
    },
    "L4": {
        "description": "长流程任务，跨会话，需要检索+推理+综合，有错误恢复",
        "max_steps": 30,
        "example": "研究并起草一份竞品分析报告",
    },
}
```

**决策 3：防止 Benchmark 过拟合**

```python
class BenchmarkRotator:
    """
    定期轮换部分测试案例，防止系统 overfit 到已知 benchmark
    """
    def rotate_cases(self, benchmark: Benchmark, rotation_ratio: float = 0.2):
        n_rotate = int(len(benchmark.cases) * rotation_ratio)

        # 移除表现最稳定的案例（可能已被训练集覆盖）
        stable_cases = sorted(
            benchmark.cases,
            key=lambda c: c.pass_rate_variance,  # 方差最小的最可能被过拟合
        )[:n_rotate]

        # 用新采集的生产案例补充
        new_cases = self.case_generator.generate(
            scenarios=benchmark.uncovered_scenarios(),
            count=n_rotate,
        )

        benchmark.cases = [c for c in benchmark.cases if c not in stable_cases] + new_cases
```

### 5.3 Benchmark 运行的工程实践

```python
class BenchmarkRunner:
    async def run_full_benchmark(
        self,
        agent_config: AgentConfig,
        benchmark: Benchmark,
        parallel: int = 50,
    ) -> BenchmarkResult:
        # 1. 并行运行所有任务
        semaphore = asyncio.Semaphore(parallel)
        tasks = [self._run_task(t, agent_config, semaphore) for t in benchmark.tasks]
        task_results = await asyncio.gather(*tasks)

        # 2. 计算汇总指标
        by_difficulty = self._group_by_difficulty(task_results)
        by_tool = self._group_by_tool_used(task_results)

        # 3. 与 baseline 对比（上一个稳定版本）
        baseline = self.result_store.get_latest_baseline()
        comparison = self._compare_with_baseline(task_results, baseline)

        return BenchmarkResult(
            config=agent_config,
            overall_pass_rate=mean(r.passed for r in task_results),
            by_difficulty=by_difficulty,
            by_tool=by_tool,
            regression_cases=comparison.regressions,  # 相比 baseline 退步的案例
            improvement_cases=comparison.improvements,
        )
```

---

## 六、本地评测：开发者工作流

### 6.1 本地 Eval CLI 设计

开发者在 push 之前需要在本地快速验证变更：核心是**秒级反馈**，不是完整跑 benchmark。

```bash
# 跑所有冒烟测试（< 30s，覆盖最高频场景）
agent-eval smoke --config ./eval/smoke.yaml

# 跑某个场景集合（中等规模，< 3min）
agent-eval run --suite search_tasks --parallel 10

# 对比当前 Prompt 和上一个版本的差异
agent-eval diff --baseline v1.2.3 --current HEAD --suite golden

# 只跑你的变更可能影响到的案例（变更感知）
agent-eval run --affected-by "tools/search.py" --suite full
```

```python
# eval/smoke.yaml
smoke_tests:
  timeout: 30s
  parallel: 5
  cases:
    - id: basic_search
      input: "查一下明天北京的天气"
      verifier: exact_intent_match
      expected_tools: [weather_api]

    - id: multi_step
      input: "比较苹果和谷歌最新季度的营收"
      verifier: llm_judge
      max_steps: 6
      must_use_tools: [search, calculator]

    - id: error_recovery
      input: "查询 AAPL 的股价"
      tool_mock:
        stock_api: {error: "rate_limit"}  # 模拟工具失败
      verifier: task_complete            # 期望 Agent 能恢复
```

### 6.2 快速迭代循环

```
修改 Prompt / 工具代码
        ↓
agent-eval smoke（< 30s）
        ↓ 通过
agent-eval diff --suite golden（< 3min）
        ↓ 无回归
git push → CI 触发完整 Benchmark（< 30min）
        ↓ 通过
合并 → 自动更新 baseline
```

### 6.3 交互式调试

```python
class LocalDebugger:
    """
    本地交互式调试：逐步执行 Agent，检查每步的决策
    """
    async def debug_interactive(self, input_text: str):
        trace = AgentTrace.new()
        state = AgentState(input=input_text)

        while not state.is_terminal:
            # 展示当前状态
            print(f"\n=== Step {len(trace.steps) + 1} ===")
            print(f"上下文长度: {state.context_tokens} tokens")
            print(f"待执行动作: {state.next_action}")

            # 用户可以修改状态（调试用）
            action = input("确认执行？[Enter 继续 / m 修改 / s 跳过 / q 终止] ")

            if action == 'q':
                break
            elif action == 'm':
                state.next_action = input("输入新动作: ")
            elif action == 's':
                state.advance_to_next()
                continue

            # 执行并记录
            result = await self.executor.execute(state.next_action)
            trace.add_step(state, result)
            state = state.transition(result)

        # 执行结束后打印 Judge 评分
        annotation = await self.judge.judge(trace, criteria=None)
        print(f"\n评测结果: {annotation}")
```

### 6.4 测试双写：线上线下对齐

```python
class ShadowEvalMiddleware:
    """
    在生产 Agent 旁边跑影子评测：同一个输入同时跑旧版和新版，
    记录差异但只返回旧版结果给用户——用于上线前的置信度积累
    """
    async def __call__(self, request: AgentRequest) -> AgentResponse:
        # 并行跑生产版本和候选版本
        prod_task = asyncio.create_task(self.prod_agent.run(request))
        shadow_task = asyncio.create_task(self.shadow_agent.run(request))

        prod_result, shadow_result = await asyncio.gather(prod_task, shadow_task)

        # 异步记录差异（不阻塞请求返回）
        asyncio.create_task(self._record_diff(request, prod_result, shadow_result))

        return prod_result  # 只返回生产版本
```

---

## 七、与 LangGraph / LangSmith 的对比

LangGraph 和 LangSmith 是目前 Agent 领域最成熟的框架 + 评测生态组合。搞清楚它们能给什么、不能给什么，是选型的前提。

### 7.1 LangSmith 的核心评测能力

LangSmith 是 LangChain 生态的可观测性 + 评测 SaaS 平台，主要能力：

```python
# LangSmith 的典型使用方式
from langsmith import Client, evaluate

client = Client()

# 1. 创建数据集（上传到 LangSmith）
dataset = client.create_dataset("agent-eval-v1")
for case in eval_cases:
    client.create_example(
        inputs={"question": case.input},
        outputs={"answer": case.expected_output},
        dataset_id=dataset.id,
    )

# 2. 定义评估器
def trajectory_evaluator(run, example):
    # run.child_runs 是整个执行轨迹
    tool_calls = [r for r in run.child_runs if r.run_type == "tool"]
    return {
        "score": min(1.0, 5 / len(tool_calls)),  # 步骤越少分越高
        "comment": f"共执行 {len(tool_calls)} 步工具调用",
    }

# 3. 运行评测
results = evaluate(
    lambda x: my_agent.invoke(x),
    data=dataset,
    evaluators=[trajectory_evaluator],
    experiment_prefix="v2.1-prompt-update",
)
```

LangSmith 内置了：
- **Trace 存储与可视化**：每次 LangChain/LangGraph 调用自动上传
- **Dataset 管理**：Web UI 上传、编辑、版本化数据集
- **Evaluator 框架**：内置 QA、Criteria、Embedding Distance 等评估器
- **实验对比**：同一数据集上不同版本的 side-by-side 对比

### 7.2 自建平台 vs LangSmith：能力边界对比

| 维度 | LangSmith | 自建平台 |
|---|---|---|
| **接入成本** | 极低（2 行代码）| 高（需自建全套）|
| **数据主权** | SaaS，数据在 LangChain 服务器 | 完全自控 |
| **框架绑定** | 深度绑定 LangChain/LangGraph | 框架无关 |
| **自定义评估器** | 支持，但有 API 限制 | 完全自由 |
| **生产流量采样** | 有限（需手动接入）| 可深度定制采样策略 |
| **多租户隔离** | SaaS 层面隔离 | 完全可控 |
| **成本** | 按 Trace 数量付费 | 按自建基础设施付费 |
| **合规/数据隐私** | 依赖 LangChain 合规认证 | 自建，可满足 GDPR/金融合规 |
| **离线 Benchmark** | 支持，但 API 有并发限制 | 无限制 |
| **与内部系统集成** | 有限（标准 API）| 深度集成（直接读内部数据库）|

### 7.3 LangGraph 的评测特有问题

LangGraph 把 Agent 建模为**状态图（StateGraph）**，这带来了评测上的独特挑战：

```python
# LangGraph Agent 的状态图结构
from langgraph.graph import StateGraph

builder = StateGraph(AgentState)
builder.add_node("planner", planner_node)
builder.add_node("executor", executor_node)
builder.add_node("verifier", verifier_node)
builder.add_edge("planner", "executor")
builder.add_conditional_edges("executor", route_after_execution)
builder.add_edge("verifier", "planner")  # 循环

graph = builder.compile(checkpointer=MemorySaver())
```

评测 LangGraph Agent 的三个特有挑战：

**挑战 1：条件边导致执行路径爆炸**

```python
class LangGraphPathCoverage:
    """
    LangGraph 的 conditional_edges 可能产生指数级路径组合。
    需要专门的路径覆盖分析，而不是简单的步骤计数。
    """
    def analyze_path_coverage(self, traces: list[AgentTrace]) -> PathReport:
        executed_paths = set()
        for trace in traces:
            # 从 LangGraph checkpoint 提取实际执行路径
            path = tuple(step.node_name for step in trace.steps if step.is_node_entry)
            executed_paths.add(path)

        all_paths = self.graph_analyzer.enumerate_paths(max_length=10)
        return PathReport(
            coverage=len(executed_paths) / len(all_paths),
            uncovered_paths=all_paths - executed_paths,
        )
```

**挑战 2：Checkpointer 状态的评测**

LangGraph 的 `Checkpointer` 负责状态持久化——评测时需要验证 checkpoint 机制的正确性，而不只是最终输出：

```python
async def test_langgraph_checkpoint_recovery(agent_graph, input_data):
    """验证 LangGraph Agent 的断点续跑正确性"""
    thread_id = {"configurable": {"thread_id": "test-recovery-001"}}

    # 第一次运行，在 executor 节点后中断
    result_before = None
    async for event in agent_graph.astream(input_data, thread_id):
        if event.get("executor"):
            result_before = event["executor"]
            break  # 模拟中断

    # 从 checkpoint 恢复（不重新传入 input）
    result_after = await agent_graph.ainvoke(None, thread_id)

    # 验证：恢复后的结果应该与不中断的完整运行一致
    full_result = await agent_graph.ainvoke(input_data, {"configurable": {"thread_id": "test-full-001"}})
    assert result_after["output"] == full_result["output"], "Checkpoint 恢复后结果不一致"
```

**挑战 3：Human-in-the-Loop 场景的评测**

```python
async def test_hitl_interrupt(agent_graph, risky_input):
    """验证高风险操作的 HITL 中断是否按预期触发"""
    interrupted = False
    async for event in agent_graph.astream(risky_input):
        if "__interrupt__" in event:
            interrupted = True
            interrupt_value = event["__interrupt__"][0].value
            # 验证中断信息包含足够的上下文供人类决策
            assert "action_description" in interrupt_value
            assert "risk_level" in interrupt_value
            break

    assert interrupted, "高风险操作应该触发 HITL 中断，但没有"
```

### 7.4 选型建议：什么时候用哪个

```
你的场景是...
        │
        ├─ 原型阶段，快速验证，团队 < 5 人
        │   → LangSmith 直接用，不要自建
        │
        ├─ 使用 LangChain/LangGraph 框架
        │   且数据合规要求一般（非金融/医疗）
        │   → LangSmith 能覆盖 80% 需求，自建补充 20%
        │
        ├─ 框架无关，或自研 Agent 框架
        │   → 自建 Trace 收集 + 评测管道
        │   LangSmith 的评测器库可以借鉴但不依赖
        │
        └─ 金融/医疗/企业，数据不能出境/出域
            → 必须自建，LangSmith 不可用
```

:::启发 LangSmith 的最大价值：开发阶段的调试体验
LangSmith 最好的地方不是评测能力，而是**开发阶段的 Trace 可视化**——每次调试都能在 Web UI 上展开完整轨迹，定位是哪一步 LLM 决策出了问题。如果你用 LangChain 生态，这个价值值得付费。如果你的框架是自研的，自建 Trace 可视化（Jaeger / 自研 UI）能达到类似效果。
:::

---

## 八、完整平台架构

```
┌────────────────────────────────────────────────────────────────────┐
│                     Agent Eval Platform                             │
│                                                                     │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐  │
│  │  数据收集层   │    │  标注层       │    │  评测层               │  │
│  │              │    │              │    │                      │  │
│  │ • Trace 采集 │    │ • LLM Judge  │    │ • 离线 Eval 管道     │  │
│  │ • 分层采样   │───▶│ • 人工标注   │───▶│ • Benchmark 运行     │  │
│  │ • 数据脱敏   │    │ • 一致性检验 │    │ • 回归检测           │  │
│  │ • Kafka 流   │    │ • 黄金集管理 │    │ • A/B 对比           │  │
│  └──────────────┘    └──────────────┘    └──────────────────────┘  │
│                                                    │                │
│  ┌──────────────────────────────────────────────── ▼ ────────────┐  │
│  │                    存储层                                       │  │
│  │  Trace Store（PostgreSQL + S3）  Golden Set  Benchmark Results │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐  │
│  │  本地评测    │    │  CI 门控      │    │  监控与告警           │  │
│  │              │    │              │    │                      │  │
│  │ • CLI 工具   │    │ • PR 自动触发│    │ • 指标 Dashboard     │  │
│  │ • 交互调试   │    │ • 黄金集回归 │    │ • 趋势告警           │  │
│  │ • Shadow Eval│    │ • 上线门控   │    │ • 场景覆盖度         │  │
│  └──────────────┘    └──────────────┘    └──────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

### 关键设计决策速查

| 决策点 | 推荐选型 | 核心理由 |
|---|---|---|
| **Trace 采集** | OpenTelemetry + Kafka | 框架无关，流式处理 |
| **自动标注** | Claude Opus（LLM-as-Judge）| 轨迹级评测需要最强推理能力 |
| **黄金集存储** | PostgreSQL + Git（YAML）| 数据可版本管理，可 Code Review |
| **Benchmark 运行** | 自建并行 Runner（asyncio）| 无并发限制，成本可控 |
| **本地 Eval** | 自建 CLI + YAML 配置 | 开发者体验优先，快速反馈 |
| **可视化** | Grafana（指标）+ 自研 UI（Trace）| 标准 + 业务定制分离 |
| **框架绑定** | LangSmith（LangChain 项目）/ 自建（自研框架）| 按框架选型，不要强绑 |

---

## 参考文献

### Agent 评测基础

1. Yao, Shunyu, et al. **"τ-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains."** arXiv:2406.12045, 2024. — 覆盖零售/航空垂直域的工具调用 benchmark，含真实用户模拟器，是垂域评测设计的重要参考。

2. Jimenez, Carlos E., et al. **"SWE-bench: Can Language Models Resolve Real-World GitHub Issues?"** *ICLR 2024*. arXiv:2310.06770. — 代码 Agent 评测的事实标准；自动验证（单元测试通过率）是 Agent 任务验证自动化的最佳实践案例。

3. Mialon, Grégoire, et al. **"GAIA: A Benchmark for General AI Assistants."** arXiv:2311.12983, 2023. — 通用 Agent 的多步骤任务 benchmark；三个难度级别的设计思路直接影响了本文的自建 benchmark 设计。

4. Liu, Xiao, et al. **"AgentBench: Evaluating LLMs as Agents."** *ICLR 2024*. arXiv:2308.03688. — 8 类任务的综合评测框架，覆盖 OS、数据库、Web、游戏等；多场景覆盖设计值得借鉴。

### LLM-as-Judge

5. Zheng, Lianmin, et al. **"Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena."** *NeurIPS 2023*. arXiv:2306.05685. — LLM-as-Judge 的奠基论文；position bias、verbosity bias、self-enhancement bias 三大系统偏差是设计 Judge Prompt 的必读背景。

6. Shankar, Shreya, et al. **"Who Validates the Validators? Aligning LLM-Assisted Evaluation of LLM Outputs with Human Preferences."** arXiv:2404.12272, 2024. — 检验 LLM Judge 与人类标注者一致性的方法论；Kappa > 0.6 的经验基准来自此类工作。

7. Kim, Seungone, et al. **"Prometheus 2: An Open Source Language Model Specialized in Evaluating Other Language Models."** arXiv:2405.01535, 2024. — 专门为评测训练的开源评估模型；在资源受限或不想依赖闭源模型的场景下值得考量。

### 标注平台与数据工程

8. Northcutt, Curtis, et al. **"Confident Learning: Estimating Uncertainty in Dataset Labels."** *Journal of AI Research*, 2021. arXiv:1911.00068. — 标注噪声检测的理论基础；黄金集腐化检测的置信学习方法。

9. Bommasani, Rishi, et al. **"Holistic Evaluation of Language Models (HELM)."** arXiv:2211.09110, 2022. — 多维度评测框架设计（准确率、鲁棒性、公平性、效率）；指标体系设计的重要参考。

### LangGraph 与评测工具

10. LangChain. **"LangGraph Documentation."** langchain-ai.github.io/langgraph, 2025. — LangGraph 官方文档；StateGraph、Checkpointer、Human-in-the-Loop 的设计规范，评测 LangGraph Agent 的必读背景。

11. LangChain. **"LangSmith Documentation: Evaluation."** docs.smith.langchain.com, 2025. — LangSmith 评测框架（Dataset、Evaluator、Experiment）的完整 API 文档。

12. Zaharia, Matei, et al. **"The Shift from Models to Compound AI Systems."** BAIR Blog, February 2024. — 复合 AI 系统的评测不同于单模型评测；整体任务完成率 vs 组件准确率的权衡是这篇文章的核心论点，直接影响本文的多维度指标设计。

### 可观测性与数据飞轮

13. OpenTelemetry. **"Semantic Conventions for Generative AI Systems."** opentelemetry.io, 2024. — Agent Trace 采集的标准 schema；LLM 调用、工具调用的 Span attribute 规范。

14. Ribeiro, Marco Tulio, et al. **"Beyond Accuracy: Behavioral Testing of NLP Models with CheckList."** *ACL 2020*. — 功能性评测（capability testing）vs 数据集评测的互补性；自建 smoke test 设计的重要参考。

15. Sculley, D., et al. **"Hidden Technical Debt in Machine Learning Systems."** *NeurIPS 2015*. — 评测基础设施不足是 ML 技术债的重要来源；「评测债」概念的理论依据。
