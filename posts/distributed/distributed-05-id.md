# 分布式 ID：从 UUID 到雪花算法的工程演进

全局唯一 ID 是分布式系统最基础的原语之一。每条订单、每个用户、每次事件都需要一个唯一标识符。单机时代用数据库自增主键就够了，但分布式环境下，自增主键无法跨分片保证唯一，而且会暴露业务量信息（通过 ID 推算日订单数）。

---

## 需求分析

一个好的分布式 ID 需要满足：

| 需求 | 含义 |
|------|------|
| **全局唯一** | 跨服务、跨数据中心不重复 |
| **趋势递增** | 主键递增有利于 B-Tree 索引性能（避免页分裂） |
| **高性能** | 生成 ID 不能成为系统瓶颈，需要支持高并发 |
| **高可用** | ID 生成服务故障不能导致业务中断 |
| **信息安全** | 不能从 ID 推算出业务量、时间等敏感信息 |

这些需求之间存在张力：全局唯一 + 趋势递增 + 高性能 + 信息安全很难同时满足。

---

## UUID

UUID（Universally Unique Identifier）是 128-bit 的标识符，最简单的全局唯一 ID 方案。

### 常用版本

**UUID v1**：基于时间戳 + MAC 地址。时间戳部分保证趋势递增，但 MAC 地址泄露隐私，且多机生成可能冲突（时钟调整时）。

**UUID v4**：纯随机生成（122 位随机）。绝对安全，无信息泄露，但完全随机导致 B-Tree 索引频繁页分裂，写入性能差。

**UUID v7**（RFC 9562，2024 年标准化）：基于 Unix 毫秒时间戳 + 随机数。兼顾趋势递增（时间前缀）和安全性（随机后缀）。

```
UUID v7 格式（128 bit）：
┌─────────────────┬──┬────────────────────────────────┐
│ 48 bit 毫秒时间戳 │ver│      74 bit 随机数              │
└─────────────────┴──┴────────────────────────────────┘
```

### UUID 的问题

- **体积大**：128 bit = 16 字节，字符串形式 36 字符（含连字符），是 bigint 的 2 倍
- **随机性导致索引碎片化**：v4 UUID 作为主键时，每次插入都在 B-Tree 的随机位置，导致大量页分裂，写性能下降

:::提醒
MySQL InnoDB 用主键作为聚簇索引，随机主键（UUID v4）会导致插入时频繁页分裂（Page Split），写入吞吐比自增主键低 30-50%，且存储碎片化严重。如果要用 UUID，优先选 v7（趋势递增），或存为 binary(16) 而非 varchar(36)。
:::

---

## 数据库自增序列的跨分片问题

单库时，`AUTO_INCREMENT` 简单好用。但分库分表后：

```
分片 A: 1, 2, 3, 4...
分片 B: 1, 2, 3, 4...  ← ID 重复！

合并查询时：SELECT * FROM orders WHERE order_id = 3 → 返回两条记录？
```

**常见解法（但都有代价）**：

- **步长模式**：分片 A 生成奇数（1, 3, 5...），分片 B 生成偶数（2, 4, 6...）。扩容时步长不好调整
- **号段预分配**：专门的 ID 服务批量分配号段（下文详述）
- **换用分布式 ID 方案**

---

## Twitter Snowflake

Snowflake 是 Twitter 2010 年开源的分布式 ID 生成方案，设计简洁，影响深远。

### 位图结构

```
 63      62          22       12          0
  │       │           │        │           │
  1 bit   41 bit      10 bit   12 bit
  符号位   毫秒时间戳   工作机器ID  序列号
  (0)     (从纪元起)   (最多1024机) (每毫秒4096个)
```

- **41 bit 时间戳**：从自定义纪元（如 2010-01-01）起的毫秒数，可用约 69 年
- **10 bit 工作机器 ID**：支持 1024 台机器（5 bit 数据中心 + 5 bit 机器号）
- **12 bit 序列号**：同一毫秒内最多生成 4096 个 ID，超出则等待下一毫秒

**理论最大吞吐**：4096 个/毫秒 × 1024 台机器 = 约 **420 万 ID/ms**（单机 4096 ID/ms ≈ 400 万 ID/s）

```python
class Snowflake:
    EPOCH = 1288834974657  # Twitter 纪元 (2010-11-04)
    WORKER_BITS = 10
    SEQUENCE_BITS = 12
    MAX_SEQUENCE = (1 << SEQUENCE_BITS) - 1  # 4095

    def __init__(self, worker_id):
        self.worker_id = worker_id
        self.sequence = 0
        self.last_timestamp = -1

    def next_id(self):
        ts = current_ms()
        if ts == self.last_timestamp:
            self.sequence = (self.sequence + 1) & self.MAX_SEQUENCE
            if self.sequence == 0:
                ts = wait_next_ms(self.last_timestamp)  # 等待下一毫秒
        else:
            self.sequence = 0
        self.last_timestamp = ts
        return ((ts - self.EPOCH) << 22) | (self.worker_id << 12) | self.sequence
```

### Snowflake 的问题

**时钟回拨**：如果服务器时钟向后调整（NTP 校时、闰秒），`current_ms()` 返回的值小于 `last_timestamp`，序列号计算出错，可能生成重复 ID。

解法：
1. 检测到时钟回拨时拒绝生成 ID，抛异常（简单但影响可用性）
2. 在序列号里留出空间记录回拨量（如百度 UidGenerator）
3. 用逻辑时钟代替物理时钟（取 `max(当前物理时间, 上次ID时间)`，容忍小幅回拨）

---

## 美团 Leaf

Leaf 是美团开源的分布式 ID 方案，提供两种模式。

### Leaf-Segment（号段模式）

在数据库里维护一张号段表：

```sql
CREATE TABLE leaf_alloc (
    biz_tag    VARCHAR(128) NOT NULL,   -- 业务标识
    max_id     BIGINT       NOT NULL,   -- 当前已分配的最大 ID
    step       INT          NOT NULL,   -- 每次分配的步长（号段大小）
    update_time DATETIME    NOT NULL
);
```

ID 生成服务从数据库批量取号段（如一次取 1000 个），本地缓存，用完再取。取号段用 `UPDATE SET max_id = max_id + step WHERE biz_tag = ?` 的 CAS 操作保证并发安全。

**双 Buffer 优化**：当当前号段使用到 10% 时，后台异步取下一个号段缓冲，避免号段用完后的等待。

优点：ID 连续性好，数据库压力低（批量取，不是每次都访问 DB）。
缺点：ID 不是绝对连续（服务重启后有号段浪费），数据库是单点（需要高可用 MySQL）。

### Leaf-Snowflake（Snowflake 模式）

解决 Snowflake 的 worker_id 分配问题（如何唯一分配机器 ID）和时钟回拨问题：

- **Worker ID 分配**：启动时连接 ZooKeeper，在 `/leaf/forever/{ip:port}` 创建持久化节点，记录 worker_id；下次重启从本地文件和 ZooKeeper 两处读取，防止 ZooKeeper 不可用
- **时钟回拨处理**：启动时读取 ZooKeeper 记录的上次服务时间，若当前时间小于记录时间则拒绝启动；运行中检测回拨，小于 5ms 等待，大于 5ms 告警

---

## 其他方案

### Redis INCR

```bash
INCR order_id_counter  # 原子递增，返回全局唯一递增值
```

简单高效，但：Redis 宕机时 ID 可能丢失（AOF 持久化有延迟），持久化会影响性能。适合对 ID 连续性要求不高的场景。

### MongoDB ObjectId

```
ObjectId（12 字节）：
4字节时间戳 + 5字节随机数（机器+进程） + 3字节递增计数
```

趋势递增（前缀是时间戳），自包含（无需中心服务），MongoDB 内置。局限：体积比 bigint 大，在非 MongoDB 环境使用有些奇怪。

### 数据库序列（PostgreSQL / Oracle）

```sql
CREATE SEQUENCE global_id_seq START 1 INCREMENT 50;  -- 步长50，批量缓存
SELECT nextval('global_id_seq');
```

数据库原生序列，可靠，但数据库是性能瓶颈。适合中低并发场景。

---

## 选型对比

| 方案 | 唯一性 | 趋势递增 | 性能 | 依赖 | 适用场景 |
|------|--------|---------|------|------|---------|
| UUID v7 | ✅ | ✅ | 极高（本地） | 无 | 无需中心服务、跨语言 |
| UUID v4 | ✅ | ❌ | 极高（本地） | 无 | 对索引性能不敏感的场景 |
| Snowflake | ✅ | ✅ | 极高（本地） | 机器 ID 分配 | 高并发、无需中心服务 |
| Leaf-Segment | ✅ | ✅（局部） | 高 | MySQL | 需要连续号段、对 DB 有要求 |
| Redis INCR | ✅ | ✅ | 高 | Redis | 简单场景 |
| 数据库序列 | ✅ | ✅ | 低 | DB | 低并发场景 |

:::方法
**选型建议**：
- 新项目、无历史包袱：优先 UUID v7（标准化、无依赖、趋势递增）
- 高并发、需要 bigint 主键：Snowflake（处理好时钟回拨）
- 需要业务可读的连续号段（如订单号展示给用户）：Leaf-Segment
- 已有 Redis：Redis INCR + 号段缓存
:::

---

## 时钟回拨的生产处理

时钟回拨是 Snowflake 系算法最常被忽视的生产隐患：

```
发现时钟回拨的正确处理流程：

1. 记录回拨量 = last_timestamp - current_ms
2. 如果回拨量 ≤ 5ms → 等待 5ms 让时钟追上
3. 如果回拨量 > 5ms → 告警 + 拒绝生成 ID（或切换到备用序列）
4. 云环境必须关闭 NTP 的直接调整（用 chrony 做平滑调整，而非跳变）
```

在虚拟机（VM）和容器环境里，时钟回拨更常见（VM 迁移、容器重调度）。生产部署时应将时钟同步工具从 ntpdate（跳变）换成 chrony（平滑渐进调整）。

---

## 小结

| 概念 | 核心要点 |
|------|----------|
| UUID v4 | 完全随机，安全但索引性能差 |
| UUID v7 | 时间前缀 + 随机，2024 年标准，推荐新项目 |
| Snowflake | 时间戳+机器ID+序列号，高性能，注意时钟回拨 |
| Leaf-Segment | 数据库号段批量分配，强连续性，适合展示类 ID |
| 时钟回拨 | 等待/告警/拒绝，生产环境改用 chrony 平滑同步 |
