# Agent 沙箱全景：从进程隔离到 MicroVM 的工程实践

AI Agent 会执行代码、读写文件、访问网络、操作浏览器。

这是它的能力，也是它的危险之处。

一段模型生成的 Python 代码，可能删除整个目录；一次 shell 命令，可能向外泄露凭证；一个被注入的工具调用，可能将整个服务器作为跳板。**沙箱（Sandbox）是 Agent 系统的最后一道安全边界**——代码在里面跑，爆炸半径限制在里面。

这篇文章讲的是工程实现：沙箱有哪几个层级、每层怎么做、OpenAI/Anthropic/字节跳动/阿里云/Hermes/OpenClaw 各自怎么选，以及如何从零构建一个生产级的沙箱服务。

---

## 一、沙箱的发展：从浏览器到 AI Agent

沙箱不是 AI 时代的新发明。

**第一代（浏览器时代，2000s）**：Chrome 引入多进程架构，每个 Tab 一个独立进程，通过 `seccomp` 过滤系统调用，防止恶意网页攻击操作系统。这是最早的"用户代码不可信"假设。

**第二代（云计算时代，2010s）**：AWS Lambda、Google Cloud Functions 需要运行用户上传的函数代码。容器（Docker/Namespace/cgroup）成为标配，gVisor（2018 年 Google 开源）把内核也装进用户态。Firecracker（2018 年 AWS 开源）则以微虚拟机实现毫秒级启动的硬件级隔离。

**第三代（AI Agent 时代，2023–）**：大模型开始调用工具、执行代码。ChatGPT Code Interpreter（2023）、Claude Code（2024）、各类 Coding Agent 把沙箱需求推向新的高度——不只是"隔离一段用户代码"，而是"隔离一个会自主决策的 Agent 会话"。

新的挑战在于：Agent 沙箱需要**持久状态**（会话内文件可复用）、**工具多样性**（不只是代码，还有浏览器、文件系统、终端）、**快速弹性**（秒级或亚秒级创建和销毁），以及**强隔离**（多租户场景下租户间不能互相影响）。

---

## 二、三个隔离层级

安全性与性能始终是对抗关系。三个层级本质上是沿这条轴线做的工程选择。

```
隔离强度    低 ─────────────────────────────── 高
            进程级别      容器级别        VM 级别
            (Process)    (Container)   (MicroVM/VM)

技术手段    seccomp       gVisor         Firecracker
            namespace    Docker+hardened  Kata Containers
            cgroup       rootless         Apple Virtualization
            bubblewrap   sandbox          HCS (Windows)

主机内核    共享          共享 (gVisor    独立
                         拦截 syscall)

逃逸风险    高            中（gVisor 低）  低

启动时间    毫秒级         毫秒级          100ms~200ms

典型场景    本地 CLI      多租户 SaaS      公开代码执行
            受信任环境    AI Agent 服务    RL 训练
```

---

## 三、进程级别：最轻的隔离

### 3.1 核心原语

进程级别沙箱直接使用 Linux 内核的四个核心机制：

**Namespace**：把进程的视图切割成独立空间。

```
PID namespace     → 进程 ID 空间隔离，容器内 PID 1 ≠ 宿主 PID 1
Network namespace → 独立网络栈，veth pair 连接外部
Mount namespace   → 独立文件系统视图，bind mount 挂载需要的目录
User namespace    → UID/GID 映射，容器内 root = 宿主上的普通用户
IPC namespace     → 隔离 System V IPC 和 POSIX 消息队列
UTS namespace     → 独立 hostname
```

**cgroup（Control Group）**：限制资源使用。

```
memory.limit_in_bytes = 512MB    # 内存上限
cpu.cfs_quota_us = 100000        # CPU 配额
blkio.weight = 100               # 磁盘 IO 优先级
pids.max = 64                    # 进程数上限（防 fork bomb）
```

**seccomp（Secure Computing Mode）**：过滤系统调用白名单，拦截危险调用。

```c
// 允许的 syscall 白名单示例（Docker 默认禁止 ~44 个危险 syscall）
// 最小化原则：只允许代码执行真正需要的
允许: read, write, open, close, mmap, brk, exit, futex ...
拒绝: ptrace, mount, kexec_load, init_module, perf_event_open ...
```

**Capabilities**：细粒度的 root 权限分解。生产环境最佳实践是 `--cap-drop ALL`，只按需添加特定 cap：

```yaml
# Kubernetes securityContext 最佳实践
securityContext:
  runAsNonRoot: true
  runAsUser: 65534
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: ["ALL"]
    add: ["NET_BIND_SERVICE"]  # 如果需要绑定低端口才加
  seccompProfile:
    type: RuntimeDefault
```

### 3.2 bubblewrap（Linux）和 Seatbelt（macOS）

对于 CLI 工具（不在容器里跑），可以用更轻的沙箱工具：

**bubblewrap**：由 Flatpak 团队开发，用 Linux namespace + seccomp 实现轻量沙箱，**不需要 root 权限**。适合在用户机器上限制 Agent 的行为范围。

```bash
bwrap \
  --ro-bind /usr /usr \           # 只读挂载系统库
  --bind /tmp/workspace /workspace \  # 读写挂载工作目录
  --unshare-net \                  # 禁止网络
  --die-with-parent \              # 父进程退出时自动清理
  --new-session \
  python3 agent_code.py
```

**Seatbelt（macOS sandbox）**：macOS 内核级沙箱，通过 profile 描述文件声明权限：

```scheme
(version 1)
(deny default)                      ; 默认拒绝一切
(allow file-read-data (subpath "/tmp/workspace"))
(allow process-exec (literal "/usr/bin/python3"))
(deny network*)                     ; 禁止所有网络
```

:::方法 进程级别沙箱的使用场景
当运行**受信任用户的代码**（比如开发者自己的 CLI 工具）时，进程级别的 bubblewrap/Seatbelt 足够。它的优势是零启动延迟、零额外基础设施。不适合多租户场景——一旦攻击者触发内核漏洞，所有进程都在同一个主机内核，没有隔离屏障。
:::

---

## 四、容器级别：工业标配

### 4.1 Docker 强化配置

普通 `docker run` 不是安全沙箱——默认配置留了很多攻击面。生产中需要叠加所有 hardening 选项：

```bash
docker run \
  --rm \                            # 退出即销毁
  --network none \                  # 禁止网络（或指定隔离 network）
  --read-only \                     # 只读根文件系统
  --tmpfs /tmp:size=64m \           # 可写临时目录限制大小
  --cap-drop ALL \                  # 丢弃所有 capabilities
  --security-opt no-new-privileges \
  --security-opt seccomp=custom.json \  # 自定义 seccomp profile
  --memory 512m \
  --cpus 0.5 \
  --pids-limit 64 \
  --user 65534:65534 \              # 以非 root 运行
  sandbox-image python3 /code/run.py
```

**rootless Docker**：让整个 Docker daemon 运行在普通用户权限下，即使容器逃逸，拿到的也只是普通用户权限。

### 4.2 gVisor：用户态内核

gVisor 是 Google 在 2018 年开源的容器运行时，核心思想是**在用户态实现 Linux syscall 接口**，Guest 的系统调用不直接到达主机内核，而是被 Sentry（gVisor 的用户态内核）拦截处理：

```
传统容器:
  应用 → syscall → 主机 Linux 内核
         ↑ 攻击面：所有 300+ syscall

gVisor:
  应用 → syscall → Sentry（用户态内核，Go 实现）→ ptrace/KVM → 主机内核
         ↑ 大幅收窄   ↑ 只需少量 syscall 到主机
```

gVisor 有两种运行模式：
- **ptrace 模式**：不需要 KVM，任何环境可用，但性能损耗大（I/O 尤其明显）
- **KVM 模式**：需要硬件虚拟化支持，性能接近原生，云虚拟机上需要开启嵌套虚拟化

:::提醒 gVisor 的性能陷阱
gVisor 对**系统调用密集型**任务（如大量文件 I/O、网络）有 10–30% 的额外开销；对**计算密集型**（纯 Python 数值计算、矩阵运算）影响很小。选择前先 benchmark 实际工作负载。
:::

**在 Kubernetes 中使用 gVisor（runsc）：**

```yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
---
spec:
  runtimeClassName: gvisor   # Pod 声明使用 gVisor
```

OpenAI 的 Code Interpreter 正是在 Kubernetes 上以 gVisor 作为容器运行时，部署在 Azure AKS 的 `untrusted` namespace 中，每个 Jupyter kernel 进程在 gVisor 沙箱内运行。

---

## 五、VM 级别：硬件级隔离

### 5.1 Firecracker MicroVM

Firecracker 由 AWS 开源，为 Lambda 和 Fargate 提供底层隔离。它是一个极简的 VMM（Virtual Machine Monitor）：

- 基于 KVM，每个 MicroVM 有独立的 Linux 内核
- **只模拟最少的虚拟设备**：virtio-net、virtio-blk、串口、键盘——没有 BIOS、没有 PCI bus、没有 USB
- 冷启动约 **125ms**，内存开销 < 5 MiB
- 每个 vCPU 对应一个宿主线程，调度开销很小

```
Firecracker 架构:
┌─────────────────────────────────┐
│  Guest VM 1 (Python 代码执行)    │  ← 独立 Linux 内核
│  [Agent Code | Tool Process]    │
└────────────────┬────────────────┘
                 │ KVM hypercall
┌────────────────▼────────────────┐
│  Firecracker VMM (Rust)        │  ← 主机用户态进程
│  [virtio-net | virtio-blk]     │
└────────────────┬────────────────┘
                 │
     宿主 Linux 内核（KVM 模块）
```

**快照（Snapshot）能力**是 Firecracker 的核心特性：把一个已经初始化好的 MicroVM 状态保存到磁盘，需要时从快照恢复——实现**亚秒级冷启动**。阿里云 Agent Sandbox 正是基于此实现"100ms 级创建、1–10s 唤醒"。

### 5.2 Kata Containers

Kata Containers 把 OCI 容器镜像跑在轻量 VM 里，对 Kubernetes 透明——用起来像容器，隔离级别是 VM：

```
Kata 栈:
  kubectl → containerd → kata-runtime → QEMU/Cloud Hypervisor → Guest 内核 → 容器进程
```

Kata 比 Firecracker 更成熟，支持完整的 virtio 设备，更适合需要 GPU 透传或复杂 IO 的场景。

### 5.3 完整 VM（Full VM）

对于最高安全要求（比如用户提供自己的 SSH 密钥或签名密钥），完整 VM 是唯一选择：

```
Anthropic Claude Cowork 架构:
┌──────────────────────────┐
│  Agent Loop（宿主机）     │  ← Claude 模型运行在这里
│  上下文构建、工具调度      │
└───────────┬──────────────┘
            │ vsock / 超管接口
┌───────────▼──────────────┐
│  VM（Apple Virt / HCS）   │  ← 代码执行发生在这里
│  /workspace（挂载点）     │
│  凭证永远不进 VM           │
└──────────────────────────┘
```

关键设计原则：**敏感凭证（git credentials、signing keys）永远不进入 VM**，只在宿主机 keychain 保存，通过 vsock 代理必要操作。

---

## 六、业界实践对比

### 6.1 OpenAI：gVisor on Kubernetes

OpenAI Code Interpreter 的架构（通过逆向工程揭示）：

```
用户请求 → Kubernetes Pod（AKS untrusted namespace）
           ├── FastAPI 服务（port 8080）
           ├── AsyncMultiKernelManager（Jupyter）
           │     └── Kernel 进程（用户 Python 代码在这里执行）
           └── 整个 Pod 跑在 gVisor runsc runtime 上

文件系统: 会话内 ephemeral，无跨会话持久化
网络: Kubernetes NetworkPolicy 限制出站
身份验证: /self_identify 端点防止跨用户数据泄露
```

选择 gVisor 而非 Firecracker 的原因：Kubernetes 原生集成更简单，嵌套虚拟化在云 VM 上有额外配置成本。

### 6.2 Anthropic：三层模式按场景选型

Anthropic 对不同产品形态采用不同隔离策略，是业界最系统的分层实践：

```
产品形态         隔离方案              文件系统        特点
─────────────    ─────────────────    ────────────    ──────────────────
claude.ai        gVisor 容器          per-session     多租户 SaaS，强隔离
Code Interpreter  ephemeral            无持久化

Claude Code      OS 级沙箱            用户本地目录    开发者工具
（CLI/本地）      macOS: Seatbelt                     bubblewrap/Seatbelt
                 Linux: bubblewrap                   减少 84% 权限提示
                 网络: MITM 代理白名单

Claude Cowork    完整 VM              挂载工作区      高安全，凭证不入 VM
（团队协作）      Apple Virt / HCS                    三种挂载模式可配
```

网络隔离统一通过**出站 MITM 代理**实现：Agent 发出的所有 HTTP/HTTPS 请求经过代理审查，可以按域名白名单放行或阻断，用 scoped token 替换真实凭证。

Anthropic 已将 [sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) 开源，实现了不依赖容器、在 OS 层面强制文件系统和网络限制的轻量沙箱工具。

:::观点 Anthropic 的核心教训
他们发现"定制组件"是最脆弱的——出过 SOCKS5 null-byte 注入漏洞（影响 Claude Code v2.0.24–v2.1.89，共 130 个版本，历时 5.5 个月）。反而 hypervisor 和 seccomp 这类成熟的内核级机制从未出问题。教训：沙箱越靠近硬件层，攻击面越小。
:::

### 6.3 字节跳动：SandboxFusion + AIO Sandbox

**SandboxFusion**（开源，用于 LLM 评测）采用了一个有趣的技术决策：**绕过 Docker Engine，直接用 Linux 内核原语手工构造"一次性容器"**。

```python
# SandboxFusion 的隔离思路（简化）
# 直接使用 unshare + cgroup + overlayfs，不走 Docker daemon
# 优点：毫秒级启动，无 Docker socket 依赖，适合高并发评测
unshare --pid --net --mount --uts --ipc \
  cgroup_setup \
  overlayfs_mount(base_image, upper_dir) \
  exec(code)
```

支持 20+ 编程语言，集成 10+ 编码评测数据集，统一 HTTP API，专为 LLM 代码能力评测设计。

**AIO Sandbox**（火山引擎，生产服务）是另一个方向——All-In-One，单个 Docker 容器集成浏览器 + 代码执行 + 终端：

```
AIO Sandbox 容器内:
├── Chrome（无头浏览器，CDP 协议）
├── X11 + VNC（GUI 支持 + 远程桌面）
├── Python 3.10/11/12 + Node.js 22
├── tmux（多会话 shell）
├── supervisord（进程管理）
├── 反向代理（JWT 鉴权）
└── str_replace_editor（文件精细编辑）
```

两个产品代表字节对沙箱的两种需求：高并发轻量评测（SandboxFusion），和功能完整的 Agent 执行环境（AIO Sandbox）。

### 6.4 阿里云：MicroVM + 极致弹性

阿里云无影 **AgentBay** 以 MicroVM 为核心，主打大规模弹性：

```
AgentBay 核心指标:
├── 创建速度: 100ms 级（冷启动 via 镜像预热 + 暖池）
├── 唤醒速度: 1–10s（内存级休眠恢复）
├── 规模弹性: 15,000 Sandbox/分钟
├── 隔离级别: MicroVM（计算 + 网络 + 存储端到端隔离）
└── Checkpoint: 状态快照 + 克隆（并行探索）

使用场景:
├── AgentRL 训练：大规模并发沙箱 + 快速销毁重建
├── AgentServing：在线 Agent 服务（强隔离 + 弹性）
└── 开发调试：多工具环境（代码 + 浏览器 + 桌面）

计费: 按使用量（$0.108/vCPU/h），休眠期大幅降费
SDK: E2B 兼容接口，迁移成本低
```

镜像检索时间优化 90%（预热缓存），这解决了 MicroVM 冷启动的最大瓶颈——拉取镜像而非启动内核。

### 6.5 Hermes Agent（爱马仕）：7 层纵深防御

NousResearch Hermes Agent 是最受关注的开源 AI Coding Agent 之一，其沙箱设计层次最多：

```
Hermes 7 层防御:
Layer 1: 用户白名单（allowlist）
Layer 2: 危险命令人工审批（approval workflow）
Layer 3: Docker 容器隔离（6 种执行后端可选）
Layer 4: MCP 凭证过滤（Tool 调用时脱敏）
Layer 5: Prompt 注入扫描
Layer 6: 跨会话隔离（每 session 独立 task_id）
Layer 7: 输入净化（input sanitization）

6 种执行后端:
  local      → 直接在主机（最快，无隔离）
  docker     → Docker 容器（默认推荐）
  ssh        → 远程 SSH 机器
  daytona    → Daytona 云环境
  singularity→ HPC/科学计算场景
  modal      → Modal.com 无服务器
```

子 Agent（Subagent）隔离：每个子 agent 有独立的 task_id、独立 terminal session、50 步迭代上限、MAX_DEPTH=1（防止无限递归委派）、父进程中断时自动传播给所有子 agent。

已知漏洞：sandbox 曾被发现通过 PYTHONPATH 注入泄露内部模块；`terminal` 工具在白名单中意味着 RPC 代码可绕过沙箱直接执行 shell。

### 6.6 OpenClaw：Docker session 隔离

OpenClaw（2026 年 1 月正式命名，前身 Clawdbot/Moltbot，数周内 100k+ GitHub stars）采用的是轻量但实用的策略：**Gateway 进程在主机，工具执行在容器**：

```yaml
# OpenClaw 沙箱配置
agents:
  defaults:
    sandbox:
      driver: docker
      scope: session      # 每 session 独立容器（默认）
      workspaceAccess: ro # 只读挂载 agent workspace

# 三种 scope:
#   session: 一个容器 per 用户会话
#   agent:   一个容器 per agent（共享其所有 session）
#   shared:  全局共享容器

# 安全边界:
# - 阻止危险 bind: /docker.sock, /etc, /proc, /sys
# - tool allow/deny 策略先于 sandbox 规则
# - tools.elevated 机制允许授权操作绕过沙箱（逃逸口）
```

这个设计权衡很典型：为了保留"授权的危险操作"（如 Agent 需要管理 Docker 本身），提供了显式的逃逸口（`elevated` 工具）——设计可见，比隐性逃逸安全。

---

## 七、沙箱服务的工程构建

把沙箱从"单次执行"变成"生产服务"，需要解决六个工程问题。

### 7.1 生命周期与调度

```
Sandbox 生命周期状态机:

REQUESTED → CREATING → READY → ACTIVE → SUSPENDED → TERMINATED
               │                   │           │
               │ 失败               │ 空闲      │ 唤醒
               ↓                   ↓           ↓
           FAILED             SUSPENDED     ACTIVE

关键设计:
- 暖池（Warm Pool）: 提前创建 N 个 ready sandbox，减少冷启动延迟
- 快照恢复: 冷启动 = 快照恢复 + 绑定工作目录（< 200ms）
- 空闲回收: 超时未活动的 sandbox suspend/terminate，释放资源
- 健康探活: 定期 heartbeat，自动重建异常 sandbox
```

**Kubernetes Operator 模式**是管理大规模 sandbox 的主流方案——声明式 API 描述期望状态，Operator 负责实际创建、监控和销毁：

```yaml
apiVersion: sandbox.agent.k8s.io/v1alpha1
kind: AgentSandbox
spec:
  runtimeClass: gvisor          # 或 kata, firecracker
  resources:
    memory: "512Mi"
    cpu: "500m"
  workspaceMount:
    path: /workspace
    mode: ReadWrite
  networkPolicy:
    egress:
      allowedDomains: ["api.github.com", "pypi.org"]
  timeoutSeconds: 1800
```

### 7.2 网络隔离

网络是最容易被忽视的攻击面。三种常见方案：

**方案 A：完全禁网**（最安全，最受限）
```bash
--network none  # 或 Kubernetes NetworkPolicy deny-all egress
```
适合：纯数学计算、代码评测、不需要外部资源的任务。

**方案 B：域名白名单代理**（Anthropic 方案）
```
Sandbox → 出站代理（MITM）→ 白名单过滤 → 互联网
                ↑
         审计日志 + 自动脱敏凭证
```
适合：需要访问包管理器（pip、npm）、公开 API 的 Agent。

**方案 C：VPC 隔离 + Service Mesh**（云原生方案）
每个 sandbox 分配独立的 VPC 或 network namespace，通过 sidecar proxy 控制流量，适合需要访问内部服务的企业场景。

### 7.3 文件系统隔离

```
分层文件系统（overlayfs）:

┌─────────────────────────────────┐
│  upper layer（可写）             │  ← sandbox 的所有写操作
│  /tmp/sandbox-{id}/upper        │
├─────────────────────────────────┤
│  work layer                     │  ← overlayfs 内部使用
├─────────────────────────────────┤
│  lower layer（只读基础镜像）      │  ← Python 运行时、系统库
│  共享，节省磁盘空间               │
└─────────────────────────────────┘

挂载命令:
mount -t overlay overlay \
  -o lowerdir=/base-image,upperdir=/upper,workdir=/work \
  /merged

sandbox 销毁时: rm -rf /upper  # 只删 upper layer，基础镜像复用
```

跨会话持久化（如果需要）：upper layer 不销毁，下次恢复时重新挂载。

### 7.4 认证与凭证隔离

:::提醒 凭证是最高价值的逃逸目标
Agent 往往需要 API key、git 凭证、AWS credentials。这些永远不应该直接出现在 sandbox 内。
:::

正确做法：

```
主机 keychain
    ↓ 按需通过 vsock/RPC 代理
sandbox（代理调用，不持有真实凭证）
    ↓
外部 API（调用时注入 scoped token）

Scoped token 原则:
- 生命周期 = sandbox 会话生命周期
- 权限 = 最小化（只读 or 特定仓库）
- 一个 sandbox 一个 token，泄露影响面最小
```

### 7.5 可观测性

沙箱不是黑盒，应当有完整的审计链路：

```
审计维度:
├── 进程级: 每次 exec syscall（哪个进程执行了什么命令）
├── 文件级: 文件读写 inotify 或 eBPF 追踪
├── 网络级: 出站连接记录（目标 IP + 域名 + 时间）
├── 资源级: CPU/内存/磁盘 IO 时序数据
└── 工具级: Agent 每次 tool call 的输入输出

实现工具: eBPF（Falco、Tetragon）、auditd、容器 sidecar
```

---

## 八、安全边界与逃逸防御

已知的沙箱逃逸路径和对应缓解措施：

```
攻击路径                      缓解措施
──────────────────────────    ──────────────────────────────
内核 CVE（容器逃逸）            gVisor/Firecracker（隔离内核）
                              及时更新内核补丁

挂载逃逸（runc CVE-2024-21626） 禁止 --privileged
                              seccomp 过滤 mount syscall

符号链接攻击                   chroot + 只读根文件系统
                              禁止创建到 sandbox 外的 symlink

SOCKS5/代理绕过               验证所有出站代理协议
（Claude Code 历史漏洞）        null-byte 净化

PYTHONPATH 注入               沙箱内 env 变量白名单
（Hermes 历史漏洞）             子进程继承 env 过滤

Docker socket 暴露            永远不把 /var/run/docker.sock
                              挂进 sandbox
```

**纵深防御原则**：假设单层会被突破，设计每层独立的安全边界。sandbox 逃逸之后，下一层（网络隔离、凭证隔离、审计告警）应继续有效。

---

## 九、选型决策树

```
你的场景?
│
├─ 开发者本机 CLI 工具，运行自己代码
│   └─ bubblewrap（Linux）/ Seatbelt（macOS）
│       + 工作目录限制 + 网络白名单
│
├─ 多租户 SaaS，运行用户提交的代码
│   ├─ 预算有限 / 无嵌套虚拟化
│   │   └─ gVisor（runsc）+ Docker + seccomp 全套
│   └─ 需要最强隔离 / 有 KVM 支持
│       └─ Firecracker 或 Kata Containers
│
├─ AI Agent 服务，需要持久 session + 多工具
│   ├─ 自建
│   │   └─ Firecracker + overlayfs + 出站代理
│   │       参考: 阿里云 AgentBay 架构
│   └─ 直接用托管服务
│       E2B / Daytona / Modal / 阿里云 AgentBay
│
└─ 高安全场景（用户凭证、金融数据）
    └─ 完整 VM + 凭证不入 VM + vsock 代理
        参考: Anthropic Claude Cowork 架构
```

---

## 十、结语

沙箱是 AI Agent 系统里最容易被低估的工程模块。

早期的 Agent 项目往往先做能力（工具多、功能全），后做隔离（上线了再加沙箱）——这是错误的顺序。**沙箱越晚加，改动成本越高，历史漏洞越多**。Anthropic 在 Claude Code 历史上那次长达 5.5 个月的 sandbox bypass，正是定制网络代理组件引入的，而不是 bubblewrap 本身。

正确的工程顺序：先确定威胁模型（谁的代码、多少信任、什么资源可以访问），再按隔离需求选择层级，最后加上审计和告警作为最后一道防线。

Agent 能力越强，sandbox 要求越高——这是不可绕过的工程代价。

---

## 参考文献

1. Anthropic Engineering Blog, *Making Claude Code more secure and autonomous* — [anthropic.com/engineering/claude-code-sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing)
2. Anthropic Engineering Blog, *How we contain Claude across products* — [anthropic.com/engineering/how-we-contain-claude](https://www.anthropic.com/engineering/how-we-contain-claude)
3. Anthropic Open Source, *sandbox-runtime: OS-level filesystem and network restrictions* — [github.com/anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)
4. OpenAI API Docs, *Tools: Code Interpreter* — [developers.openai.com/api/docs/guides/tools-code-interpreter](https://developers.openai.com/api/docs/guides/tools-code-interpreter)
5. Ryan Govostes, *The OpenAI Code Interpreter* (2025) — [ryan.govost.es/2025/openai-code-interpreter](https://ryan.govost.es/2025/openai-code-interpreter/)
6. 字节跳动·火山引擎, *AIO Sandbox：为 AI Agent 打造的一体化可定制沙箱环境* — [developer.volcengine.com/articles/7599494081655668799](https://developer.volcengine.com/articles/7599494081655668799)
7. 知乎, *从零拆解 SandboxFusion：字节如何在不依赖 Docker 的情况下实现毫秒级代码隔离* — [zhuanlan.zhihu.com/p/1974229085552132373](https://zhuanlan.zhihu.com/p/1974229085552132373)
8. 阿里云, *Agent Sandbox 概述（容器计算服务 ACS）* — [help.aliyun.com/zh/cs/user-guide/agent-sandbox](https://help.aliyun.com/zh/cs/user-guide/agent-sandbox/)
9. 阿里云函数计算, *AIO Sandbox：集成浏览器代码执行的统一云端隔离环境* — [help.aliyun.com/zh/functioncompute/fc/aio-sandbox](https://help.aliyun.com/zh/functioncompute/fc/aio-sandbox)
10. DeepWiki, *NousResearch/hermes-agent: Code Execution Sandbox* — [deepwiki.com/NousResearch/hermes-agent/5.7-code-execution-sandbox](https://deepwiki.com/NousResearch/hermes-agent/5.7-code-execution-sandbox)
11. OpenClaw Docs, *Sandboxing – OpenClaw Gateway* — [openclawlab.com/en/docs/gateway/sandboxing](https://openclawlab.com/en/docs/gateway/sandboxing/)
12. Northflank, *How to sandbox AI agents in 2026: MicroVMs, gVisor & isolation strategies* — [northflank.com/blog/how-to-sandbox-ai-agents](https://northflank.com/blog/how-to-sandbox-ai-agents)
