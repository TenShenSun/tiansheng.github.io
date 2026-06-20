# 混沌工程与故障注入：从 Chaos Monkey 到 Chaos Mesh

「在生产出问题之前，主动让它出问题。」这是混沌工程的核心思想。传统做法是写测试、做 Code Review、上线前 QA，但这些都无法发现「分布式系统在复杂故障组合下的真实行为」。Netflix 2011 年在生产环境随机杀掉实例，不是因为鲁莽，而是因为他们知道：迟早会出故障，与其被动等待，不如主动暴露。

---

## 混沌工程的起源

### Netflix 的生产背景

Netflix 2008 年从自建数据中心迁移到 AWS。迁移后发现：云环境的实例随时会被终止（AWS 的 Spot Instance、硬件故障、AZ 维护），不可能预测故障的时间和位置。

**Chaos Monkey（2011）**：在工作时间（工程师在线时）随机终止 EC2 实例，强迫各团队把系统设计成能容忍实例随机消失。

**Simian Army（2011-2015）**：一批混沌工具集合：
- Chaos Monkey：随机终止实例
- Chaos Gorilla：模拟整个 AZ 宕机
- Chaos Kong：模拟整个 AWS Region 故障
- Latency Monkey：注入网络延迟
- Conformity Monkey：检测不符合最佳实践的实例并终止

**核心洞察**：如果你的系统不能在工程师在线（白天工作时间）的时候承受随机实例宕机，那等到凌晨 3 点真正故障时，后果会更严重。

---

## 混沌工程原则（Principles of Chaos Engineering）

Netflix 在 2016 年正式整理了混沌工程的四大原则：

### 1. 建立稳态假说（Define Steady State）

首先定义「系统正常运行」的量化标准——SLI/SLO：

```yaml
稳态指标：
  - 视频播放成功率 > 99.9%（核心 SLI）
  - API P99 延迟 < 500ms
  - 错误率 < 0.1%

稳态假说：
  "在引入故障后，上述指标仍然维持在阈值范围内"
```

没有稳态假说，就无法判断「实验成功还是失败」。

### 2. 多样化真实世界事件（Vary Real-World Events）

故障类型应该来自真实发生过的事件（历史故障、已知风险），而非随机：

```
历史故障 → 故障库
  - 2023-03 某机房网络闪断（15分钟延迟）→ 网络延迟注入实验
  - 2023-06 Redis 主从切换失败 → Redis 实例终止实验
  - 2023-09 数据库连接池耗尽 → 连接数限制实验
```

### 3. 在生产环境运行实验（Run Experiments in Production）

测试环境的流量、数据量、系统状态与生产环境不同，只有在生产环境才能发现真实问题。但这不意味着粗暴操作——需要严格控制实验爆炸半径（Blast Radius）。

### 4. 自动化实验持续运行（Automate Experiments to Run Continuously）

手动运行的混沌实验很快会被遗忘。应该将实验纳入 CI/CD 流水线或定期自动运行：

```yaml
# 每周一 10:00（工作时间）自动运行
schedule: "0 10 * * 1"
experiment: pod-kill
target:
  service: order-service
  percentage: 20%  # 随机杀掉 20% 的 Pod
assert:
  sli: success_rate > 99.9%
  duration: 10m
```

---

## 故障注入类型

### 四大故障类别

**1. 网络故障**

```bash
# 使用 tc（Traffic Control）注入网络延迟
tc qdisc add dev eth0 root netem delay 100ms 20ms  # 100±20ms 延迟

# 注入丢包
tc qdisc add dev eth0 root netem loss 10%  # 10% 丢包率

# 注入网络分区（用 iptables 阻断特定服务间通讯）
iptables -A INPUT -s 10.0.0.2 -j DROP
```

**2. 节点故障**

```bash
# 终止进程（模拟应用崩溃）
kill -9 $(pgrep order-service)

# 终止容器（模拟 Pod 崩溃）
kubectl delete pod order-service-abc123 --force

# 模拟节点宕机
echo b > /proc/sysrq-trigger  # 内核 panic（危险，只在实验环境使用）
```

**3. 资源耗尽**

```bash
# 内存压力（消耗 80% 内存）
stress-ng --vm 1 --vm-bytes 80%

# CPU 压力
stress-ng --cpu 4 --timeout 60s

# 磁盘 I/O 压力（模拟磁盘慢）
stress-ng --io 4 --timeout 60s

# 文件描述符耗尽
ulimit -n 10  # 限制 fd 数量
```

**4. 应用层故障**

```python
# 在代码层注入故障（Feature Flag 控制）
if chaos_enabled("slow_db_query"):
    time.sleep(random.uniform(0.5, 2.0))  # 注入随机延迟

if chaos_enabled("fail_payment"):
    raise PaymentServiceException("Chaos injection: payment failure")
```

---

## Chaos Mesh

Chaos Mesh 是 PingCAP（TiDB）开源的云原生混沌工程平台，专为 Kubernetes 设计。

### 架构

```
┌───────────────────────────────────────────────────────┐
│                  Chaos Dashboard（Web UI）              │
└───────────────────────────┬───────────────────────────┘
                            ↓
┌───────────────────────────────────────────────────────┐
│              Chaos Controller Manager                  │
│         监听 ChaosExperiment CRD，调度实验              │
└──────────┬──────────────────────────┬─────────────────┘
           ↓                          ↓
┌──────────────────┐       ┌───────────────────────────┐
│  Chaos Daemon    │       │    Sidecar Injector        │
│（DaemonSet，每节点）│      │（注入 sidecar 到目标 Pod）  │
│  执行网络/系统故障  │       └───────────────────────────┘
└──────────────────┘
```

### 实验类型

```yaml
# PodChaos：随机杀 Pod
apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: kill-order-service-pods
spec:
  action: pod-kill
  mode: random-max-percent
  value: "30"  # 随机杀掉 30% 的 Pod
  selector:
    namespaces: [production]
    labelSelectors:
      app: order-service
  scheduler:
    cron: "0 10 * * 1"  # 每周一上午 10 点
```

```yaml
# NetworkChaos：网络延迟
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: delay-order-to-inventory
spec:
  action: delay
  mode: all
  selector:
    labelSelectors:
      app: order-service
  delay:
    latency: "200ms"
    correlation: "25"
    jitter: "50ms"
  direction: to
  target:
    selector:
      labelSelectors:
        app: inventory-service
  duration: "10m"
```

```yaml
# StressChaos：CPU/内存压力
apiVersion: chaos-mesh.org/v1alpha1
kind: StressChaos
spec:
  mode: one
  selector:
    labelSelectors:
      app: payment-service
  stressors:
    memory:
      workers: 1
      size: "512MB"
    cpu:
      workers: 2
      load: 80  # 80% CPU 负载
  duration: "5m"
```

### Chaos Workflow：组合实验

```yaml
# 模拟级联故障：先网络延迟，再杀 Pod，观察系统如何恢复
apiVersion: chaos-mesh.org/v1alpha1
kind: Workflow
spec:
  entry: entry
  templates:
    - name: entry
      type: Serial
      children:
        - network-delay-phase
        - wait-5min
        - pod-kill-phase
        - observe-recovery
```

---

## LitmusChaos

LitmusChaos 是 CNCF 孵化的另一个混沌工程框架，强调**实验即代码**（Chaos as Code），实验结果可通过 ChaosResult CR 查询：

```yaml
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
spec:
  appinfo:
    appns: production
    applabel: app=order-service
  chaosServiceAccount: chaos-sa
  experiments:
    - name: pod-delete
      spec:
        components:
          env:
            - name: TOTAL_CHAOS_DURATION
              value: "60"
            - name: CHAOS_INTERVAL
              value: "10"
            - name: FORCE
              value: "false"
```

---

## AWS Fault Injection Service（FIS）

AWS 托管的混沌工程服务，无需自行部署工具，直接集成 AWS 服务：

- 停止/终止 EC2 实例
- 注入 RDS 故障（主备切换）
- 模拟 ECS Task 终止
- 注入 EKS Pod 故障
- 模拟 API 错误（让特定 AWS API 返回错误）

```json
{
  "description": "Simulate AZ failure",
  "targets": {
    "instances": {
      "resourceType": "aws:ec2:instance",
      "filters": [{"path": "Placement.AvailabilityZone", "values": ["us-east-1a"]}],
      "selectionMode": "ALL"
    }
  },
  "actions": {
    "stop-instances": {
      "actionId": "aws:ec2:stop-instances",
      "targets": {"Instances": "instances"}
    }
  },
  "stopConditions": [
    {"source": "aws:cloudwatch:alarm", "value": "arn:aws:cloudwatch:..."}
  ]
}
```

`stopConditions`（熔断条件）：当 CloudWatch 告警触发时自动停止实验，防止实验失控。

---

## 实施路径：从沙盒到生产

### 成熟度阶梯

```
Level 0：手动故障（工程师手动停服务，观察效果）
  ↓
Level 1：沙盒混沌（在隔离的测试环境自动运行实验）
  ↓
Level 2：预生产混沌（在 Staging 环境，用生产流量的镜像）
  ↓
Level 3：生产混沌（工作时间，限制爆炸半径，有回滚机制）
  ↓
Level 4：持续混沌（自动化、集成 CI/CD、GameDay 定期演练）
```

### 第一个实验的选择

不要从「随机杀生产 Pod」开始。第一个实验应该是：

1. **已知能通过的实验**（验证已有容错机制）：如系统已经有 Pod 多副本，先做「杀一个 Pod，观察是否自动恢复」
2. **爆炸半径极小**：只影响一个非核心服务，或只影响测试环境
3. **有清晰的终止条件**：定义好「实验在什么情况下立刻停止」

### 实验文档模板

```markdown
## 实验：Order Service 单 Pod 故障恢复

**稳态假说**：
  删除一个 order-service Pod 后，30 秒内成功率恢复到 > 99.5%

**实验动作**：
  删除一个 order-service Pod（标签 app=order-service）

**预期结果**：
  - Kubernetes 在 30 秒内重新调度新 Pod
  - 期间成功率短暂下降（< 5 秒），随后恢复

**回滚计划**：
  - 如果成功率 > 2 分钟不能恢复 → 手动 scale up replicas
  - 通知值班工程师

**结果**：
  ✅ Pod 在 12 秒内重启，成功率影响持续 3 秒，下降到 99.2%，符合预期
```

---

## GameDay

GameDay 是定期组织的混沌工程演练活动（通常季度一次），模拟特定的灾难场景，全团队参与：

**流程**：
1. 确定场景（如「数据库主节点宕机」「某机房断网」）
2. 通知相关团队（保密程度视目标而定，有时故意不通知测试响应速度）
3. 执行故障注入，记录时间线
4. 观察团队响应（报警触发了吗？流程对吗？沟通顺畅吗？）
5. 灾后复盘（Postmortem）：哪些预期 vs 实际有偏差

**GameDay 的价值不在于故障注入本身，而在于**：暴露告警盲点、响应流程漏洞、团队沟通障碍，这些都是在真实故障前无法通过普通测试发现的。

---

## 小结

| 概念 | 核心要点 |
|------|----------|
| 混沌工程原则 | 稳态假说 → 注入故障 → 观测 → 修复假设中的弱点 |
| 故障类型 | 网络延迟/丢包、Pod 终止、资源耗尽、应用层错误 |
| Chaos Mesh | Kubernetes 原生，CRD 声明式配置，支持 Workflow |
| LitmusChaos | CNCF 孵化，实验即代码，ChaosResult 可查询 |
| AWS FIS | 托管服务，深度集成 AWS，有 CloudWatch 熔断条件 |
| 实施路径 | 从沙盒到生产，逐步扩大爆炸半径 |
| GameDay | 定期演练，暴露流程和沟通问题，比工具更重要 |
