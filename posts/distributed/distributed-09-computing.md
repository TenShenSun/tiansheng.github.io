# 分布式计算：MapReduce、Spark 与 Flink 的批流演进

分布式计算解决的是「如何用一个计算机集群处理单机装不下的数据」。从 2004 年 Google MapReduce 论文奠定范式，到 Spark 用内存计算提速 100x，再到 Flink 实现流批一体和精确一次语义——这 20 年的演进不是替换而是叠加，每一代解决了前一代的核心痛点。

---

## MapReduce

MapReduce（Google，2004）是分布式计算的开山范式，将任意计算问题抽象为两个函数：

```python
# Map：将输入数据转换为 (key, value) 对
def map(document):
    for word in document.split():
        emit(word, 1)

# Reduce：对同一 key 的所有 value 聚合
def reduce(key, values):
    emit(key, sum(values))

# 词频统计：
# Map("hello world hello") → [("hello",1), ("world",1), ("hello",1)]
# Shuffle & Sort → hello: [1,1], world: [1]
# Reduce → hello: 2, world: 1
```

### MapReduce 执行流程

```
输入文件（HDFS）
    ↓ 切分为 Split（通常 128MB）
M 个 Map 任务（并行）
    ↓ 写中间结果到本地磁盘（按 Reduce task 分区）
Shuffle & Sort（网络传输，磁盘排序）
    ↓ 按 key 排序并传输给 Reducer
R 个 Reduce 任务（并行）
    ↓
输出文件（HDFS）
```

### MapReduce 的三大局限

**1. 磁盘 I/O 密集**：每个 Map-Reduce 步骤的中间结果都写磁盘，多阶段计算（如机器学习迭代）每次迭代都要读写磁盘，速度极慢。

**2. 只支持批处理**：MapReduce 是批处理模型，无法处理实时流数据。需要实时计算时只能用 Lambda 架构（批处理 + 实时流两套系统并行运行），维护成本高。

**3. 编程模型受限**：所有计算必须表达为 Map + Reduce，复杂的多阶段计算（JOIN、迭代算法）需要多个 MapReduce 任务串联，性能差。

---

## Apache Spark

Spark（UC Berkeley，2012）的核心创新：**用内存计算替代磁盘 I/O**，多阶段计算的中间结果留在内存中，速度比 MapReduce 快 10-100x。

### RDD：弹性分布式数据集

RDD（Resilient Distributed Dataset）是 Spark 的基础抽象——一个不可变的、分区的、跨集群分布的数据集合。

```python
sc = SparkContext()

# 从 HDFS 创建 RDD
logs = sc.textFile("hdfs://logs/2024-01")

# Transformation（惰性，不立即执行）
errors = logs.filter(lambda line: "ERROR" in line)
error_counts = errors.map(lambda line: (extract_service(line), 1)) \
                     .reduceByKey(lambda a, b: a + b)

# Action（触发实际计算）
result = error_counts.sortBy(lambda x: -x[1]).take(10)
```

**Transformation 是惰性的**：`filter`、`map`、`reduceByKey` 不立即执行，只构建 DAG（有向无环图）。

**Action 触发执行**：`collect()`、`count()`、`take()` 等 Action 才触发实际计算，Spark 优化整个 DAG 后一次性执行。

### DAG 调度与 Stage

Spark 将 DAG 划分为 Stage：

```
Stage 1：map + filter（无 Shuffle）
  ↓ Shuffle（数据重分区，网络传输）
Stage 2：reduceByKey（需要 Shuffle）
  ↓ Shuffle
Stage 3：sort + take（触发 Action）
```

**Shuffle 是 Spark 的性能瓶颈**：Shuffle 需要网络传输和磁盘排序。优化 Shuffle 次数（减少 `groupByKey`，用 `reduceByKey` 替代）是 Spark 性能调优的核心。

### DataFrame / Dataset API

RDD API 太底层，Spark 1.3 引入 DataFrame，Spark 2.0 引入 Dataset，提供更高层的结构化查询接口，配合 Catalyst 优化器自动优化执行计划：

```python
from pyspark.sql import SparkSession
from pyspark.sql.functions import col, count

spark = SparkSession.builder.getOrCreate()

# 结构化查询，Catalyst 自动优化
orders = spark.read.parquet("hdfs://orders/")
result = orders \
    .filter(col("amount") > 1000) \
    .groupBy("user_id") \
    .agg(count("*").alias("order_count")) \
    .orderBy(col("order_count").desc()) \
    .limit(100)

result.write.parquet("hdfs://output/")
```

### Spark Streaming（DStream）

Spark 1.x 的流处理方案：将无限流切割成微批次（Micro-batch，通常 1-5 秒），每个微批次跑一个 Spark 批处理 Job。

延迟：微批次粒度（秒级），无法做到毫秒级实时。

### Structured Streaming

Spark 2.0 引入 Structured Streaming，将流处理抽象为一张持续增长的无界表：

```python
# 将 Kafka 流看作一张无界表
stream = spark \
    .readStream \
    .format("kafka") \
    .option("kafka.bootstrap.servers", "...") \
    .option("subscribe", "orders") \
    .load()

# 同 DataFrame API，对流做聚合
result = stream \
    .selectExpr("CAST(value AS STRING) as json") \
    .groupBy(window(col("timestamp"), "5 minutes")) \
    .agg(sum("amount").alias("total"))

# 输出到 Kafka
result.writeStream \
    .format("kafka") \
    .option("checkpointLocation", "/checkpoint") \
    .start()
```

---

## Apache Flink

Flink（2014）是**以流为核心**的计算引擎，批处理被视为流处理的特例（有界流）。Flink 的设计目标：毫秒级延迟 + Exactly-Once 语义 + 真正的流批一体。

### 流处理的三大挑战

**1. 乱序事件（Out-of-Order Events）**：网络延迟导致事件不按时间顺序到达。统计过去 5 分钟的订单金额，"5 分钟前"的事件可能在"现在"才到达。

**2. 迟到数据（Late Data）**：事件处理时间（Processing Time）和事件发生时间（Event Time）不一致。

**3. 精确一次（Exactly-Once）**：系统故障恢复后，每条数据只被处理一次，不多不少。

### 时间语义

```
Processing Time：事件被 Flink 处理的时间（系统时间）
  → 最低延迟，但故障恢复后结果不确定

Event Time：事件实际发生的时间（数据中的时间戳字段）
  → 结果可确定（相同数据产生相同结果），但需要处理乱序

Ingestion Time：事件进入 Flink 的时间
  → 介于两者之间
```

**Watermark（水印）**：Flink 用 Watermark 追踪 Event Time 的进度。Watermark(t) 表示"t 时刻之前的数据已经全部到达"，触发窗口计算。

```python
# Watermark 策略：允许 5 秒的乱序延迟
watermark_strategy = WatermarkStrategy \
    .for_bounded_out_of_orderness(Duration.of_seconds(5)) \
    .with_timestamp_assigner(lambda event, _: event.timestamp)

stream = env \
    .from_source(kafka_source, watermark_strategy, "kafka") \
    .key_by(lambda e: e.user_id) \
    .window(TumblingEventTimeWindows.of(Time.minutes(5))) \
    .aggregate(SumAggregator())
```

### Chandy-Lamport 检查点（Flink 的容错机制）

Flink 的精确一次语义基于 **Chandy-Lamport 分布式快照算法**：

```
Checkpoint 流程：
1. JobManager 定期向所有 Source 注入 Barrier（屏障）
2. Barrier 流经整个算子 DAG，和数据一起传输
3. 每个算子收到所有输入的 Barrier 后：
   - 快照自己的状态（保存到分布式存储，如 HDFS/S3）
   - 向下游转发 Barrier
4. 所有算子完成快照 → 一个 Checkpoint 完成

故障恢复：
1. 回退到最近的 Checkpoint
2. 从 Source 重放 Checkpoint 之后的数据
3. 配合 Kafka 的 offset 重置，实现 Exactly-Once
```

:::启发
Flink 的 Checkpoint 机制是「Agent Checkpoint 设计」的经典参考之一——将状态快照和事件日志（Kafka offset）解耦，恢复时重放事件日志到快照之后的状态。Agent 领域的 Checkpoint 借鉴了完全相同的思路。（见 Agent Checkpoint 篇）
:::

### 状态管理

Flink 的算子可以维护状态（窗口聚合、去重等），状态存储在 State Backend：

| State Backend | 存储位置 | 适用场景 |
|--------------|---------|---------|
| **HashMapStateBackend** | JVM 内存 | 小状态，低延迟 |
| **EmbeddedRocksDBStateBackend** | 本地 RocksDB | 大状态（GB 级），数据溢出到磁盘 |

Checkpoint 时，状态被异步上传到 HDFS/S3，不阻塞数据处理。

### Flink SQL

Flink 提供了统一的 SQL 接口处理流和批：

```sql
-- 创建 Kafka Source 表
CREATE TABLE orders (
    order_id BIGINT,
    user_id  BIGINT,
    amount   DECIMAL,
    ts       TIMESTAMP(3),
    WATERMARK FOR ts AS ts - INTERVAL '5' SECONDS  -- Watermark 定义
) WITH (
    'connector' = 'kafka',
    'topic' = 'orders',
    'format' = 'json'
);

-- 5 分钟滚动窗口聚合（流式查询）
SELECT 
    TUMBLE_START(ts, INTERVAL '5' MINUTES) as window_start,
    user_id,
    SUM(amount) as total_amount
FROM orders
GROUP BY TUMBLE(ts, INTERVAL '5' MINUTES), user_id;
```

---

## Spark vs Flink 对比

| 维度 | Spark | Flink |
|------|-------|-------|
| **核心范式** | 批处理为主，流是微批 | 流处理为主，批是有界流 |
| **流处理延迟** | 秒级（微批） | 毫秒级（真流） |
| **Exactly-Once** | Structured Streaming 支持 | 原生支持 |
| **状态管理** | 有限（Structured Streaming） | 强大（丰富的状态原语） |
| **SQL** | Spark SQL（成熟） | Flink SQL（快速追赶） |
| **ML 生态** | MLlib（强大） | 弱 |
| **生态成熟度** | 更成熟（更大社区） | 流处理领域领先 |
| **适用场景** | 批处理、机器学习、SQL 分析 | 实时流处理、复杂事件处理 |

:::方法
**选型建议**：
- 批处理为主（离线数仓、ML 训练）→ Spark
- 实时流处理（毫秒级延迟、精确一次）→ Flink
- 需要流批统一且延迟要求不高 → Spark Structured Streaming
- 需要流批统一且延迟敏感 → Flink（流批一体是其核心优势）
:::

---

## 调度：YARN vs Kubernetes

早期分布式计算运行在专用集群（Hadoop YARN）上，现代系统逐渐迁移到 Kubernetes：

| 维度 | YARN | Kubernetes |
|------|------|-----------|
| **资源调度** | Container（YARN 概念） | Pod |
| **多租户** | Queue 隔离 | Namespace + ResourceQuota |
| **弹性伸缩** | 有限 | HPA/KEDA 原生支持 |
| **生态** | Hadoop 生态 | 云原生生态 |
| **Spark on K8s** | Spark on YARN（更成熟） | Spark on K8s（快速发展） |
| **Flink on K8s** | Flink on YARN | Flink Kubernetes Operator（推荐） |

---

## 小结

| 系统 | 核心创新 | 适用场景 |
|------|---------|---------|
| MapReduce | 分布式计算范式，移动计算而非数据 | 历史意义为主，现代已被 Spark 取代 |
| Spark | 内存计算，DAG 优化，统一批流 API | 批处理、机器学习、SQL 分析 |
| Flink | 真流处理，精确一次，强状态管理 | 实时计算、复杂事件处理、流批一体 |
