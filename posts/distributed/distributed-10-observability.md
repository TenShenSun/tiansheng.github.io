# 分布式系统可观测性：Tracing、Metrics 与 Logging 的工程实践

分布式系统最难 debug 的不是「代码有 bug」，而是「服务整体变慢了，但不知道慢在哪」。单体系统里，一次请求只经过一个进程，日志就够了。分布式系统里，一次请求可能穿越 10 个微服务、经过 5 个数据库查询、触发 3 条消息队列——没有可观测性基础设施，你根本无法定位问题。

---

## 可观测性的三大支柱

**Metrics（指标）**：数值型的聚合数据，描述系统在某个时间点的状态。

- QPS（每秒请求数）、P99 延迟、错误率、CPU 使用率
- 适合告警和趋势分析，但无法回答「这次具体请求失败的原因是什么」

**Logs（日志）**：时间序列的事件记录，每条记录描述一个具体事件。

- 适合问题排查（知道 RequestId 后查日志）
- 海量日志存储成本高，搜索慢
- 单独的日志无法追踪跨服务的请求链路

**Traces（链路追踪）**：记录一次请求在多个服务中的完整调用链路。

- 可以看到请求在哪个服务慢、哪个数据库查询耗时、哪里发生了错误
- 适合性能分析和复杂故障排查
- 采样率通常 < 100%（全量会引入额外开销）

:::观点
三大支柱不是相互替代，而是互补的。告警靠 Metrics，排查靠 Trace 定位到问题服务，确认细节靠 Logs。现代可观测性平台（如 Datadog、Grafana Stack）将三者关联：从一个异常 Metric → 跳转到相关 Trace → 查看对应 Logs。
:::

---

## 分布式 Tracing

### 核心概念

**Trace**：一次完整请求的调用链路，由多个 Span 组成。

**Span**：链路中的一个工作单元，表示一次操作（HTTP 请求、DB 查询、消息发送）。Span 包含：

```json
{
  "traceId": "abc123def456",      // 整个链路的唯一标识
  "spanId": "789xyz",             // 本 Span 的唯一标识
  "parentSpanId": "456abc",       // 父 Span（调用方）的 ID
  "operationName": "mysql.query", // 操作名称
  "startTime": 1706700000000,     // 开始时间（微秒）
  "duration": 15000,              // 持续时间（微秒）
  "tags": {
    "db.type": "mysql",
    "db.statement": "SELECT * FROM orders WHERE user_id = ?",
    "error": false
  },
  "logs": [
    {"timestamp": 1706700005000, "event": "query.start"}
  ]
}
```

**上下文传播（Context Propagation）**：TraceId 和 SpanId 在服务间传递，通常通过 HTTP Header：

```
# W3C Trace Context 标准 (推荐)
traceparent: 00-abc123def456789012345678-789xyz123-01
              ^  ^TraceId(32位hex)^  ^SpanId^  Flags

# B3（Zipkin 格式，兼容性好）
X-B3-TraceId: abc123def456789012345678
X-B3-SpanId:  789xyz123
X-B3-Sampled: 1
```

### 采样策略

全量 Trace 代价太高（每条 Trace 需要网络传输、存储），通常采样：

| 策略 | 说明 | 适用 |
|------|------|------|
| **概率采样** | 固定比例（如 1%）随机采样 | 高流量服务 |
| **速率限制采样** | 每秒最多采 N 条 | 避免突发流量导致存储暴增 |
| **尾部采样（Tail Sampling）** | 先收集完整链路，再按结果决定是否保留（如只保留错误链路和慢链路） | 最有价值，但实现复杂 |
| **头部采样（Head Sampling）** | 在请求入口决定是否采样 | 简单，但会漏掉"事后看很重要"的链路 |

尾部采样的挑战：需要先缓冲所有 Span，等链路完成后才能决策，增加存储压力和处理延迟。

---

## OpenTelemetry

OpenTelemetry（OTel）是 CNCF 的可观测性标准，统一了 Metrics、Traces、Logs 的采集 API 和协议，目标是「一次接入，数据发往任意后端」。

### 架构

```
应用程序（使用 OTel SDK）
       ↓ OTLP（OpenTelemetry Protocol）
OTel Collector（可选，中间层）
       ↓ 导出到后端
 Jaeger / Zipkin  Prometheus  ElasticSearch
（Trace 后端）    （Metrics后端）（Log 后端）
```

**OTel SDK**：应用代码集成，自动/手动创建 Span、记录 Metrics。

**OTel Collector**：独立进程，接收应用数据，做过滤/采样/格式转换，转发到不同后端。解耦应用和后端，无需改代码就能切换存储后端。

### 自动探针（Auto Instrumentation）

OTel 提供各语言的自动探针（Java Agent、Python 自动插桩），无需修改业务代码即可采集：

```bash
# Java：添加 -javaagent 即自动追踪 HTTP、JDBC、Redis 等调用
java -javaagent:opentelemetry-javaagent.jar \
     -Dotel.service.name=order-service \
     -Dotel.exporter.otlp.endpoint=http://otel-collector:4317 \
     -jar order-service.jar
```

### 手动埋点

自动探针覆盖不了的业务逻辑需要手动添加 Span：

```python
from opentelemetry import trace

tracer = trace.get_tracer("order-service")

def process_order(order_id):
    with tracer.start_as_current_span("process_order") as span:
        span.set_attribute("order.id", order_id)
        
        with tracer.start_as_current_span("validate_inventory"):
            result = check_inventory(order_id)
            span.set_attribute("inventory.available", result)
        
        with tracer.start_as_current_span("charge_payment"):
            charge_result = charge(order_id)
            if charge_result.error:
                span.set_status(StatusCode.ERROR, charge_result.error_msg)
                span.record_exception(charge_result.exception)
```

---

## Jaeger 与 Zipkin

### Jaeger（Uber 开源，CNCF 孵化）

Jaeger 是主流的开源 Trace 存储和可视化系统。

**架构（生产部署）**：

```
应用 → OTel Collector → Kafka（缓冲） → Jaeger Ingester → Cassandra/ElasticSearch
                                                                  ↓
                                                         Jaeger Query（Web UI）
```

**关键功能**：
- Trace 可视化（瀑布图，各 Span 时间轴）
- 服务依赖图（自动发现微服务调用关系）
- 性能对比（同一接口不同时期的 Trace 对比）
- 按 Tag 搜索（`http.status_code=500`、`error=true`、`user_id=123`）

### 对比

| 维度 | Jaeger | Zipkin |
|------|--------|--------|
| **开源组织** | CNCF（Uber 捐赠） | OpenZipkin |
| **协议支持** | OTLP、Jaeger 原生 | B3、Zipkin 原生 |
| **存储后端** | Cassandra、ES、内存 | Cassandra、ES、MySQL、内存 |
| **UI** | 功能更丰富 | 简洁 |
| **生态** | 更现代，OTel 优先 | 老牌，兼容性好 |

---

## Metrics：Prometheus + Grafana

### Prometheus 数据模型

Prometheus 是基于时间序列的 Metrics 存储系统，数据模型：

```
指标名{标签键=值, ...} 数值 时间戳

http_requests_total{method="GET", service="order", status="200"} 12345 1706700000
http_requests_total{method="POST", service="order", status="500"} 23 1706700000
http_request_duration_seconds{quantile="0.99", service="order"} 0.250
```

**四种指标类型**：

| 类型 | 含义 | 示例 |
|------|------|------|
| **Counter** | 单调递增计数器 | 请求总数、错误总数 |
| **Gauge** | 可增可减的当前值 | CPU 使用率、在线用户数 |
| **Histogram** | 对值分布的采样（分桶） | 请求延迟分布 |
| **Summary** | 滑动窗口内的分位数 | P50/P95/P99 延迟 |

**PromQL（Prometheus 查询语言）**：

```promql
# 过去 5 分钟的 QPS（每秒请求数）
rate(http_requests_total{service="order"}[5m])

# 99 分位延迟（毫秒）
histogram_quantile(0.99, 
  rate(http_request_duration_seconds_bucket{service="order"}[5m])
) * 1000

# 错误率
rate(http_requests_total{service="order",status=~"5.."}[5m])
/
rate(http_requests_total{service="order"}[5m])
```

### 告警：AlertManager

```yaml
# Prometheus 告警规则示例
groups:
  - name: order-service
    rules:
      - alert: HighErrorRate
        expr: |
          rate(http_requests_total{service="order",status=~"5.."}[5m])
          / rate(http_requests_total{service="order"}[5m]) > 0.01
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Order service error rate > 1%"
          description: "Current error rate: {{ $value | humanizePercentage }}"
```

告警流向：Prometheus → AlertManager（去重、分组、静默、路由）→ 通知渠道（PagerDuty、Slack、Email）

---

## SLO / SLA / Error Budget

### 定义

**SLI（Service Level Indicator）**：衡量服务质量的具体指标。
- 可用性 SLI = 成功请求数 / 总请求数
- 延迟 SLI = P99 延迟 < 500ms 的请求比例

**SLO（Service Level Objective）**：内部目标，如「月可用性 ≥ 99.9%」。

**SLA（Service Level Agreement）**：对外承诺的合同，通常比 SLO 宽松，违反有赔偿条款。

**Error Budget（错误预算）**：SLO 允许的「不满足」配额。

```
月可用性 SLO = 99.9%
月总分钟数 = 30 × 24 × 60 = 43,200 分钟
Error Budget = 43,200 × (1 - 0.999) = 43.2 分钟

即：每月允许最多 43.2 分钟的不可用时间
```

**Error Budget 的工程意义**：

```
剩余 Error Budget 充足 → 可以发布新功能（接受一定风险）
Error Budget 快耗尽    → 冻结发布，专注稳定性
Error Budget 耗尽      → 必须 Postmortem，改善流程后才能恢复发布
```

:::方法
**SLO 设置建议**：
- 不要设置 100% SLO——这会让团队害怕发布任何变更
- 从用户实际感知出发设置 SLI（用户能感知到延迟 > 1s，但不会感知到 50ms vs 45ms 的差异）
- SLO 比 SLA 严格 10-20%，留缓冲空间
- 将 Error Budget 消耗速率（Burn Rate）作为告警指标，而非直接告警 SLI 违反
:::

---

## 日志规范

### 结构化日志

非结构化日志（纯文本）难以机器解析，结构化日志（JSON）便于查询和聚合：

```json
{
  "timestamp": "2024-01-31T10:00:00.000Z",
  "level": "ERROR",
  "service": "order-service",
  "trace_id": "abc123def456",
  "span_id": "789xyz",
  "user_id": 12345,
  "order_id": 67890,
  "message": "Payment charge failed",
  "error": "insufficient_balance",
  "duration_ms": 150
}
```

**TraceId 关联**：日志里带 TraceId，就能从 Trace 系统跳转到日志系统查看同一请求的详细日志。

### 日志级别规范

| 级别 | 含义 | 生产建议 |
|------|------|---------|
| DEBUG | 开发调试信息 | 生产关闭，按需开启 |
| INFO | 关键业务事件（订单创建、用户登录） | 生产开启，合理控制量 |
| WARN | 不影响服务但需要关注的异常 | 生产开启，需要告警规则 |
| ERROR | 请求失败、需要人工处理的错误 | 生产开启，必须告警 |
| FATAL | 服务无法继续运行 | 必然触发告警 |

---

## 小结

| 工具链 | 职责 |
|--------|------|
| OTel SDK + Collector | 统一采集，与后端解耦 |
| Jaeger / Tempo | Trace 存储与可视化 |
| Prometheus | Metrics 采集与存储 |
| Grafana | Metrics + Trace + Log 统一可视化 |
| AlertManager | 告警路由与去重 |
| ElasticSearch / Loki | 日志存储与查询 |

可观测性不是「装几个监控工具」，而是在系统设计阶段就把**可被观测**作为非功能需求——合理的 TraceId 传播、结构化日志、关键业务 Metrics 埋点、合理的 SLO 定义，这些才是真正让分布式系统可被运维的基础。
