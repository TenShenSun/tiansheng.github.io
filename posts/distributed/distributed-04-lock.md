# 分布式锁：Redis、ZooKeeper、etcd 实现对比

分布式锁不是本地锁的网络版。本地锁只需要解决「同一进程内多线程争用」的问题，而分布式锁要处理本地锁永远不需要考虑的三个问题：**节点宕机**、**网络分区**、**时钟漂移**。

---

## 为什么本地锁不够

### 单机锁的失效场景

```
场景：库存扣减，要求不能超卖

单机方案：synchronized / ReentrantLock

问题：
  Pod A (10.0.0.1): synchronized 拿到锁，读库存=10，准备扣减
  Pod B (10.0.0.2): synchronized 拿到自己进程内的锁，也读库存=10
  
  结果：两个 Pod 各自认为自己拿到了锁，同时执行扣减 → 超卖
```

每个进程都有自己的内存空间，`synchronized` 只在单个 JVM 内生效。多副本部署后，每个 Pod 的锁互不感知。

### 分布式锁的核心需求

1. **互斥性**：同一时刻只有一个客户端持有锁
2. **无死锁**：持锁客户端宕机后，锁最终能被释放（超时自动释放）
3. **容错性**：锁服务部分故障时，锁仍然有效
4. **可重入**（可选）：同一客户端可以重复加锁

---

## Redis 分布式锁

### 基础实现：SETNX + EXPIRE

```bash
# 原子设置 key，带过期时间（防止宕机死锁）
SET lock_key unique_value NX PX 30000
# NX: 仅在 key 不存在时设置
# PX 30000: 过期时间 30 秒

# 释放锁（Lua 脚本保证原子性）
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
```

**关键点**：
- `unique_value` 用 UUID 区分持锁客户端，释放时验证，防止误删其他客户端的锁
- 释放锁用 Lua 脚本：`GET + DEL` 两步操作必须是原子的，否则可能删掉别人的锁

### 主要陷阱

**陷阱 1：业务超时导致锁提前释放**

```
Client A 拿到锁，过期时间 30s
Client A 业务逻辑执行了 35s（GC 暂停、网络慢等）
30s 时锁自动过期，Client B 拿到锁
Client A 35s 时业务结束，执行 Lua 删锁 → 删掉了 Client B 的锁！
```

解法：**看门狗机制（Watchdog）**——持锁期间定期续约（Redisson 实现：每 10s 续约一次，默认过期时间 30s）。

**陷阱 2：Redis 主从切换导致锁丢失**

```
Client A 在 Redis Master 写入锁
Master 宕机，还未同步到 Slave
Slave 升为新 Master（没有锁数据）
Client B 在新 Master 成功拿到锁
→ Client A 和 Client B 同时持有锁！
```

### Redlock 算法

Martin Kleppmann 分析了上述主从切换问题后，Redis 作者 Antirez 提出了 Redlock——用多个独立的 Redis 节点（通常 5 个）实现容错：

```
加锁流程：
1. 记录开始时间 t1
2. 依次向 5 个 Redis 节点发送 SET NX PX 命令
3. 记录结束时间 t2，elapsed = t2 - t1
4. 如果在超过 3 个（多数）节点成功加锁，且 elapsed < 锁有效期
   → 加锁成功，实际有效时间 = 锁有效期 - elapsed
5. 否则向所有节点发送释放锁命令，加锁失败
```

**Redlock 的争议**（Martin Kleppmann vs Antirez 的公开争论）：

:::提醒
Redlock 依赖各节点时钟大致同步（允许几毫秒误差）。如果某个节点时钟跳跃（NTP 调整、VM 时间漂移），可能导致锁提前过期，无法保证互斥性。Martin Kleppmann 认为 Redlock 不安全，Antirez 认为时钟跳跃是极端情况。生产选型时需要明确你的容忍边界。
:::

**Redlock 适用场景**：高可用要求但可以容忍极端情况下（时钟大幅跳跃）偶发互斥失效的场景。不适合对锁正确性要求绝对严格的场景（如金融对账）。

---

## ZooKeeper 分布式锁

ZooKeeper 用**临时顺序节点（Ephemeral Sequential Node）**实现分布式锁，天然解决了客户端宕机死锁问题。

### 实现原理

```
加锁流程：
1. 在 /locks/resource 下创建临时顺序节点，如 /locks/resource/lock-000000042
2. 获取 /locks/resource 下所有子节点，按序号排序
3. 如果自己的节点是序号最小的 → 加锁成功
4. 否则 Watch 比自己序号小 1 的节点（而非 Watch 最小节点，避免羊群效应）
5. 等待 Watch 触发（该节点被删除），回到步骤 2

释放锁：
删除自己创建的临时节点
→ Watch 的下一个节点收到通知，尝试获取锁
```

**为什么用临时节点**：ZooKeeper 客户端与服务器维护 Session，客户端宕机后 Session 超时（默认 30-90s），ZooKeeper 自动删除该 Session 创建的所有临时节点，锁自动释放。

**Watch 为什么只监听前一个节点**：如果所有等待者都 Watch 最小节点，最小节点释放时会同时通知 N-1 个等待者，造成**惊群效应（Thundering Herd）**。监听前一个节点后，每次锁释放只唤醒一个等待者。

### ZooKeeper 锁的特点

| 优点 | 缺点 |
|------|------|
| 锁天然有超时（Session 超时自动删除） | ZooKeeper 本身是 CP 系统，节点故障时可能不可用 |
| 公平性（按创建顺序排队，不饥饿） | ZooKeeper 写性能低（所有写通过 Leader + 多数节点确认） |
| 羊群效应已解决（Watch 前一个节点） | 维护 Session 有开销，ZooKeeper 节点数有限制 |

---

## etcd 分布式锁

etcd 基于 Raft 协议，提供强一致的键值存储。etcd 的分布式锁用 **Lease（租约）+ Watch** 实现。

### 实现原理

```bash
# 1. 创建 Lease，TTL = 30 秒
etcdctl lease grant 30
# → lease 694d5ed7dab7ba01 granted with TTL(30s)

# 2. 用 etcdctl txn 原子 CAS：如果 key 不存在则写入，绑定 Lease
etcdctl txn <<EOF
  mod("lock_key") = "0"
  put lock_key client_a --lease=694d5ed7dab7ba01
  get lock_key
EOF

# 3. 持锁期间定期续约，防止 Lease 到期
etcdctl lease keep-alive 694d5ed7dab7ba01

# 4. 释放锁：撤销 Lease（自动删除绑定的 key）
etcdctl lease revoke 694d5ed7dab7ba01
```

**等待锁**：用 etcd Watch 监听 `lock_key`，key 被删除时尝试 CAS 加锁。

### etcd 锁 vs ZooKeeper 锁

| 维度 | etcd | ZooKeeper |
|------|------|-----------|
| **协议** | Raft | ZAB（类 Multi-Paxos） |
| **API** | gRPC / RESTful | 专有协议 |
| **续约** | 显式 KeepAlive | Session 心跳 |
| **公平性** | 需自行实现队列 | 临时顺序节点天然公平 |
| **性能** | 更高（etcd v3） | 较低 |
| **生态** | Kubernetes 标配 | 传统 Java 微服务（Dubbo） |

---

## 三种实现的对比与选型

| 维度 | Redis | ZooKeeper | etcd |
|------|-------|-----------|------|
| **性能** | 最高（单机十万级 QPS） | 低（万级） | 中（十万级） |
| **一致性** | AP（主从）/ 取决于部署 | CP | CP |
| **公平锁** | 需手动实现 | 天然支持 | 需手动实现 |
| **宕机恢复** | Watchdog 续约 / Redlock | Session 超时自动释放 | Lease 超时自动释放 |
| **运维难度** | 低 | 高（需要奇数节点集群） | 中 |
| **适用场景** | 高并发、容忍极端情况偶发互斥失效 | 需要公平锁、强一致 | Kubernetes 生态、强一致 |

:::方法
**选型决策树**：
1. 已有 Redis 基础设施 + 高并发 + 偶发失效可接受 → Redis + Redisson（Watchdog）
2. 需要公平锁（排队等待，不饥饿） → ZooKeeper
3. 在 Kubernetes 环境 + 需要强一致 → etcd
4. 对锁正确性要求极严（金融级）→ etcd 或 ZooKeeper + 幂等补偿机制
:::

---

## 分布式锁的通用陷阱

### 陷阱 1：锁有效期设置

- 太短：业务未完成锁就到期，互斥失效
- 太长：持锁方宕机后，其他节点等待时间过长
- 解法：Watchdog 动态续约 + 业务幂等 + 超时告警

### 陷阱 2：锁粒度过大

将整个业务用一把大锁串行化，吞吐极低。

解法：缩小锁的粒度（按资源 ID 而非全局锁，如 `lock:order:{order_id}` 而非 `lock:order`）。

### 陷阱 3：未考虑网络分区

持锁客户端与锁服务网络断开，锁服务认为租约到期释放了锁，但客户端还在执行业务。

解法：**Fencing Token**——每次加锁时锁服务返回单调递增的 token，业务操作时携带 token，存储系统拒绝使用过期 token 的写入。这是彻底解决分布式锁问题的终极方案。

```
Client A 加锁，得到 token=100
Client A 与锁服务网络断开，锁服务认为 A 超时，释放锁
Client B 加锁，得到 token=101
Client A 网络恢复，用 token=100 写存储
存储系统：我上次接受的最大 token=101，拒绝 100 的写入
→ Client A 的操作被安全拒绝
```

---

## 小结

分布式锁的本质是用一个**外部协调服务**（Redis / ZooKeeper / etcd）来实现多节点间的互斥。三种方案各有取舍，没有银弹。真正生产安全的分布式锁需要配合**幂等操作 + Fencing Token**，因为即便锁实现本身正确，网络分区下也无法做到绝对的互斥。

| 方案 | 适用 | 不适用 |
|------|------|--------|
| Redis + Watchdog | 高并发场景，可接受极端概率失效 | 金融核心账务 |
| ZooKeeper | 需要公平排队，强一致 | 超高并发（性能瓶颈） |
| etcd | K8s 生态，强一致 | 超高并发（性能瓶颈） |
| Fencing Token | 所有场景的终极保险 | 存储系统不支持 token 验证时 |
