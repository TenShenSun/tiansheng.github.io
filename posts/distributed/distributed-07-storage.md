# 分布式存储：从 Dynamo 到 Bigtable 的架构图谱

分布式存储系统的核心设计差异可以归结为两个正交维度：**一致性 vs 可用性**（CAP 取舍）和**存储引擎设计**（LSM-Tree vs B-Tree）。理解这两个维度，就理解了 Dynamo、Bigtable、Cassandra、HBase 的架构本质。

---

## 存储引擎：LSM-Tree vs B-Tree

存储引擎是数据库/存储系统的底层读写核心。绝大多数现代分布式存储系统在这两种引擎之间选择。

### B-Tree

**传统关系数据库（MySQL InnoDB、PostgreSQL）的标配**。

B-Tree 将数据按键排序存储在**固定大小的页（Page，通常 4-16KB）**上，页之间通过树形结构连接。

```
        [10 | 30 | 50]         ← 内部节点（路由）
       /    |    |    \
  [1-9] [11-29] [31-49] [51+] ← 叶节点（数据）
```

**写操作**：定位到叶节点 → 修改页内数据 → 写 WAL（预写日志）→ 脏页异步刷盘。

B-Tree 的写是**随机写**（更新任意位置的页），随机写磁盘比顺序写慢 100x（机械盘）到 10x（SSD）。

优点：读性能好（O(log n) 定位），支持范围查询，更新操作直接原地修改。

### LSM-Tree（Log-Structured Merge-Tree）

**现代 NoSQL 存储（RocksDB、LevelDB、Cassandra、HBase）的标配**。

核心设计思想：**将随机写转换为顺序写**。

```
写入流程：
1. 写 WAL（顺序写，防宕机丢失）
2. 写内存表（MemTable，有序跳表，支持快速查找）
3. MemTable 达到阈值 → 持久化为 SSTable 文件（Sorted String Table）
4. 后台 Compaction：合并多个 SSTable，删除旧版本，整理层级

层级结构（LevelDB/RocksDB）：
L0: 4个SSTable（新写入，可能重叠）
L1: 10MB（有序，不重叠）
L2: 100MB
L3: 1000MB
...（每层大10x）
```

**读操作**：先查 MemTable → L0 SSTable（可能有多个，需全查）→ L1 → ... → Bloom Filter 过滤不存在的 key，减少磁盘 IO。

| 维度 | B-Tree | LSM-Tree |
|------|--------|----------|
| **写性能** | 中（随机写） | 高（顺序写） |
| **读性能** | 高（直接定位） | 中（可能多层查找） |
| **写放大** | 低 | 高（Compaction 重写数据） |
| **空间放大** | 低 | 中（旧版本数据存在直到 Compaction） |
| **适用** | 读多写少、需要低延迟读 | 写多读少、日志型数据 |

---

## 数据分片：如何把数据分散到多个节点

### 范围分片（Range Sharding）

按 key 的范围划分：A-G → 节点1，H-P → 节点2，Q-Z → 节点3。

优点：范围查询高效（同一分片内有序）。  
缺点：热点问题（如按时间分片时，当前时间段的分片压力最大）。

Bigtable / HBase 使用范围分片，Region 是分片单元。

### 一致性哈希（Consistent Hashing）

将 key 和节点都映射到 [0, 2^32) 的哈希环上，key 归属于环上顺时针方向的第一个节点。

```
哈希环（0 ~ 2^32）：

      Node A (0)
    /            \
Node D          Node B
(270°)          (90°)
    \            /
      Node C (180°)

Key "order_123" → hash → 150° → 归属 Node C
```

**虚拟节点（Virtual Nodes）**：每个物理节点在环上映射多个虚拟节点，避免节点分布不均导致的负载倾斜。

加减节点时，只需迁移相邻虚拟节点的数据，而非全量重分布。

Cassandra / DynamoDB 使用一致性哈希。

---

## 副本策略

### 主从复制（Single-Leader）

所有写操作路由到主节点，主节点同步或异步复制到从节点，从节点只读。

- **同步复制**：主节点等待从节点确认才返回成功，强一致但延迟高
- **异步复制**：主节点写完即返回，从节点异步追赶，延迟低但主节点宕机可能丢数据

适用：读多写少，接受读到略旧数据（从节点）。

### 多主复制（Multi-Leader）

多个节点同时接受写操作，节点间互相同步，需要处理写冲突。

**冲突解决策略**：
- Last-Write-Wins（LWW）：时间戳大的胜，简单但可能丢数据（时钟不可信）
- 版本向量：保留所有冲突版本，由客户端或应用层合并
- CRDT（无冲突复制数据类型）：设计数据结构使合并操作可交换，如计数器、集合

### 无主复制（Leaderless）：Quorum

客户端直接与多个节点通讯，用 Quorum 机制保证一致性：

```
N = 总副本数（如 3）
W = 写操作需要的确认节点数（如 2）
R = 读操作需要查询的节点数（如 2）

条件：W + R > N（2 + 2 > 3）→ 读写操作必有重叠，能读到最新值
```

**Read Repair**：读取时发现节点数据不一致，将最新数据回写到落后的节点。

**Anti-Entropy（后台同步）**：后台进程用 Merkle Tree 比较节点间数据差异，主动同步。

---

## Amazon Dynamo

Dynamo（2007 年论文）是 Amazon 内部的高可用键值存储，设计优先级：**可用性 > 一致性**。

### 核心设计

**一致性哈希 + 虚拟节点**：数据分布，支持动态扩缩容。

**N/W/R 可调 Quorum**：不同业务场景选择不同的一致性强度：
- `W=1, R=1`：最低延迟，最终一致
- `W=N, R=1`：强写一致，读快
- `W=1, R=N`：强读一致，写快

**向量时钟 + 语义协调**：写冲突时保留多个版本（siblings），由客户端负责合并。购物车场景：用并集合并两个冲突版本的购物车，不丢任何商品。

**Hinted Handoff**：目标节点暂时不可用时，临时写入另一个节点，等目标节点恢复后转交。

**Sloppy Quorum**：分区时允许写入"不完全正确"的节点，优先保证可用性。

### Dynamo 的适用场景

高可用要求、接受最终一致、查询模式简单（主要按 key 查找）、不需要跨多 key 的事务。

---

## Google Bigtable

Bigtable（2006 年论文）是 Google 的分布式结构化存储，设计优先级：**强一致 + 高吞吐**。

### 数据模型

```
Table: Webtable

Row Key (URL，逆序存储)
  → com.google.www/
      ↓
      Column Family: contents
        → contents:html  [t3] "<html>..."
                         [t2] "<html>..."  ← 多版本（时间戳）
      Column Family: links
        → links:com.cnn.www   [t1] "CNN"
        → links:com.bbc.co.uk [t1] "BBC"
```

- **行键（Row Key）**：范围分区依据，按字典序排序
- **列族（Column Family）**：物理存储单元，同一列族的数据存储在一起（列式存储的变体）
- **时间戳（Timestamp）**：每个单元格可以存多个版本

URL 逆序存储（`com.google.www` 而非 `www.google.com`）是为了让同一域名的 URL 在范围扫描时相邻。

### 架构

```
客户端
  ↓
Chubby（分布式锁服务，负责 Master 选举、Tablet Location）
  ↓
Master（管理节点）：负责 Tablet 分配、负载均衡、Tablet Server 故障恢复
  ↓
Tablet Servers（1000s）：每个 Tablet Server 管理 10-1000 个 Tablet（分片）
  ↓
GFS（底层存储）：所有数据（SSTable）存储在 GFS 上，Tablet Server 无状态
```

**Tablet Server 的无状态化**是关键设计：数据存在 GFS，Tablet Server 宕机后 Master 可以立刻将 Tablet 分配给其他 Tablet Server，无需数据迁移。

---

## Cassandra

Cassandra 是融合了 Dynamo 的可用性设计和 Bigtable 数据模型的分布式数据库，来自 Facebook（后开源到 Apache）。

### 架构特点

- **无主（Leaderless）架构**：所有节点对等，无单点，高可用
- **一致性哈希分片**：类 Dynamo
- **CQL（Cassandra Query Language）**：类 SQL 的查询语言，支持 UDT、集合类型
- **LSM-Tree 存储引擎**：写性能极高

### 数据建模：查询驱动

Cassandra 的数据建模与关系数据库相反——**先想好查询，再设计表结构**。

```sql
-- 反规范化：冗余数据，按查询优化
-- 查询：获取某用户的所有订单（按时间倒序）
CREATE TABLE orders_by_user (
    user_id  UUID,
    created_at TIMESTAMP,
    order_id UUID,
    total    DECIMAL,
    PRIMARY KEY (user_id, created_at)  -- user_id 是分区键，created_at 是聚类键
) WITH CLUSTERING ORDER BY (created_at DESC);
```

分区键（Partition Key）决定数据在哪个节点，聚类键（Clustering Key）决定同一分区内的数据排序。

### 一致性级别

```
ALL       → 所有副本确认，强一致，延迟最高
QUORUM    → 多数副本确认，通常选择
LOCAL_QUORUM → 本数据中心多数副本，多数据中心场景推荐
ONE       → 单副本确认，最低延迟，最终一致
```

---

## 系统对比

| 维度 | Dynamo | Bigtable / HBase | Cassandra |
|------|--------|-----------------|-----------|
| **一致性** | 最终一致（AP） | 强一致（CP） | 可调（ONE 到 ALL） |
| **数据模型** | KV | 宽列（Wide Column） | 宽列（CQL） |
| **分片** | 一致性哈希 | 范围分片（Region） | 一致性哈希 |
| **副本** | 无主（Sloppy Quorum） | 主从（GFS 层） | 无主（Quorum） |
| **扩展性** | 极高（无主） | 高（Region 分裂/合并） | 极高（无主） |
| **适用场景** | 购物车、用户 Profile | 时序数据、网页索引 | IoT 数据、日志、时序 |

---

## 对象存储（Amazon S3 / 阿里云 OSS）

对象存储不是传统意义上的分布式数据库，但它是云时代最重要的存储形态之一。

**核心特点**：
- 键值对（key = 对象路径，value = 对象内容），但 value 可以是 GB 级别的二进制文件
- 按对象（Object）存储，不支持修改（只能覆盖整个对象）
- 最终一致（S3 现已支持强一致）
- 近乎无限扩展，成本低（比块存储便宜 10-50x）

**适用**：静态资源（图片、视频、文档）、数据湖（Parquet/ORC 文件）、备份存储、AI 训练数据。

---

## 小结

| 概念 | 核心要点 |
|------|----------|
| LSM-Tree | 顺序写，适合写密集，Compaction 控制读放大 |
| B-Tree | 随机写，适合读多写少，原地更新 |
| 一致性哈希 | 弹性扩缩容，节点变更只影响相邻数据 |
| Quorum | N/W/R 可调，在一致性和可用性间滑动 |
| Dynamo | AP 优先，最终一致，购物车/用户 Profile |
| Bigtable | CP 优先，强一致，宽列模型，时序/索引 |
| Cassandra | 可调一致性，无主高可用，IoT/日志 |
