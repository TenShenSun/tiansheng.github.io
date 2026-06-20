# 分布式通讯：RPC、服务发现与消息队列

服务间通讯是分布式系统的血管。当系统从单体拆分为多个服务后，服务间的通讯模式直接决定系统的可靠性、性能和可维护性。本文覆盖三大核心主题：**RPC**（同步调用）、**服务发现**（找到谁）、**消息队列**（异步解耦）。

---

## RPC 的演进

RPC（Remote Procedure Call）的目标是让远程调用看起来像本地调用，屏蔽网络细节。

### 为什么 RPC 不能真正屏蔽网络

本地调用失败只有一种情况（返回错误）。网络调用失败有三种：

1. 请求没发出去（发送失败）
2. 请求发出去了，但没收到响应（超时：可能成功了，可能没成功）
3. 响应没收到（消费者侧超时）

**情况 2 是关键**：你不知道对方有没有执行，重试可能导致重复执行。这就是为什么分布式系统要强调**幂等性**——相同请求执行多次结果相同。

### REST / HTTP

最简单、最通用的 RPC 方式。协议标准（HTTP/JSON）确保跨语言兼容，但：

- **性能开销**：JSON 序列化/反序列化 CPU 成本高，HTTP 头部冗余
- **类型安全**：没有 Schema 约束，字段变更不会在编译期发现
- **流式支持**：HTTP/1.1 不支持双向流，HTTP/2 改善了这点

适用场景：对外 API、跨组织通讯、简单内部服务。

### gRPC

Google 开源的高性能 RPC 框架，基于 HTTP/2 + Protocol Buffers。

```protobuf
// 定义服务接口（IDL）
service UserService {
  rpc GetUser(UserRequest) returns (UserResponse);
  rpc StreamUsers(UserRequest) returns (stream UserResponse); // 服务端流
  rpc Chat(stream ChatMessage) returns (stream ChatMessage); // 双向流
}

message UserRequest {
  int64 user_id = 1;
}
```

| 特性 | gRPC 优势 |
|------|----------|
| **性能** | Protobuf 序列化比 JSON 快 3-10x，体积小 3-5x |
| **类型安全** | IDL 定义接口，代码生成，编译期检查 |
| **流式支持** | 原生支持单向流、双向流 |
| **多路复用** | HTTP/2 单连接多请求，减少连接开销 |
| **代码生成** | 自动生成客户端/服务端 stub，支持 10+ 语言 |

劣势：浏览器直接调用困难（需要 gRPC-Web 中间层），调试比 REST 复杂（需要专用工具）。

### Protocol Buffers（Protobuf）

gRPC 的序列化格式，也可独立使用。核心设计：

- **字段编号**（field number）是协议的标识，而非字段名。字段名可以改，编号不能改
- **向后兼容**：新增字段旧代码忽略，旧字段缺失新代码用默认值
- **二进制编码**：varint 编码小整数，ZigZag 编码负数

:::提醒
Protobuf 字段一旦删除，该编号不能复用于新字段（否则旧客户端会误解析）。删除字段时要用 `reserved` 标记该编号。这是 Protobuf 版本管理最常见的陷阱。
:::

---

## 服务发现

微服务架构里，服务实例的 IP 和端口是动态变化的（扩容/缩容/宕机重启）。服务发现解决「客户端如何找到服务提供者」的问题。

### 三种模式

**客户端发现（Client-side Discovery）**：

客户端从注册中心查询服务实例列表，自己做负载均衡。

```
客户端 → 注册中心（查询 service-A 的实例列表）
       ← [10.0.0.1:8080, 10.0.0.2:8080, 10.0.0.3:8080]
客户端自行选择（轮询/随机/最少连接） → 10.0.0.2:8080
```

优点：客户端可以实现复杂的路由逻辑（灰度发布、就近路由）。缺点：客户端需要集成服务发现 SDK，语言耦合。典型：Netflix Eureka + Ribbon。

**服务端发现（Server-side Discovery）**：

请求先到负载均衡器（LB），LB 查询注册中心并转发。

```
客户端 → 负载均衡器（LB/API Gateway）→ 服务实例
               ↕
            注册中心
```

优点：客户端无需感知服务发现，语言无关。缺点：多了一跳，LB 可能成为瓶颈/单点。典型：AWS ELB + Consul、Kubernetes Service + kube-proxy。

**DNS-based Discovery**：

用 DNS SRV 记录存储服务地址，TTL 控制缓存刷新时间。最简单，但 DNS 缓存不及时、没有健康检查。适合简单场景或云原生环境（Kubernetes headless service）。

### 主流注册中心对比

| 工具 | 一致性 | 健康检查 | 适用场景 |
|------|--------|---------|---------|
| **ZooKeeper** | CP（强一致） | 心跳 + 临时节点 | 传统 Java 微服务（Dubbo） |
| **Consul** | CP（Raft） | HTTP/TCP/脚本 | 多数据中心、Service Mesh |
| **etcd** | CP（Raft） | 租约（Lease） | Kubernetes 组件协调 |
| **Eureka** | AP（最终一致） | 心跳 | Netflix、Spring Cloud |
| **Nacos** | 支持 CP/AP 切换 | 心跳 + 主动探测 | 阿里系、国内主流 |

:::方法
选择注册中心的核心判断：
- 注重一致性（Leader 选举、配置管理）→ etcd 或 Consul
- 注重可用性（即使注册中心部分不可用也能继续服务）→ Eureka 或 Nacos
- 国内 Java 微服务生态 → Nacos（同时包含配置中心功能）
:::

---

## 消息队列

消息队列（MQ）解决服务间**异步解耦**的问题：生产者和消费者不需要同时在线，不需要知道对方的地址。

### 核心设计问题

**消息投递语义**：

| 语义 | 含义 | 实现代价 |
|------|------|---------|
| **At-most-once** | 最多投递一次，可能丢消息 | 最低，适合日志等不重要数据 |
| **At-least-once** | 至少投递一次，可能重复 | 中等，消费者需要幂等 |
| **Exactly-once** | 恰好一次，不丢不重 | 最高，通常靠幂等 + 事务实现 |

生产系统通常选择 **At-least-once + 消费者幂等**，因为 Exactly-once 的实现成本极高。

**消息顺序**：全局顺序（严格顺序但吞吐低）vs 分区顺序（同一 key 的消息有序，不同 key 可并行）。

### Kafka

Apache Kafka 是当前最主流的分布式消息队列，设计上更接近**持久化事件日志**。

**核心架构**：

```
Producer → [Topic: orders]
              ├── Partition 0: [msg1, msg2, msg5, ...]  → Consumer Group A
              ├── Partition 1: [msg3, msg6, ...]        → Consumer Group A
              └── Partition 2: [msg4, msg7, ...]        → Consumer Group A
                                                        → Consumer Group B（独立消费进度）
```

**关键设计**：

- **Partition（分区）**：消息并行单元，同一 Partition 内有序
- **Consumer Group**：同一组内每个 Partition 只被一个 Consumer 消费，不同 Group 独立消费同一 Topic
- **Offset**：Consumer 的消费位置，可以 Seek 到任意位置重放
- **Retention**：消息持久化保留（默认 7 天），而非消费后删除

**Kafka 的工程优势**：

- 极高吞吐：顺序写磁盘 + sendfile 零拷贝，单机百万 msg/s
- 消息可重放：新的消费者可以从头消费历史消息
- 解耦生产/消费速率：Consumer 慢不影响 Producer

**Kafka 的局限**：

- 单个 Partition 是顺序处理，无法在保证顺序的同时并行扩展
- 消费者数量受 Partition 数量限制（Consumer > Partition 时有 Consumer 空闲）
- 延迟比 RabbitMQ 高（批量写入设计）

### Pulsar

Apache Pulsar 是对 Kafka 的架构升级，计算与存储分离：

```
Broker（无状态计算层） + BookKeeper（持久化存储层）
```

优势：Broker 可独立扩展（无需数据迁移），Subscription 比 Consumer Group 更灵活，原生支持多租户。缺点：部署更复杂（需要维护 BookKeeper 集群）。

### RabbitMQ vs Kafka 选型

| 维度 | RabbitMQ | Kafka |
|------|---------|-------|
| **消息模型** | 队列（消费后删除） | 日志（持久保留） |
| **路由** | 丰富（Exchange/Binding） | 简单（Topic/Partition） |
| **吞吐** | 万级 msg/s | 百万级 msg/s |
| **延迟** | 微秒级 | 毫秒级 |
| **消息重放** | 不支持 | 支持 |
| **适用场景** | 任务队列、延迟消息、复杂路由 | 事件流、日志采集、数据管道 |

---

## 背压（Backpressure）

当消费者处理速度跟不上生产者发送速度时，消息会积压。背压是一种流量控制机制，让生产者感知到消费者的压力并降速。

### 实现方式

**有界缓冲区**：消费者侧维护固定大小的缓冲区，满了之后生产者阻塞或报错。简单但粗暴。

**信用机制（Credit-based）**：消费者给生产者「信用点」，生产者每发一条消息消耗一个信用点，信用耗尽停止发送，消费者处理完毕返还信用。Reactive Streams 规范采用此方式。

**Kafka 的背压**：Consumer 主动拉取（Pull 模式），天然实现背压——Consumer 不拉，Producer 不感知，消息只是积压在 Kafka 上，Consumer 处理完一批再拉下一批。

:::启发
Push 模式（Broker 推给 Consumer）实现背压复杂；Pull 模式（Consumer 主动拉）天然背压但延迟略高。Kafka 选择 Pull 是一个正确的工程权衡——在高吞吐场景下，Consumer 的拉取频率远快于感知延迟的阈值。
:::

---

## 小结

| 技术 | 解决的问题 | 核心选型标准 |
|------|-----------|------------|
| gRPC | 高性能同步服务调用 | 性能敏感的内部服务 |
| REST | 简单通用接口 | 对外 API、跨组织 |
| 服务发现 | 动态查找服务实例 | CP 注册中心（etcd/Consul）vs AP（Eureka/Nacos） |
| Kafka | 高吞吐事件流 | 日志、数据管道、需要重放 |
| RabbitMQ | 复杂路由任务队列 | 延迟消息、复杂分发规则 |
| 背压 | 生产消费速率匹配 | Pull 模式 vs 有界缓冲区 |
