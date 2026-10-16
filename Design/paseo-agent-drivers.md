# Paseo 如何驱动 Claude Code、Codex、Pi 与 OpenCode

## 范围与证据版本

本文记录源码事实，并提出迁入 DSH 插件的设计；本文不是已完成的集成说明。

- Paseo：`d57096a4568cd2db106f35a0c5011627de53a646`，本地位于 `../reference/paseo/`。
- DeepSeek Harness：`571902028a75c64c1d767f4ae5fd099485f0ddf0`，`0.2.1-alpha.3`。
- 方法：阅读 Provider、统一接口、Agent 生命周期与工具目录；未启动真实账号或运行四类引擎。

Paseo 是编码 Agent 的会话管理与交互层。它调用真实引擎的 SDK/协议，不自行重写这些引擎的推理循环。用户可以直接持续操作一个 Agent，也可以让 Agent 调用工具创建和驱动另一个 Agent。

## 总体调用链

```text
Mobile / Web / Desktop
        ↕ WebSocket（直连或可选 Relay）
Paseo Daemon / AgentManager
        ↕ AgentClient / AgentSession
Provider Adapter
        ↕ SDK / stdio JSON-RPC / HTTP + 事件流
真实编码 Agent
```

Daemon 持有进程、会话、权限请求及统一时间线；客户端断开不等于 Agent 被终止。客户端展示的是 Provider 转译后的事件，不能假设与原生界面完全等价。云端运行时，文件和进程位于云端执行主机；控制用户电脑仍需要本地执行节点。

## 统一会话接口

源码：[agent-sdk-types.ts](../reference/paseo/packages/server/src/server/agent/agent-sdk-types.ts)。

`AgentClient` 负责 `createSession()`、`resumeSession()` 和能力/模型目录。返回的 `AgentSession` 包含：

| 操作 | 作用 |
|---|---|
| `startTurn()` / `run()` | 向会话提交新一轮任务 |
| `subscribe()` | 接收消息、工具、状态、权限等规范化事件 |
| `streamHistory()` | 重放可用历史 |
| `describePersistence()` | 返回 Provider 原生持久化句柄 |
| `getPendingPermissions()` / `respondToPermission()` | 暂停等待审批或提问，再把答案交回引擎 |
| `interrupt()` | 停止当前执行；不应误认为删除会话 |
| `close()` | 释放运行资源，保留原生持久化会话 |
| `steerActiveTurn()` 等可选接口 | 执行中追加指令、模型设置、回退等；依 Provider 能力实现 |

原生会话身份、工作目录、Provider 配置与展示时间线分开管理。重启后通过原生句柄恢复，不能仅凭 Paseo Agent ID 重新创建一个空会话来冒充恢复。Provider 不支持的操作必须明确报告不可用。

## 四类引擎的驱动方式

| 引擎 | 驱动入口 | 会话身份与交互 |
|---|---|---|
| Claude Code | `@anthropic-ai/claude-agent-sdk` | SDK 管理真实 CLI，桥接会话恢复、流式事件、工具权限回调与中断 |
| Codex | 原生 `app-server`，stdio JSON-RPC | thread 持久身份，turn 表示一轮执行；请求与通知双向通信 |
| Pi | 已安装的 `pi --mode rpc` | JSONL 双向命令/事件，原生会话文件作为恢复句柄 |
| OpenCode | 本地服务 + 版本对应 SDK/HTTP + 事件流 | 原生 session ID；服务管理器持有进程，Adapter 管理会话 |

### Claude Code

源码：[claude/agent.ts](../reference/paseo/packages/server/src/server/agent/providers/claude/agent.ts)。

1. 从 Provider 配置解析 CLI、环境、工作目录与模型/权限选项。
2. 通过官方 Agent SDK 建立查询，处理连续输入和输出流；恢复路径使用原生会话身份。
3. 将 SDK 消息转成统一时间线，记录文本、工具过程、终态与可观测的子任务。
4. 通过 `canUseTool` 把权限请求交给 Paseo，等待用户或获授权的管理操作回答。
5. 区分主会话轮次与后台子 Agent 事件，避免把后台活动错误地当成新一轮主任务。
6. 中断还需撤回未消费的追加指令，避免已停止任务被旧输入再次唤醒。

SDK/CLI 认证沿用原生机制。Paseo 不是 Claude 模型 API 的简单代理；最终行为还受安装的 Claude Code 版本与原生设置影响。

### Codex

源码：[codex-app-server-agent.ts](../reference/paseo/packages/server/src/server/agent/providers/codex-app-server-agent.ts)、[app-server-transport.ts](../reference/paseo/packages/server/src/server/agent/providers/codex/app-server-transport.ts)。

1. 解析并启动真实 Codex app-server，初始化 stdio JSON-RPC 通道。
2. `thread/start` 新建会话；`thread/resume` 恢复持久线程。
3. `turn/start` 提交任务，支持时用 `turn/steer` 向当前轮次追加指令。
4. 接收 `item/*`、轮次和线程通知，转成文本、推理摘要、命令、文件改动与状态事件。
5. 处理 Codex 发起的执行审批、文件变更审批及用户提问，并把响应送回原请求。
6. 清理时拒绝悬挂 RPC，终止受管理进程；不能把协议断连误报为正常完成。

关键是完整处理双向请求与生命周期，而不是启动 CLI 后只读取最后一行输出。

### Pi

源码：[pi/agent.ts](../reference/paseo/packages/server/src/server/agent/providers/pi/agent.ts) 及同目录 RPC、历史与扩展适配代码。

1. Paseo 使用用户安装的 `pi`，通过 `pi --mode rpc` 驱动，不嵌入 Pi SDK/runtime。
2. 使用请求 ID 关联 JSONL 命令响应，同时接收独立异步事件。
3. 向会话提交 prompt，支持时使用 steer；停止前清理未消费输入，避免旧任务残留。
4. 保存原生 session 文件路径作为恢复句柄；导入发现会读取原生 JSONL 文件，历史恢复仍走 Pi RPC。
5. 生成 Pi 集成扩展，注入 Paseo 工具和系统提示补充，并转换扩展产生的工具/子任务事件。
6. 把扩展的 `select/input/editor/confirm` 交互转换为 Paseo 问题请求，再回复 `extension_ui_response`。

Pi 原生模型、MCP 和扩展能力有版本差异，不能默认所有 Pi 兼容分支都能共用同一个适配器。Paseo 对 OMP 使用独立 Provider。

### OpenCode

源码：[runtime-client.ts](../reference/paseo/packages/server/src/server/agent/providers/opencode/runtime-client.ts)、[server-manager.ts](../reference/paseo/packages/server/src/server/agent/providers/opencode/server-manager.ts)、[opencode-agent.ts](../reference/paseo/packages/server/src/server/agent/providers/opencode-agent.ts)、[v2/agent.ts](../reference/paseo/packages/server/src/server/agent/providers/opencode/v2/agent.ts)。

1. 探测实际配置的可执行文件版本，选择对应的 v1/v2 实现。
2. 服务管理器启动或复用受管理的本地 OpenCode 服务，并用引用计数管理服务代次和释放。
3. 使用版本对应的 SDK/HTTP API 新建或恢复原生 session，发送 prompt 并消费事件流。
4. v1 实现使用 `session.promptAsync` 提交任务；事件消费者更新消息、工具、权限和最终状态。
5. 中断和追加输入遵循对应版本的语义，不假定异步提交的 HTTP 响应代表任务完成。
6. 持有真实 session 身份；原生会话缺失必须报告恢复失败，不能偷偷新建。

本次参考版本的文档标注测试目标为 v1.14.46 / v2.0.10，v2 路径拒绝低于其测试下限的二进制。这是该参考提交的事实，不代表今后最新 OpenCode 仍兼容。

## Agent 之间如何委派

源码：[paseo-tools.ts](../reference/paseo/packages/server/src/server/agent/tools/paseo-tools.ts)、[agent-lifecycle.md](../reference/paseo/docs/agent-lifecycle.md)、[providers.md](../reference/paseo/docs/providers.md)。

```text
父 Agent 调用 create_agent（选择 Provider 与工作区）
        ↓
AgentManager 创建受管理的子 Agent，登记父子关系
        ↓
子 Provider 新建真实会话并接收任务
        ↓
父 Agent 可 send_agent_prompt / wait_for_agent
用户可打开子会话、看过程、回答审批
        ↓
完成 / 失败 / 权限检查点通知调用者
```

Paseo 内部有共享工具目录。支持原生工具注入的 Provider 直接注册；其他 Provider 通过注入的 `/mcp/agents` 服务调用同一工具集，避免把所有内部工具实现都绑定到 MCP。

- `create_agent` 是异步创建，会自动登记调用者为父 Agent。
- 未指定工作区时沿用调用者工作区；创建 worktree 属于单独的工作区操作，不自动发生。
- `send_agent_prompt` 可以继续驱动已有子会话，不限于首轮任务。
- 完成通知与权限通知是不同检查点；出现审批并不代表任务结束。
- 可配置首轮终态后自动归档，但不是所有子 Agent 都是一次性的。
- 同一工作区不会自动隔离文件改动；并行修改需要显式工作区/worktree 策略。
- Claude/Codex/OpenCode 引擎内部创建的原生子 Agent，通常由 Provider 自己管理；不要与 Paseo 的受管理子 Agent 混为一谈。

## 在 DSH 上的实现建议（待开发）

保留官方引擎，新增自有插件，通过公开服务、事件及客户端 Remote 接口组合。不要把 Paseo 的整个 AgentManager 和 Daemon 搬入 DSH，再形成两套会话与权限权威。

建议拆分：

| 插件职责 | 内容 |
|---|---|
| 会话驱动契约 | Provider 注册、能力描述、原生句柄、turn、事件和释放接口 |
| Claude / Codex / Pi / OpenCode Adapter | 各自 SDK、协议和版本差异 |
| 外部会话管理 | DSH 会话与原生会话映射、恢复、审批关联和并发控制 |
| 客户端展示 | 外部消息、工具过程、子会话与待审批面板 |
| 委派工具 | 新建、追问、等待、停止，通过同一个会话管理服务执行 |

这些是职责划分，不是已经存在的 DSH 服务名或 API。先验证 `ctx.subagents` 的持续执行契约能否覆盖外部引擎；当前原生 Claude/Codex 一次性 Provider 不能直接假设具备持续恢复能力。若现有契约不足，先在自有插件公开额外服务，再适配可用的子 Agent 工具接口。

实现时必须明确：

1. DSH Session ID、外部 session/thread ID、进程实例 ID 分开保存；进程退出不代表删除持久会话。
2. 外部事件通过受支持的 Session 事件/投影和 Remote 通道呈现，不篡改官方原生日志结构。
3. 本地审批、DSH 审批与外部引擎审批的授权映射必须明确，不把一次批准升级为永久权限。
4. 原生账号与凭证仍由对应引擎维护，插件只管理显式运行配置。
5. 每个原生会话的轮次串行提交，避免多端同时操作导致重复执行；以消息身份关联输入回显。
6. 热卸载要等待中断和资源回收；不能因 UI 断连或插件重载遗留无人管理进程。
7. 能力按 Provider 声明，缺少历史、steer、图片或审批支持时明确呈现限制。

### 建议实施顺序

先接 Codex：创建/恢复线程 → 连续两轮对话 → 实时事件 → 人工审批 → 中断 → DSH 重启恢复。再接 Claude Code，随后处理 Pi 扩展与 OpenCode 版本分支。

每个 Provider 都用同样的验收场景：真实引擎执行文件任务、多轮追问、工具失败、拒绝审批、主动中断、网络/进程断开、进程重启后恢复。纯协议假实现可以验证状态机，但不能替代真实 CLI 兼容性验证。

## 复用与许可

优先借鉴接口和协议边界，按需重写自有插件。复制 Paseo 实现必须保留 Apache-2.0 要求的版权、许可证和适用 NOTICE；不能因主项目是 MIT 就去掉参考项目的许可要求。参考仓库不应成为产品运行依赖。
