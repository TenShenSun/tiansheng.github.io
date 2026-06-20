# 分布式数据库：Spanner、TiDB 与 NewSQL 的架构解析

NewSQL 的野心是打破一个长期存在的认知：**关系模型（SQL + ACID）和水平扩展（Sharding）不可兼得**。Google Spanner（2012）第一次在生产规模上证明这是可以同时做到的，尽管代价极高。TiDB、CockroachDB 等则用更工程化的方式在通用硬件上实现了类似能力。

---

## 从分库分表到 NewSQL 的演进

### 分库分表的痛点

互联网早期的扩展方案：手动拆分数据库和表，用 Sharding-Middleware（如 MyCat、ShardingSphere）路由查询。

```
分库分表的六大痛点：

1. 跨分片查询（SELECT * JOIN）性能差，甚至不支持
2. 分布式事务（跨分片写）极难实现
3. 全局排序、聚合（ORDER BY、GROUP BY、COUNT(*)）需要在应用层合并
4. 扩容难（加分片需要数据迁移，通常需要停服窗口）
5. 业务代码侵入（需要指定分片 key，绕开跨分片操作）
6. 全局索引难以维护（非分片键的查询需要广播到所有分片）
```

### NewSQL 的目标

NewSQL 数据库（Spanner、TiDB、CockroachDB、YugabyteDB）要同时提供：

- **SQL 接口**：兼容 MySQL / PostgreSQL 协议，业务代码几乎无需改动
- **ACID 事务**：跨分片的强一致事务，不需要应用层处理
- **水平扩展**：自动分片、自动 rebalance，对业务透明
- **高可用**：基于共识协议（Raft），自动故障切换

---

## Google Spanner

Spanner（2012 年论文）是 Google 的全球分布式数据库，支撑 Google Ads、Google Play 等核心业务，是 NewSQL 的奠基性系统。

### 核心架构

```
全球部署：
  North America Zone    Asia Zone      Europe Zone
  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
  │ Spanserver × N│  │ Spanserver × N│  │ Spanserver × N│
  │  (Paxos组)   │  │  (Paxos组)   │  │  (Paxos组)   │
  └──────────────┘  └──────────────┘  └──────────────┘
            ↕ 全球同步复制（Paxos跨Zone）
  Universe Master（监控）+ Placement Driver（数据分布）
```

数据分成 Tablet（分片），每个 Tablet 由一个 **Paxos 组**管理（5 副本跨 Zone 分布）。写操作通过 Paxos 复制到多数副本。

### TrueTime：外部一致性的基础

Spanner 的最大创新：用 **GPS + 原子钟** 实现有界不确定性时钟 API：

```python
# TrueTime API 返回的不是单点时间，而是区间
tt = TrueTime.now()
# tt.earliest: 最早可能的时间
# tt.latest:   最晚可能的时间
# 保证：真实时间 ∈ [tt.earliest, tt.latest]
# 误差通常 < 7ms（全球 99th percentile）
```

**外部一致性（External Consistency）**：如果事务 T1 在 T2 开始之前提交，那么 T1 的时间戳一定小于 T2 的时间戳，无论 T1、T2 在哪个数据中心执行。

**Commit Wait**：事务提交时，等待 TrueTime 不确定窗口过去再返回成功。这确保了该事务的提交时间一定大于所有已提交事务的时间戳：

```
事务 T 的提交流程：
1. 选择提交时间戳 s = TrueTime.now().latest
2. 将 s 复制到 Paxos 多数节点
3. 等待直到 TrueTime.now().earliest > s（Commit Wait，通常 1-7ms）
4. 返回客户端成功
```

Commit Wait 是 Spanner 写延迟高于本地数据库的主要原因（额外 1-7ms）。

### Spanner 的 F1（SQL 层）

Spanner 原生是 KV 存储，F1 是构建在 Spanner 上的关系数据库层，支持标准 SQL。

数据模型使用**交错表（Interleaved Tables）**——子表的行物理上存储在父表行的旁边，避免跨 Tablet 的 JOIN：

```sql
CREATE TABLE Users (
    user_id INT64 NOT NULL,
    name STRING(255)
) PRIMARY KEY (user_id);

CREATE TABLE Orders (
    user_id INT64 NOT NULL,
    order_id INT64 NOT NULL,
    amount FLOAT64
) PRIMARY KEY (user_id, order_id),
  INTERLEAVE IN PARENT Users ON DELETE CASCADE;
-- Orders 行物理上存储在 Users 行旁边，按 user_id 分组
```

---

## CockroachDB

CockroachDB（"蟑螂"——能在各种灾难下存活）是开源的 NewSQL 数据库，兼容 PostgreSQL 协议。

### 架构

```
SQL 层（PostgreSQL 协议兼容）
     ↓
分布式事务层（MVCC + 2PC + Timestamp Oracle）
     ↓
分布式 KV 层（Range = 分片，每 Range 由 Raft 组管理）
     ↓
RocksDB（LSM-Tree 存储引擎，每个节点本地存储）
```

### 混合逻辑时钟（HLC）

CockroachDB 无法使用 TrueTime（需要专用硬件），改用 **HLC（Hybrid Logical Clock）**：

```python
# HLC 结合物理时钟和逻辑时钟
# hlc = (physical_time_ms, logical_counter)
# 保证：HLC 单调递增，且大致跟随物理时钟

def update_hlc(local_hlc, received_hlc):
    max_physical = max(local_hlc.pt, received_hlc.pt, now_ms())
    if max_physical == local_hlc.pt == received_hlc.pt:
        logical = max(local_hlc.lc, received_hlc.lc) + 1
    elif max_physical == local_hlc.pt:
        logical = local_hlc.lc + 1
    elif max_physical == received_hlc.pt:
        logical = received_hlc.lc + 1
    else:
        logical = 0
    return HLC(max_physical, logical)
```

HLC 不能像 TrueTime 那样给出有界的不确定性区间，所以 CockroachDB 需要在不确定区间内重试读取（Uncertainty Interval Restart），引入额外延迟，但比 Commit Wait 的影响更分散。

### Range 与 Raft

数据按 key 字典序划分为 **Range（默认 64MB）**，每个 Range 由一个 **3/5 副本的 Raft 组**管理，副本分布在不同节点（或不同机架/区域）。

Leaseholder（持有租约的 Raft Leader）直接处理该 Range 的读写，无需每次都走 Raft 共识（读可以直接从 Leaseholder 读，减少一轮网络往返）。

---

## TiDB

TiDB 是 PingCAP 开发的开源 NewSQL 数据库，兼容 MySQL 协议，是国内最广泛部署的 NewSQL 系统。

### 三层架构

```
┌─────────────────────────────────────────────────────┐
│                    TiDB（SQL 层）                    │
│    MySQL 协议兼容、SQL 解析、查询优化、分布式执行计划  │
└──────────────────────┬───────────────┬───────────────┘
                       ↓               ↓
┌─────────────────────────┐  ┌──────────────────────────┐
│      TiKV（行存储）      │  │   TiFlash（列存储，HTAP）  │
│  分布式 KV，Multi-Raft   │  │  列式存储，AP 分析查询     │
│  MVCC + RocksDB          │  │  异步从 TiKV 同步数据      │
└─────────────────────────┘  └──────────────────────────┘
                  ↑
┌─────────────────────────────────────────────────────┐
│                PD（Placement Driver）                │
│    集群元数据、Region 调度、负载均衡、时间戳分配       │
└─────────────────────────────────────────────────────┘
```

**TiDB**：无状态 SQL 层，处理 MySQL 协议请求，生成分布式执行计划，协调 TiKV 和 TiFlash。

**TiKV**：分布式 KV 存储，数据按 Region（96MB）分片，每 Region 由 Multi-Raft 管理。MVCC 实现多版本并发控制。

**TiFlash**：列式存储副本，从 TiKV 异步同步数据，支持 HTAP（Hybrid Transactional/Analytical Processing）——在同一套系统上同时跑 OLTP 和 OLAP。

**PD（Placement Driver）**：集群大脑，负责 Region 调度（均衡各节点的 Region 数量和 Leader 数量）、时间戳分配（全局单调递增的 TSO，用于 MVCC）。

### MVCC（多版本并发控制）

TiKV 的 MVCC 将时间戳附加在 key 上，每次写操作生成新版本而非覆盖旧版本：

```
key: "user_1" → 版本历史：
  (ts=100) → {"name": "Alice", "age": 25}
  (ts=200) → {"name": "Alice", "age": 26}
  (ts=300) → {"name": "Alice", "age": 27}  ← 最新版本

读操作携带时间戳 ts=250，读到的是 ts=200 的版本
（快照隔离：看到事务开始时的数据快照，不受后续写入影响）
```

GC（垃圾回收）定期清理超出保留时间的旧版本。

### 分布式事务（Percolator 模型）

TiDB 的分布式事务基于 Google Percolator 论文，2PC 变体：

```
事务流程（写事务）：
1. 从 PD 获取 start_ts（开始时间戳）
2. Prewrite（类似 2PC Phase 1）：
   - 选择第一个写操作为 Primary Lock
   - 其他写操作为 Secondary Lock，引用 Primary
   - 检查写冲突（是否有比 start_ts 更新的写入）
3. 从 PD 获取 commit_ts（提交时间戳）
4. Commit Primary Lock：将 Primary 从 Lock 转为 Write 记录
5. 异步 Commit Secondary Locks

读操作：如果遇到 Lock（事务未提交），等待或主动 Resolve（检查 Primary Lock 状态）
```

---

## 分布式 SQL 的共同挑战

### 跨分片 JOIN

```sql
-- 如果 orders 和 users 在不同分片
SELECT u.name, o.amount 
FROM users u JOIN orders o ON u.user_id = o.user_id
WHERE o.amount > 1000;
```

执行选择：
1. **下推（Push-down）**：将 Filter 下推到存储层，减少网络传输
2. **Broadcast JOIN**：将小表广播到所有节点，各节点本地 JOIN
3. **Hash JOIN**：按 JOIN key 重新分片两张表，保证相同 key 在同一节点

### 全局索引

非分片键的查询（如按 email 查 user_id，但分片键是 user_id）需要广播查询到所有分片，或维护全局二级索引（会带来额外的跨分片写开销）。

### 热点问题

自增主键或时间序列数据会导致所有写入集中到最大 Region，产生写热点。解法：UUID 主键（分散写）、显式打散（TiDB 的 `SHARD_ROW_ID_BITS`）。

---

## 系统对比

| 维度 | Spanner | CockroachDB | TiDB |
|------|---------|-------------|------|
| **SQL 兼容** | SQL（自定义方言） | PostgreSQL | MySQL |
| **时钟方案** | TrueTime（GPS+原子钟） | HLC | PD TSO（中心化） |
| **存储引擎** | 自研 | RocksDB | TiKV (RocksDB) |
| **共识算法** | Paxos | Raft | Raft |
| **HTAP** | BigQuery 集成 | 有限 | TiFlash（原生） |
| **开源** | 否（Cloud Spanner） | 是 | 是 |
| **国内使用** | GCP 才能用 | 较少 | 广泛（TiDB Cloud） |

---

## 小结

NewSQL 不是 NoSQL 的反义词，而是「既要 SQL 的易用性，又要 NoSQL 的扩展性」的工程尝试。Spanner 用专用硬件（TrueTime）和大规模工程投入证明了可行性，TiDB/CockroachDB 用更开放的方案让这个能力走向大众。

选型建议：
- **Spanner**：已在 GCP 上，对延迟要求极高，预算充足
- **TiDB**：兼容 MySQL、HTAP 需求、国内生态好、开源
- **CockroachDB**：兼容 PostgreSQL、多云/多区域部署、开源
- **继续分库分表**：现有系统已有成熟的分片方案，短期迁移成本大于收益
