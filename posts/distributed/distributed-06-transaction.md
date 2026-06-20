# 分布式事务：2PC、Saga 与 TCC 的工程选型

跨服务的事务是分布式系统里最难的工程问题之一。单库事务由数据库引擎保证 ACID，而当一笔业务涉及多个微服务（订单服务、库存服务、支付服务），每个服务有自己的数据库时，没有任何数据库引擎能直接保证跨库的原子性。

---

## 问题的本质

### 为什么本地事务不够

```
转账场景（跨行）：
  账户A（在A银行DB）减 100 元
  账户B（在B银行DB）加 100 元

本地事务：
  A银行 BEGIN → 扣款 → COMMIT ✅
  B银行 BEGIN → 存款 → COMMIT ✅

问题：A 扣款成功后，网络断了，B 的存款操作无法执行 → 钱消失了
```

分布式事务需要保证：多个参与方的操作**要么全部成功，要么全部回滚**。

### 分布式事务的 CAP 困境

分布式事务要求的全局原子性（ACID）本质上需要全局协调，而全局协调在网络分区时无法完成。这是分布式事务难的根源——**在分布式环境里，强 ACID 的代价是可用性和延迟**。

---

## XA 协议与 2PC

**XA 协议**是 X/Open 组织制定的分布式事务标准，定义了事务管理器（TM）和资源管理器（RM，如数据库）之间的接口。**2PC（Two-Phase Commit）**是 XA 的核心实现。

### 两阶段提交流程

**Phase 1：Prepare（投票）**

```
事务协调者（TM）：
  → 发送 Prepare 给所有参与者（RM）
  
参与者（RM A、B、C）：
  → 执行本地事务操作
  → 写 Undo Log（用于回滚）
  → 持久化 Prepare 状态
  → 回复 Yes（可以提交）或 No（需要回滚）
```

**Phase 2：Commit/Rollback（执行）**

```
如果所有参与者都回复 Yes：
  TM → 发送 Commit 给所有参与者
  参与者 → 提交本地事务，释放资源
  
如果任意参与者回复 No：
  TM → 发送 Rollback 给所有参与者
  参与者 → 用 Undo Log 回滚，释放资源
```

### 2PC 的三大问题

**问题 1：协调者单点故障（SPOF）**

协调者在 Phase 2 发送 Commit 期间宕机，部分参与者已 Commit、部分未收到 Commit 消息，导致不一致。参与者在 Prepared 状态无限等待，资源被锁定。

**问题 2：同步阻塞（性能瓶颈）**

从 Phase 1 开始到 Phase 2 完成，所有参与者持有锁并等待。这段时间可能是数百毫秒（包含多次网络往返），期间所有相关数据都被锁住，并发度极低。

**问题 3：数据不一致（脑裂）**

协调者在 Phase 2 只给部分参与者发送了 Commit 就宕机，网络分区导致其他参与者收不到 Commit，形成永久不一致。

:::提醒
XA/2PC 在互联网高并发场景里几乎被放弃。它的适用场景是：操作数量少（≤10个参与方）、对强一致有硬要求（金融核心账务）、可以接受高延迟低并发。Google Spanner 内部用更复杂的变体解决了协调者单点问题，但代价是更高的复杂度。
:::

### 3PC：2PC 的改进

3PC 在 Prepare 和 Commit 之间增加了 `Pre-Commit` 阶段，并引入参与者超时机制（超时后 Pre-Commit 的参与者可以自行提交）。但 3PC 在网络分区下仍可能不一致，且三阶段增加了延迟，工程上很少使用。

---

## TCC（Try-Confirm-Cancel）

TCC 是业务层的分布式事务方案，将每个服务操作分解为三个阶段：

```
Try：     预留资源（冻结库存、冻结余额）
Confirm： 确认使用预留资源（扣减冻结的库存/余额）
Cancel：  释放预留资源（解冻库存/余额）
```

### 订单支付的 TCC 示例

```
OrderService.Try():
  - 创建订单，状态 = PENDING
  
InventoryService.Try():
  - 冻结库存（available - 10，frozen + 10）
  
PaymentService.Try():
  - 冻结余额（balance - 100，frozen_balance + 100）

--- 全部 Try 成功 → 执行 Confirm ---

OrderService.Confirm():
  - 更新订单状态 = CONFIRMED
  
InventoryService.Confirm():
  - 正式扣减库存（frozen - 10，sold + 10）
  
PaymentService.Confirm():
  - 正式扣款（frozen_balance - 100，deducted + 100）

--- 任意 Try 失败 → 执行 Cancel ---

InventoryService.Cancel():
  - 解冻库存（frozen - 10，available + 10）
```

### TCC 的工程难点

**难点 1：Try 和 Cancel 都需要幂等**

Try 和 Confirm/Cancel 都可能因网络超时被重试，必须保证重复执行结果相同。

**难点 2：空回滚问题**

Try 没有到达（网络超时），但 Cancel 先到了。需要判断 Try 是否已执行：
- 业务方需要维护事务状态表，Check Cancel 时查询状态，Try 未执行则什么都不做

**难点 3：悬挂问题（Suspend）**

Cancel 先执行完，Try 后来才到。此时 Try 会成功预留资源，但 Cancel 已经完成，资源永久被占用。
解法：在 Cancel 时记录事务 ID，Try 执行前检查是否已有 Cancel 记录，有则拒绝执行。

**难点 4：侵入业务代码**

每个服务都要实现 Try/Confirm/Cancel 三套接口，对业务代码侵入很大，改造成本高。

:::观点
TCC 的本质是把数据库的「锁」变成业务层的「预留」，把事务协调的失败从「数据不一致」变成「资源悬挂」（更容易被对账发现和补偿）。代价是业务代码复杂度大幅增加。
:::

---

## Saga 模式

Saga（1987 年论文）将长事务拆分为一系列**本地事务**，每个本地事务成功后触发下一个，失败时执行**补偿操作**（而非回滚）。

### 核心思想：补偿而非回滚

```
正向操作链：
  T1 → T2 → T3 → T4

如果 T3 失败：
  执行补偿：C2 → C1（逆序补偿 T2、T1）

注意：T3 失败后不会"撤销" T3（T3 可能已部分执行），
     而是执行 T3 的补偿操作 C3，再逐步补偿前面的操作
```

**Saga vs 2PC 的根本区别**：

| 维度 | 2PC | Saga |
|------|-----|------|
| **一致性** | 强一致（ACID） | 最终一致（BASE） |
| **隔离性** | 有（锁） | 无（中间状态可见） |
| **失败处理** | 回滚（原子） | 补偿（逆操作） |
| **适用** | 短事务、资源少 | 长事务、跨服务多 |

### 两种 Saga 实现模式

**编排模式（Orchestration）**：有一个中心化的 Saga 协调器，负责决定步骤顺序和失败处理。

```
Saga Orchestrator（中心协调器）
  → 调用 OrderService.Create()
  → 调用 InventoryService.Reserve()
  → 调用 PaymentService.Charge()
  ← 如果 Payment 失败：
  ← 调用 InventoryService.Release()
  ← 调用 OrderService.Cancel()
```

优点：逻辑集中，易于追踪和监控。缺点：协调器是单点，可能成为上帝类。

**协作模式（Choreography）**：各服务通过事件互相触发，无中心协调器。

```
OrderService:   创建订单 → 发布 OrderCreated 事件
InventoryService: 监听 OrderCreated → 预留库存 → 发布 InventoryReserved 事件
PaymentService:   监听 InventoryReserved → 扣款 → 发布 PaymentCompleted 事件
OrderService:   监听 PaymentCompleted → 确认订单

失败时：
PaymentService: 扣款失败 → 发布 PaymentFailed 事件
InventoryService: 监听 PaymentFailed → 释放库存 → 发布 InventoryReleased 事件
OrderService:   监听 InventoryReleased → 取消订单
```

优点：松耦合，无单点。缺点：事件链复杂，难以追踪整个事务的状态，难以 debug。

### Saga 的隔离性问题

Saga 没有隔离性——T1 提交后，中间状态对外可见，其他事务可能读到不一致数据。

解法：**语义锁（Semantic Lock）**——用业务状态字段模拟隔离（如订单状态 = PENDING 时其他操作不能读取）。或者接受中间状态可见，设计容忍临时不一致的 UI 和业务逻辑。

---

## 本地消息表 + 事务消息

这是互联网最常用的分布式事务方案，用**最终一致性**绕开强一致的代价。

### 本地消息表

```sql
-- 在业务 DB 里维护一张消息表
CREATE TABLE outbox_messages (
    id          BIGINT PRIMARY KEY,
    event_type  VARCHAR(64),   -- 如 "ORDER_CREATED"
    payload     JSON,
    status      ENUM('PENDING', 'SENT'),
    created_at  DATETIME
);

-- 业务操作 + 写消息在同一个本地事务里
BEGIN;
  INSERT INTO orders (id, ...) VALUES (...);
  INSERT INTO outbox_messages (event_type, payload, status) 
    VALUES ('ORDER_CREATED', '{"order_id": 123}', 'PENDING');
COMMIT;  -- 要么都成功，要么都失败
```

后台定时任务扫描 `status=PENDING` 的消息，发送到 MQ，发送成功后更新 `status=SENT`。消费者处理完后幂等确认。

### Kafka 事务消息

Kafka 原生支持事务，可以保证生产者的消息要么全部写入（跨多个 Partition），要么全部不写入：

```java
producer.initTransactions();
try {
    producer.beginTransaction();
    producer.send(new ProducerRecord<>("orders", orderId, orderJson));
    producer.send(new ProducerRecord<>("inventory", itemId, inventoryJson));
    producer.commitTransaction();
} catch (Exception e) {
    producer.abortTransaction();
}
```

### RocketMQ 事务消息

RocketMQ 提供更完整的事务消息方案（专为分布式事务设计）：

```
1. 生产者发送"半消息"（Half Message，对消费者不可见）
2. 生产者执行本地事务
3. 本地事务成功 → 提交消息（消费者可见）
   本地事务失败 → 删除消息
   超时未响应 → RocketMQ 回查（主动询问生产者事务状态）
```

---

## 选型决策

| 方案 | 适用场景 | 不适用场景 |
|------|---------|-----------|
| **XA/2PC** | 操作少、强一致、低并发（银行核心账务） | 互联网高并发、跨多服务 |
| **TCC** | 需要强隔离、可接受业务代码改造（资金操作） | 服务多、改造成本高 |
| **Saga** | 长流程业务（订单→库存→物流→支付） | 需要强隔离性 |
| **本地消息表** | 大多数互联网业务，接受最终一致 | 需要强一致的场景 |
| **RocketMQ 事务消息** | 同上，且已使用 RocketMQ | 非 RocketMQ 生态 |

:::方法
**实践优先级**：
1. 优先考虑是否真的需要分布式事务——很多场景可以通过业务设计规避（如先扣款后发货，失败时退款）
2. 能用最终一致的，用本地消息表或事务消息
3. 需要强隔离的（资金冻结），用 TCC
4. 强一致且低并发，才考虑 XA/2PC
:::

---

## 小结

分布式事务的核心取舍是：**一致性强度 vs 系统可用性和性能**。

```
强一致性 ←──────────────────────────────→ 高可用/高性能
  XA/2PC      TCC          Saga      本地消息表
  (强ACID)  (资源预留)  (最终一致)  (异步最终一致)
```

没有一个方案适合所有场景。先评估业务对一致性的真实要求，再选择代价最小的方案。
