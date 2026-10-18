# DSH-Plus

内置 Voice 语音能力，安装、构建和卸载均随本插件完成，不再单独安装 Voice；配置与模型说明见 [语音模块](voice/README.md)。

### 加载与侧栏

项目和分组优先使用官方 Workspace 实时快照，不等待额外的 Commander 状态请求。原生会话状态在页面可见时轮询：活动状态每 2 秒、空闲每 10 秒；后台标签暂停，返回时立即刷新，相同数据不重复通知界面。模型目录的并发工具请求共享一次在途构建，每次供应商目录只投影一次设置，完成后不保留目录结果缓存，后续配置和凭据变化仍能及时读取。

会话选中态要求明确的活动会话 ID，未打开对话时不高亮任何行；未迁移的子代理不会跟随父会话误选中。前端构建启用压缩；首次远端访问仍需下载官方首屏资源，本机接口耗时不代表用户网络上的完整加载时间，测量记录见 [验证记录](VERIFICATION.md)。

### RouterGo 的 DeepSeek 路由

供应商编辑器的“适用工具”横向排列，窄屏自动换行。第三方供应商在“自定义设置 → 模型列表 → 展开模型”中配置该模型的思考档位，支持继承目录、非推理、预设和自定义映射；草稿随供应商一起保存，取消不生效。自定义复用官方 `reasoningEfforts`：档位键限 `off/minimal/low/medium/high/xhigh/max`，协议值可按网关修改（如 `max: ultra`）；只有 `off` 可不发送值，必须保留至少一个思考档位。聊天时仍在模型菜单选择实际使用的档位。声明能力不保证服务端支持，DeepSeek 等协议差异仍需按下方示例配置 `compat`。原生 DeepSeek 使用官方固定档位，不套用第三方映射编辑器。实现基于 Harness `571902028a75c64c1d767f4ae5fd099485f0ddf0`，通过插件构建适配复用官方草稿与保存流程，不修改子模块。

自定义 RouterGo 路由使用官方通用 `llm-pi-ai` 适配器；其 `/models` 目录不一定携带思考能力。`deepseek-v4.1-flash` 的配置见 [配置示例](config/routergo-deepseek.example.yml)，合并到已有供应商配置，保留其他模型及密钥引用。模型级声明 `reasoningEfforts: { off: null, high: high }` 和 `compat.thinkingFormat: deepseek` 后，`off` 发送 `thinking.disabled`，`high` 发送 `thinking.enabled` 与 `reasoning_effort: high`。模型选择器只继承当前能力允许的思考档位，避免旧会话带入无效值。

2026-10-16 实测，同一个 RouterGo 地址和凭据的 Chat Completions 可完成请求，但 Messages 流缺少 `message_start`。本机已停用指向 RouterGo 的该 Messages 配置，默认及受影响会话统一使用明确的 RouterGo Completions 路由；这不表示真正的 DeepSeek 官方端点存在同样问题。实测 `off` 请求确实发送关闭参数，但上游仍可能返回推理内容，是否执行关闭由上游决定。

### 用量统计

侧栏设置行、归档按钮左侧的用量图标打开统计弹窗。支持今天、3/7/15/30 天和本地日期自定义区间，按工具、模型汇总真实 Token、缓存读取与命中率、输出速度。概览中的“数据图表”展示所选日期内全部记录的 Token 用量和记录数量，合并为双轴图表（Token 柱形使用左轴，记录数量折线使用右轴），当天按小时、多天按天，超过 90 天按月、超过 10 年按年汇总；按浏览器时区分桶，不受详细记录分页影响。详细使用记录每页 50 条；汇总覆盖整个时间范围。

采集范围包括本插件已管理的原生事件、官方 Harness 历史，以及当前系统用户可读的 Codex、Claude Code、Pi、OpenCode 本机历史。扫描按文件数、字节数和单行大小设限，保留增量游标；扫描覆盖状态与异常保留在统计接口，弹窗不再显示数据来源板块；刷新可再次扫描，不代表已覆盖所有历史。旧 Commander 事件有长度上限，原先被丢弃或未上报的用量无法补造；启用后元数据单独写入 Commander 数据目录的 usage.json，不保存明文输入、回复或密钥。删除对话不会删除已归集的匿名计数。此记录是本地使用观察，不作为供应商账单。

未提供的计数显示“未提供”，不计为零；缓存容量和命中率不按模型名称猜测。Codex 逐次用量以原生累计计数差分去重，首次观测保留原生 last 请求口径；上下文使用原生最后请求输入计数，不把输出计入上下文。原生目录提供真实 contextWindow 时才向官方 Harness 透传容量，默认或未知模型不猜容量。只有可识别的单次原生请求才投影官方 usage；多请求原生回合保留账单记录，不伪造单次上下文或速度。官方速度从持久化流首个有效增量到步骤完成时间计算；生成区间包含工具和暂停，不冒充纯模型解码速度，缺少有效时间时为空。官方历史通过 sessionQuery 读取已持久化的 assistant/message / assistant/attempt，排除继承前缀和 Commander 路由以防重复。统计损坏或写入失败不阻断聊天。

插件产品名为 **DSH-Plus**；`@dowork/commander`、`plugins/commander/` 与 `commander_*` 保持为兼容标识，现有配置及会话无需迁移。

状态：已实现 Harness Web 项目侧栏、原生工具/模型选择、直接聊天、审批与跨引擎委派；保留 Harness 工具调用与本地 CLI 入口。尚未达到完整 Paseo 功能对等。

## 远程连接

设置中的“远程连接”启用 Link：Android 局域网扫码与公网 HTTPS 手机网页，支持共享会话、实时文本、发送、停止和人工审批；默认关闭。使用条件、目录与验收边界见 [Link](../link/README.md)。

## 使用

```sh
npm ci --prefix plugins/link
npm ci --prefix plugins/commander
npm --prefix plugins/commander run build:client
npm run commander
```

进入交互入口后：

```text
/doctor
/new codex /你的工作目录
请检查这个项目，先不要修改文件
/stop
/list
/resume 之前的Commander会话ID
```

普通文字发送到当前会话；`/use ID` 切换查看；`/approve 请求ID yes|no` 回答权限；`/answer 请求ID JSON` 回答问题；`/events [游标]`、`/history`、`/discover` 查看事件、原生历史和可发现的原生会话；`/close` 释放进程并保留会话；`/archive` 归档。

默认数据目录为 `~/.dowork/commander`，保存原生句柄、输入幂等凭据与最近 2000 条事件。可以用 `npm run commander -- --data-dir /绝对路径` 指定目录。CLI 与 Harness 同时运行时应使用不同目录，同一目录只允许一个拥有者。

### 安装到官方 Desktop

已安装官方 `dsh` CLI 时，从仓库根目录执行：

```sh
dsh plugin --profile desktop add ./plugins/commander
```

重启 Desktop 后，Harness 可调用 `commander_*` 工具。源码开发环境完成官方依赖安装和构建后，可在 `deepseek-harness/` 中执行 `pnpm dsh plugin --profile desktop add ../plugins/commander`。实际 Desktop 使用的 `DSH_HOME` 必须与安装时一致；当前尚未进行图形界面安装/运行验收。

插件提供 `ctx.commander` 服务，以及 providers / doctor / sessions / create / connect / send / events / wait / interrupt / steer / close / history / discover / archive 共 14 个工具。外部会话按 Harness session 隔离；创建需要真人授权，原生权限继续经官方审批服务路由。没有让模型自行批准的工具。后台任务不会因一次 wait 超时而终止。

### Web 项目与直接聊天

访问现有 Harness Web，点击侧栏 **新聊天** 或项目旁 **＋**，在官方模型菜单选择 Codex、Claude Code、Pi、OpenCode 及其模型，直接在官方输入框发送。不再使用 Commander 独立聊天页或“选择伙伴”卡片。项目复用 Harness Workspace 注册表；多个工具共享目录，原生上下文各自独立，不自动建立 worktree。

侧栏使用单行标题、工具图标、项目与最近列表；运行或等待审批时显示小状态点。空白 Harness 会话不出现在侧栏，首次发送才建立原生会话。消息、Markdown、流式回复、停止和人工审批由官方 UI 承载；当前 adapter 仅支持文字，原生工具详细事件尚未投影到官方轨迹。

旧版会话及完成后的委派子会话可以点击接手，绑定官方会话并保留原生句柄；旧消息暂不复制到官方 journal。运行中的旧会话先完成后接手。切换工具或模型会使用独立的原生上下文。

Web 接口继承官方认证、Origin 检查和 owner 权限；初次登录使用官方启动链接。部署域名及来源 IP 限制由服务器配置管理，不属于插件硬编码。插件不修改上游源码。

### 原生命令服务接口

在官方输入框发送 `/native` 查看当前工具目录；使用 `/native compact` 或 `/native 技能名 参数` 执行。原生命令与 Harness 自身命令分开，`/compact` 不会被劫持。

`ctx.commander.commands(id)` 读取该会话的原生命令目录，返回 `{name, description, argumentHint, kind}` 数组；`ctx.commander.command(id, {name, arguments?, requestId?})` 执行命令，返回与 `submit` 相同的持久化输入收据。`name` 可带 `/` 前缀。调用前需要已连接且空闲的原生会话；不支持的命令明确报错，不转成普通文本或 shell 执行。

| 工具 | 命令发现与执行 |
| --- | --- |
| Codex | `skills/list` 返回技能，执行时发送原生 skill 输入；`compact` 映射 `thread/compact/start`，等待原生完成事件；不接受 compact 参数 |
| Claude Code | SDK `supportedCommands()` 返回目录，通过持续输入发送原生 slash 命令；补充展示无模型回合的命令结果 |
| Pi | `get_commands` 返回扩展、技能等目录；`compact [instructions]` 使用原生 RPC；处理 `agentInvoked:false`，旧版无该字段时通过状态确认无模型回合；展示 `command_output` |
| OpenCode v1 | `/command` 返回目录，原生命令走 `/session/:id/command`；`compact`、`summarize` 走 summarize API，当前必须明确选择 `provider/model`，且不接受额外参数 |

命令与普通消息共用活动回合互斥、持久化 requestId 和不确定收据机制；同 requestId 重试不会重复执行，且不能将命令重试成普通消息。Codex 本地 custom prompts、goal、Pi autocompact 的额外封装及完整 TUI 命令等价尚未实现；目录只表达当前引擎和适配层实际提供的命令。命令发现、compact 及上述行为已经协议夹具验证，四工具新增命令链路尚未用真实模型验收，不等同于此前聊天链路的真实测试。

### 原生 Agent 之间委派

在原生会话中要求使用 `commander_delegate` 委派，例如：“委派给 Pi，让它只回复你好，不要修改文件。” Codex 通过原生 dynamic tool，Claude/OpenCode 通过本地 stdio MCP，Pi 通过扩展工具接入。操作只继承父会话的项目路径，不能由模型传入另一个目录；启动前显示人工确认，子会话独立出现在项目侧栏，可直接接手。

传参 `{provider, text, model?}` 创建子任务，返回子会话身份、文本与状态；55 秒内未结束时返回 pending，可用 `{operation: "result", sessionId}` 读取同一子会话，不能重复创建任务代替重试。仅能读取自己的直接子会话。默认最多三层嵌套、每个父会话十二个未归档子会话，可由插件配置 `maxDelegationDepth` / `maxDelegationChildren` 调整。父会话结束不自动终止独立子任务；需要停止时显式进入子会话中断。

原生桥只监听动态 loopback 端口，使用每连接随机凭证并在断开时撤销；这些内部凭证不发送给网页。CLI 单独运行时不启用该桥。当前原生内部委派仅用于直接创建的 Commander Web 会话；Harness 对话的 `commander_*` 继续按原对话隔离。

构建前端：`npm --prefix plugins/commander run build:client`；更新代码后重启实际 Harness 服务并刷新页面。详细验收见 [VERIFICATION.md](VERIFICATION.md)。

### 代理配置

Pi 使用的 undici 不接受 SOCKS URL。若代理端口同时支持 HTTP，可使用本目录的 `config.example.json`：

```sh
npm run commander -- --config plugins/commander/config.example.json
```

示例使用本机 HTTP 代理 `127.0.0.1:10808`，不是所有 SOCKS 服务都支持 HTTP；请按实际环境修改或去掉 `env`。大小写代理变量都覆盖，避免旧的小写变量优先生效。不修改系统环境，也不静默关闭代理。

Harness 的 Bundle 行也可设置 `config.providers`、`config.dataDir` 等同结构字段。模型密钥与 CLI 登录沿用各工具自己的配置，`/doctor` 只检测可执行文件和版本，不将“已安装”冒充“已登录”。

### 本地程序接口

`npm run commander -- --stdio` 使用可信本地 stdin/stdout JSONL 控制，输出响应及实时事件；此接口未监听任何网络端口。示例请求：

```json
{"id":1,"method":"create","params":{"provider":"codex","cwd":"/绝对路径"}}
{"id":2,"method":"send","params":{"id":"返回的Commander会话ID","text":"检查项目","requestId":"稳定且唯一的输入ID"}}
```

支持 providers、doctor、list、create、connect、send、steer、interrupt、approve、events、history、discover、wait、close、archive。导入既有原生会话时向 create 传 `nativeId`，先停止其原始写入进程；当前无法可靠发现其他程序持有的活跃 CLI，也不会强行抢占。

同一 requestId 的重试返回原收据；内容改变则拒绝。收据为 uncertain 时表示原生提交结果不确定，应先查原生历史，不能换 ID 自动重跑。

### 测试

```sh
npm run test:commander
npm --prefix plugins/commander run test:native
```

默认原生测试仅启动真实 Codex 并握手，不调用模型。选择其他工具或进行真实付费模型验证需显式设置：

```sh
COMMANDER_NATIVE_PROVIDERS=codex,claude,pi \
COMMANDER_HTTP_PROXY=http://127.0.0.1:10808 \
COMMANDER_LIVE=1 npm --prefix plugins/commander run test:native
```

`COMMANDER_HTTP_PROXY` 只用于原生测试进程，按实际网络设置。协议夹具测试不等于真实引擎兼容性验证，见 [验证记录](VERIFICATION.md)。

## 已实现与边界

| 能力 | 当前实现 |
| --- | --- |
| 原生适配 | Codex app-server、Claude Agent SDK、Pi RPC、OpenCode v1 HTTP/SSE |
| 会话 | 创建、显式导入、连接、恢复、原生历史、关闭、归档 |
| 持续交互 | 多轮输入、流式文本、工具事件、中断；Codex/Pi 支持 steer |
| 审批 | 原生请求绑定独立 ID；超时/中断默认拒绝；Harness 真人审批桥接；Pi 扩展对工具调用逐次确认 |
| 任务委派 | Codex dynamic tool、Pi 扩展及 Claude/OpenCode stdio MCP；人工批准后创建同项目子会话并回传结果 |
| 一致性 | 同会话输入互斥、持久化幂等收据、事件游标、有界回放、旧连接代次隔离 |
| 原生发现 | Codex / Claude / OpenCode；Pi 暂只支持传入原生会话文件路径 |

Claude 使用原有原生权限规则，`canUseTool` 只桥接原生请求确认的操作，不把原生自动允许的工具重新变成逐次审批。OpenCode v1 用 ask 权限创建会话；恢复既有会话沿用原策略。Pi 的扩展逐次询问工具，不构成操作系统沙箱。

Harness 端通过官方 `userQuestions` 服务桥接 Codex / Pi / OpenCode 的选择与输入问题，以及 Claude 的 AskUserQuestion。没有问题服务、用户取消或超时时，拒绝/取消原生请求，不生成假答案；服务映射已有测试，具体桌面展示尚未进行 GUI 验收。本地入口可用 `/answer` 提交原生结构（Codex `answers` 对象、Pi `value`、OpenCode `answers` 数组，Claude `allow: true` 与 `answers` 对象）。

OpenCode **仅适配 v1**，主动拒绝 v2；需要安装现有 CLI，插件不会下载四套工具。跨服务重启时会话先标记 disconnected，用户显式连接，不自动重跑任务。外部程序正在写入的会话不保证能探测，不能承诺任意进程热接管。

回放只保留最近事件，游标断档时返回 truncated；长期完整历史由各原生引擎负责。异常退出可能留下 owner.lock，先核对其中主机与 PID 已无运行进程，再人工删除锁文件；不要删除仍在使用的锁。

插件禁用或 Host 退出会停止它持有的进程；仅客户端关闭连接才保留后台任务。日志和会话内容存储在本机，仍可能包含敏感输出，应保护整个数据目录。

## 后续目标（尚未全部实现）

指挥官统一管理多个编码 Agent，让用户直接接管，也能让 Agent 相互委派任务。目标是实现 Paseo 式的完整会话管理与交互体验，而非只启动一次 CLI 并收集结果。

## 功能范围

1. 检测 Claude Code、Codex、Pi、OpenCode 的安装、版本、登录和可用能力；使用其原有账号配置，不强制复制凭据。
2. 创建、发现可支持的历史会话、恢复与继续对话；保留原生 session/thread 身份、工作目录及模型配置。
3. 展示实时文本、工具调用、执行结果、状态、待审批及用户问题；支持继续输入、能力允许时的 steer、停止和关闭。
4. 原生审批双向桥接；拒绝、超时、客户端断开都有明确结果，不自动放行。
5. 持有进程与会话生命周期；客户端离开不终止任务，执行服务重启后尝试原生恢复，并明确展示失败原因。
6. 会话列表、工作区、历史回放、归档及恢复；删除展示记录、删除原生历史、终止进程是不同操作。
7. Agent 间创建任务、发送后续消息、等待、观察和停止；用户可以随时打开子会话接手。
8. 与 Link 组合实现多端查看、接续输入与审批；通过内置 Voice 实现语音控制。

这里的 Paseo 对标范围是编码 Agent 会话控制、多端接续及委派。Paseo 的通知、文件、终端、Git/worktree 等配套体验，在实施时逐项盘点，复用 Harness 已有能力或明确缺口，不用“功能完整”笼统代替验收。

## 接管的准确含义

| 场景 | 目标行为 |
| --- | --- |
| Commander 启动的会话 | 管理整个运行生命周期、持续输入输出、工具审批与中断 |
| 已存在的持久会话 | 经支持的原生接口发现并恢复，先检查是否仍有其他写入者 |
| 其他终端中正在运行的 CLI | 只有原生提供 attach/control 接口时才连接；否则要求先停止原进程再恢复会话 |
| 普通终端进程或屏幕内容 | 不把读取终端输出当成获得原生会话和审批控制权 |

不承诺无条件劫持任意运行进程，也不承诺四种工具的原生界面和功能完全等价。

## 适配入口

| Provider | 参考入口 | 要点 |
| --- | --- | --- |
| Claude Code | Claude Agent SDK | 持续输入、原生恢复身份、工具权限回调及中断 |
| Codex | `codex app-server`，stdio JSON-RPC | thread / turn、审批请求、通知与恢复 |
| Pi | `pi --mode rpc` | 双向 JSONL、原生会话文件、扩展工具与问题 |
| OpenCode | 本地服务及匹配版本的 SDK/HTTP/事件流 | 原生 session、服务生命周期、版本能力差异 |

上表来自 [Paseo 源码分析](../../Design/paseo-agent-drivers.md)，不是本插件已验证的兼容列表。实现时逐一固定并验证版本。

## 状态和控制权

Harness 仍持有宿主会话与权限体系；Commander 持有外部执行资源及原生句柄映射，原生引擎持有自己的会话历史。不建立第二套 Harness 会话或推理循环，也不将外部审批冒充为 Harness 工具审批。

服务通过 Provider 注册与事件订阅组合会话 create/discover/connect、submit/steer/interrupt、approve、close。操作能力必须由 Provider 声明；只读客户端不获得写入和审批权限。

每个会话使用单写入队列和输入幂等标识，多端并发审批仅接受第一次有效决议。外部原生审批应绑定 Provider、会话、运行及请求 ID；必要时与 Harness 授权组合，两层都满足后才执行。事件区分持久记录和临时增量，断线后通过快照与游标恢复，不重复提交任务。

## 实施顺序与验收

1. 验证外部 Cordis 插件加载、服务注册、客户端视图及权限扩展接口。
2. 先打通 Codex 的创建 → 流式输出 → 审批 → 中断 → 原生恢复，再接 Claude Code、Pi、OpenCode。
3. 完成历史发现、统一时间线、进程清理、崩溃恢复与 Agent 间委派。
4. 接 Link / Voice，验证双端同时输入、重复审批、网络重连和服务重启。

每个 Provider 必须用真实引擎验收多轮会话、工具批准/拒绝、中断后继续、服务重启恢复、原生身份保持与资源释放；不以模拟进程通过测试代替真实接管成功。

## 项目选择、模型菜单与对话整理

- 添加项目支持服务器文件夹浏览及名称搜索，无需输入绝对路径；本地官方 Desktop 另可调用系统选择文件夹窗口。
- GitHub HTTPS 地址可克隆到当前 Profile 的 `workspaces/<repo>` 并自动注册为各工具共用项目。同名目录拒绝覆盖，私有仓库使用宿主既有 Git 凭据。
- 同一模型弹窗内先选工具、再选模型，选择与持久化复用官方 Harness；初始页隐藏探索品牌，输入框与消息仍使用官方 UI。
- 收起侧栏以同轴图标导航；导航图标使用本地 Iconsax Linear/Bold 及选中动效，来源和 MIT 许可位于 `client/assets/iconsax/`。
- 对话菜单提供归档、恢复及删除。删除只移除列表和 Commander 管理记录，不删除原生工具历史、服务器日志或项目文件。运行中的会话需要先停止。
## 本地字体

界面及正文默认使用用户提供的阿里妈妈方圆体 VF，字体位于 assets/fonts/。
生产环境使用按 Unicode 分包的 WOFF2、swap 显示与私有长期缓存，不内嵌字体到 JS，不请求第三方字体服务。
保留 200–700 可变字重，代码区等宽字体及用户显式字体设置优先级保持原样。
原始 TTF 不进入生产 npm 包；重建方法与字体来源见 assets/fonts/README.md。

## Harness 工具管理

设置 → Harness 工具：检测工具，隔离安装/卸载，引用官方模型供应商，选择模型和协议，编辑高级 JSON，预览后备份应用或恢复。原生外部安装可以使用，但不提供删除其安装文件的入口。

新增 Gemini CLI、Hermes、Grok Build、MiniMax Code 的 ACP 接管；Claude Desktop 和 OpenClaw 当前支持配置管理，不提供会话接管。Desktop 自动安装、代理转换/故障转移、MCP/Skills/Prompts 同步及 CC Switch 数据迁移仍待实现。详细矩阵见根目录 Design/CCSwitch替代实现进度.md，适配器契约见 TOOL-CONFIG.md。
