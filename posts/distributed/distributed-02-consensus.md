# Paxos → Raft：分布式共识的工程演进

分布式系统最核心的问题之一是：**如何让多个节点对同一件事达成一致？** 节点可能宕机、消息可能丢失、网络可能分区——在这种环境下，要让多数节点就某个值（日志条目、Leader 身份、配置变更）达成永久一致，就需要共识算法。

---

## 为什么需要共识

### 共识的经典场景

- **Leader 选举**：集群里谁是主节点？Zookeeper、etcd 用来做服务协调
- **日志复制**：写操作以什么顺序写入多个副本？Raft 的核心工作
- **配置管理**：哪些节点在集群里、配置怎么变更？Kubernetes 的 etcd

### 共识的三个保证

1. **Agreement（一致性）**：所有正确节点最终决定相同的值
2. **Validity（有效性）**：决定的值必须是某个节点提议的值（不能凭空产生）
3. **Termination（终止性）**：最终会做出决定（不会永远等待）

:::提醒
FLP 不可能定理（1985）证明：在异步系统中（消息延迟无上限），没有算法能同时保证共识的一致性、有效性和终止性（哪怕只有一个节点可能崩溃）。Paxos 和 Raft 的工程解法是：引入随机化超时，在实践中大概率终止，绕过理论上的不可能。
:::

---

## Basic Paxos

Paxos 由 Leslie Lamport 在 1989 年提出（论文 1998 年才发表），是大多数共识算法的理论基础。

### 三个角色

| 角色 | 职责 |
|------|------|
| **Proposer（提案者）** | 提出值，驱动共识过程 |
| **Acceptor（接受者）** | 接受或拒绝提案，持久化状态 |
| **Learner（学习者）** | 学习最终决定的值 |

实际节点可以同时扮演多个角色。

### 两阶段协议

**Phase 1：Prepare**

Proposer 选择提案编号 `n`，向多数 Acceptor 发送 `Prepare(n)`。

Acceptor 收到后：
- 如果 `n` 大于曾经见过的所有提案编号，承诺不再接受编号小于 `n` 的提案，并返回自己已接受的最高编号提案（如有）
- 否则拒绝

**Phase 2：Accept**

Proposer 收到多数 Acceptor 的 Promise 后：
- 如果有 Acceptor 返回了已接受的值，必须沿用那个值
- 否则可以提议自己的值

发送 `Accept(n, value)` 给多数 Acceptor。Acceptor 在不违背 Phase 1 承诺的前提下接受，发送 `Accepted` 给 Learner。

```
Proposer        Acceptor A    Acceptor B    Acceptor C
    |                |             |             |
    |── Prepare(1) ─→|── Prepare(1)─→             |
    |←─ Promise(1) ──|←─ Promise(1)─              |
    |── Accept(1,v) →|── Accept(1,v)→             |
    |←─ Accepted ────|←─ Accepted──               |
    |                                 Learner 收到 v
```

### Basic Paxos 的局限

Basic Paxos 一次只能就**一个值**达成共识，而实际系统需要对**一系列值**（日志条目序列）达成共识。此外：
- 多 Proposer 同时提案会导致活锁（互相打断，都无法完成）
- 提案编号冲突时需要重试，延迟不可预测

---

## Multi-Paxos

Multi-Paxos 是对 Basic Paxos 的工程扩展，目标是高效地对日志序列达成共识。

### 核心优化：稳定 Leader

选出一个稳定的 Leader（通过 Basic Paxos 或 Leader 租约），让 Leader 负责所有 Prepare + Accept 操作：

- **正常路径**：只需 Accept 一轮（跳过 Prepare，因为 Leader 已经确立）
- **Leader 更换**：运行完整的 Basic Paxos 选出新 Leader

### 日志空洞问题

如果某个日志索引的 Accept 消息丢失，可能产生空洞（hole）。Multi-Paxos 需要专门处理：学习缺失的索引、填充 no-op 条目。

:::启发
Multi-Paxos 在论文里从未有过完整的正式规范，这是 Raft 出现的根本原因——Lamport 描述了核心思想，但省略了很多工程细节（Leader 选举、日志空洞、成员变更），导致每个实现都有细微差异，容易出 bug。
:::

---

## Raft

Raft 由 Diego Ongaro 和 John Ousterhout 在 2014 年提出，核心设计目标是**可理解性**。Raft 将共识问题分解为三个相对独立的子问题：Leader 选举、日志复制、安全性。

### Leader 选举

**节点状态机**：

```
         超时，发起选举
Follower ──────────────→ Candidate ──── 赢得多数票 ────→ Leader
    ↑                       |                              |
    └── 收到合法心跳 ────────┘←─── 发现更高 Term ──────────┘
        或投票给别人
```

**Term（任期）**：Raft 用单调递增的 Term 编号代替 Paxos 的提案编号。每次选举开始时 Term +1。Term 是 Raft 的逻辑时钟。

**选举过程**：
1. Follower 超时未收到 Leader 心跳，转为 Candidate
2. 自增 Term，向所有节点发送 RequestVote RPC
3. 节点按「先到先得 + 日志是否最新」规则投票，每个 Term 只投一票
4. 获得多数票的 Candidate 成为 Leader，立即发送心跳

**随机选举超时（150-300ms）**：防止多个 Follower 同时超时，避免选票瓜分（Split Vote）。

### 日志复制

Leader 接受客户端写请求，将日志条目复制到所有 Follower：

```
客户端 → Leader → AppendEntries(日志条目) → Followers
                ← 多数 Follower 确认 ←
                → 提交（Apply to State Machine）
                → 返回客户端成功
                → 通知 Followers 已提交
```

**日志匹配属性**：如果两个节点的日志在相同索引处有相同 Term，则该索引前的所有日志完全相同。Leader 通过携带前一条日志的 (index, term) 来检测日志分歧，强制 Follower 与 Leader 对齐。

### 安全性保证

**选举限制**：Candidate 只有在日志比大多数节点更新的情况下才能赢得选举（比较最后一条日志的 Term 和 Index）。这确保新 Leader 一定包含所有已提交的日志。

**提交规则**：Leader 只提交当前 Term 的日志，不直接提交旧 Term 的日志（通过当前 Term 的提交间接提交旧日志）。防止已提交的日志被覆盖。

### 成员变更（Joint Consensus）

集群成员变更（加节点、删节点）如果处理不当会产生两个多数派同时存在的情况。Raft 的解法是 Joint Consensus：

1. 先切换到 `C_old,new`（新旧配置的并集）需要**新旧两个多数派**同时批准
2. 再切换到 `C_new`（纯新配置）

现代实现（如 etcd）通常用更简单的单节点变更方案：一次只加/删一个节点。

---

## Multi-Raft 与工程实践

单个 Raft 组的写吞吐有限（所有写都经过 Leader）。生产系统用 **Multi-Raft**：将数据分成多个分片（Region），每个分片独立运行一个 Raft 组。

```
分片 1: [Leader:Node1, Follower:Node2, Follower:Node3]
分片 2: [Leader:Node2, Follower:Node1, Follower:Node4]
分片 3: [Leader:Node3, Follower:Node4, Follower:Node5]
```

各节点同时担任不同分片的 Leader/Follower，负载均衡。

| 系统 | 共识算法 | 特点 |
|------|---------|------|
| **etcd** | Raft | Kubernetes 的数据存储，注重一致性 |
| **TiKV** | Multi-Raft | 每个 Region 独立 Raft 组，PD 调度 |
| **CockroachDB** | Multi-Raft | 每个 Range 独立 Raft 组 |
| **ZooKeeper** | ZAB（类 Paxos） | Zookeeper Atomic Broadcast |
| **Consul** | Raft | 服务发现 + 健康检查 |

---

## Paxos vs Raft 对比

| 维度 | Paxos（Multi-Paxos） | Raft |
|------|---------------------|------|
| **可理解性** | 难（很多细节留给实现者） | 易（论文有完整规范） |
| **Leader 选举** | 隐含，需自行设计 | 显式 Term + 随机超时 |
| **日志空洞** | 需特殊处理 | 不允许空洞 |
| **成员变更** | 实现复杂 | Joint Consensus 或单节点变更 |
| **性能** | 理论上更灵活 | 实践中差别不大 |
| **生产使用** | Google Chubby、Megastore | etcd、TiKV、CockroachDB |

:::观点
Raft 的成功不在于性能超越 Paxos，而在于可理解性。一个工程师能在一周内读懂并实现 Raft，但需要数月才能正确实现 Multi-Paxos。这在工程质量和 bug 密度上有巨大差异。
:::

---

## 拜占庭容错（BFT）简介

Paxos 和 Raft 都假设节点是诚实的——要么正常工作，要么 Crash-Stop。但如果节点会发送错误数据（被攻击、软件 bug 导致脏数据），就需要拜占庭容错算法（BFT）。

- **容错能力**：Crash-Stop 容错 `f` 个节点只需 `2f+1` 个节点，BFT 容错 `f` 个节点需要 `3f+1` 个节点
- **性能代价**：BFT 通信复杂度通常是 O(n²)，远高于 Paxos/Raft 的 O(n)
- **应用场景**：区块链（Bitcoin/Ethereum PoW/PoS 是 BFT 的变体）、航天系统、金融结算系统

实用 BFT 算法：PBFT（实用拜占庭容错）、Tendermint（区块链共识）。

---

## 小结

| 概念 | 核心要点 |
|------|----------|
| FLP 定理 | 异步系统中没有完美共识算法，工程解法是随机超时 |
| Basic Paxos | 单值共识的理论基础，两阶段提案 |
| Multi-Paxos | 日志序列共识，稳定 Leader 减少 Prepare 轮次 |
| Raft | 强领导者模型，可理解性优先，etcd/TiKV/CockroachDB 使用 |
| Multi-Raft | 数据分片后每个分片独立 Raft，水平扩展写吞吐 |
| BFT | 处理恶意节点，通信成本高，用于区块链/航天 |
