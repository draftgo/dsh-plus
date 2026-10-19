# DSH-Plus 项目与原生委派

参考 Paseo 提交 `d57096a4568cd2db106f35a0c5011627de53a646`：`packages/server/src/server/workspace-git-service*` 组织项目/checkout，`packages/client/src/connection/legacy-workspaces.ts` 关联项目路径与会话，`packages/app/src/data/provider-icons.ts` 投影 Provider 图标。DSH-Plus 借鉴目录下多工具会话的组织方式，没有复制 Paseo 的数据库、协议或运行服务。

项目复用官方 Harness `workspaceRegistry` 的稳定 ID 和规范化路径；DSH-Plus 会话保存 `projectId`、`cwd`、工具、模型、原生句柄和 `parentId`。既有无 projectId 的记录按规范化目录展示归组。多个工具共享文件目录，不共享上下文，不额外创建 Git worktree；Paseo 的 Git 远程仓库聚合、多 checkout/worktree 管理尚未实现。

客户端仅通过官方 `dsh.client` 和 Slot 定制项目侧栏，使用官方 React、图标和主题变量。新聊天进入 Harness 原始启动页；工具及模型注册到官方 LLM 模型菜单。输入框、消息列表、流式 Markdown、停止、审批和问题继续复用官方交互，不再维护 DSH-Plus 独立聊天页或工具卡片。

发送链路为浏览器官方 UI → Harness Agent → DSH-Plus LLM adapter → 原生 CLI/SDK。原生工具执行自身工具调用，adapter 只投影文字流，不把原生工具事件伪装成 Harness 工具调用，避免重复执行。DSH-Plus 将原生工具活动单独显示在输入区下方，不写入模型消息或 Harness 工具轨迹；完整事件仍保存在 DSH-Plus 日志中。模型选择参考 Paseo `setAgentModel` 和 Codex 每轮 `turn/start.model`（Paseo 参考提交 `d57096a4568cd2db106f35a0c5011627de53a646`）：绑定对话可在原工具、同隔离供应商内切换模型，当前轮完成后应用；切换工具或隔离供应商仍需新建聊天。使用本机默认模型且没有隔离供应商身份的旧会话不能切换到托管供应商模型。当前支持纯文本，不接受附件。标题生成等辅助请求不会启动原生任务；原生压缩使用 `/native compact`，不冒充支持 Harness 的辅助压缩请求。

点击新聊天会创建或复用官方空白 Harness 会话，但侧栏不显示空白项，原生进程与持久原生会话在首次发送时才建立。多轮按 Harness 会话、工具、模型和目录复用原生句柄，使用持久消息 ID 去重。切换模型会选择另一条原生上下文，不承诺不同工具上下文自动合并。

原生命令通过官方 `/native` 入口列出，`/native 命令 参数` 执行；服务与 CLI 也可调用 commands/command。实现参考 Paseo 四种 Provider 的独立命令发现/派发方式，不将所有 slash 命令都当作通用文本。支持范围以插件 README 为准。

旧版直接会话及已完成的委派子会话可从侧栏打开并绑定新的官方 Harness 对话，保留原生句柄；旧文本尚未导入 Harness journal。运行中的旧会话/子会话不能迁移。委派子会话保留 parentId，未接手时不会被误选作父对话的原生上下文。

原生委派入口为 Codex dynamic tool、Claude Agent SDK 配置的 stdio MCP、Pi 扩展工具、OpenCode 启动级 MCP 配置。后两种 MCP 与 Pi 扩展通过只监听 loopback 的 capability bridge 请求委派；随机凭证只进入该原生连接的环境变量，连接断开撤销。委派先人工审批，再锁定父项目路径创建子会话；子会话原生工具操作仍独立请求审批。

调用 `commander_delegate` 使用 provider/text/model 创建任务，使用 operation=result/sessionId 查看自己的直接子任务。结果等待有上限，超时返回 pending 并保留子会话，不能视为失败后自动重建。嵌套深度和每父会话数量设上限；模型没有自我批准接口。CLI 独立模式没有 Web capability bridge，Harness 对话创建的原生会话仍由原 Harness 会话控制。

此前已实际验证 Codex 直接网页回复、Codex → Pi 和 Pi → Codex 的人工审批及结果回传。本轮已验证官方 Harness UI 下 Codex 首发及连续回复保持原生 thread ID、空白聊天不创建原生会话、无独立输入框及前端 pageerror。Claude 真实回复与 OpenCode 原生互通仍需要独立验收；已有协议适配不代表四种引擎均已通过真实端到端测试。移动直连、实时语音、任意活跃终端热接管与完整 Paseo 功能对等均不属于当前已实现范围。


## 侧栏工具栏与运行反馈

左上角去除品牌展示，使用紧凑的新聊天/搜索工具栏；官方插件及自动化任务入口保持原面板，压缩为同一行。列表隐藏滚动条并缩小横向留白，仍可滚轮和触摸滚动。底部通过 `settings.launcher` 扩展位直接调用官方 `openSettings`，不再出现账号“更多”菜单；保留官方设置壳和连接指示器。

全局工具栏按实际活动 Provider 显示图标及运行节拍，项目与会话行同步显示运行/等待状态。DSH-Plus 状态沿用现有两秒轮询；官方 Harness 活动状态来自会话列表订阅。搜索过滤、项目折叠不会移除顶部全局活动显示。点击 Harness 所属原生任务的顶部图标会打开拥有它的官方对话，委派仍由父对话控制。

动效包含运行节拍、等待确认呼吸、活动行扫光、项目展开及按钮交互反馈。遵循 `prefers-reduced-motion`，关闭动效后保留静态状态。外层工具栏几何通过插件限定的官方 Sidebar CSS 选择器调整，升级官方引擎后需要重新验证对应结构，未修改官方源码。

## 项目选择与界面增量（已实现）

添加项目统一为一个弹窗：

1. **浏览目录**：从宿主主目录开始，显示子文件夹，支持当前目录名称搜索、进入下级、返回上级及主目录。路径仅供辨认，无需手填绝对路径。网页浏览的是运行 Harness 的服务器文件系统。
2. **桌面选择文件夹**：检测官方 `__DSH_DIRECTORY_PICKER__.pick()`，调用 Electron 系统窗口；取消不创建项目。仅官方本地 Desktop 提供此能力，远程浏览器不显示无效入口。
3. **GitHub 仓库**：输入 HTTPS 仓库地址，克隆到当前 Profile 的 `workspaces/<仓库名>`，成功后注册到官方 `workspaceRegistry`，各工具使用同一个项目目录。同名目标拒绝覆盖；失败清理临时目录。私有仓库依赖宿主已有 Git 凭据，不在地址中接受 token。

参考仍为上述 Paseo 版本的项目/checkout 组织方式。此处未实现跨全盘递归索引、GitHub 登录或完整 worktree 管理。真实 GitHub 克隆在临时 Profile 验证；Electron 系统窗口尚未进行本机端到端验收。

模型选择在同一弹窗内使用工具 → 模型两级，复用官方模型目录与选择持久化。初始页去掉探索品牌、鱼标及预览文案，保留官方输入框与工作区控件。导航和新增界面使用插件本地 Iconsax Linear/Bold 图标，保留工具品牌标识，选中态与过渡遵循减少动效设置。

侧栏收起后仅展示同轴图标及运行状态；搜索可展开侧栏，新聊天没有重复文字。对话行不显示原生 title 提示，功能按钮使用统一 Tooltip。对话菜单支持归档、恢复及删除；删除指从列表移除、清理 DSH-Plus 管理记录，保留服务器日志、原生工具历史及项目文件，运行中必须先停止。

## 2026-10-19 客户端稳定性与移动安全区修正

- Windows 侧栏的非 JSON 响应须追溯到插件接口注册与桌面转发链路；基础侧栏路由不依赖原生委派桥监听成功，桥故障需明确报告并限制在委派能力，不能导致基础接口消失；打包 smoke 需实际请求侧栏 state/ensureRecent，不能以 Link 管理接口可用代替侧栏可用。错误提示需保留真实 HTTP 状态与接口位置，不能把异常吞掉或伪装空数据。
- 移动设置仍复用官方 SettingsRoot，通过自有构建适配给 overlay 添加稳定类名。外层按可视视口高度及四边 safe-area 留出空间，内部面板填满可用区域，关闭按钮相对面板定位。键盘压缩视口时设置内容内部滚动，桌面布局不变。
- Android 由原生布局统一消费系统栏/刘海/键盘 insets，WebView 内容区不重复避让；网页浏览器继续使用 env(safe-area-inset-*)。系统栏主题同步见 Link 实现记录。无 MCP/OpenAPI 契约变化。

验证记录：前端定向回归 57/57、服务端/HTTP/侧栏状态回归 61/61、移动既有连接流程 17/17、桌面打包配置 9/9 通过；build:plus 与根 check 通过。故障注入证实 loopback EACCES 和字体缺失不再移除基础侧栏接口。Windows 用户环境的具体触发条件尚未拿到日志，未声称已在其机器复现；原生 Windows packaged smoke 尚待运行。本轮隔离全链路 live-harness 因 socket hang up 未完成，不能视为端到端通过；未修改或重启用户既有实例。
