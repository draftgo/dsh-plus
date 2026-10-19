# DSH-Plus 验证记录

## 2026-10-18 · 移动会话、扫码与更新交互修复

- 移动抽屉延后一帧关闭，避免原生点击监听的微任务先于 React 委托导航卸载点击目标；保留官方会话选择与路由。模型名称持续显示，窄屏限宽省略，完整名称保留在 title。Windows 应用菜单两态统一起点；移动新会话辅助面板入口取消桌面负边距，并尊重安全区域。
- 扫码/浏览器二维码链接自动发起配对，保留电脑确认；重复原生通知不重用一次性配对码。手动粘贴仍手动提交，状态、已识别配对码可见，错误可重试。默认设备名为“我的手机-五位随机字母”，本机保留，已有自定义名称继续使用。
- 更新状态读取不占用安装动作锁，迟到响应不覆盖新操作；后端检查任务未释放时继续返回 checking，前端持续查询直至可安装。显示禁用原因，安装失败重试原动作，禁用态不再呈现点击悬浮反馈。
- Link HTTPS 增加 HTTP/2 并兼容 HTTP/1.1，防止直连工作台多个长流耗尽浏览器同源连接池。真实 TLS 测试验证同一连接八条活跃订阅时会话、更新请求与上行消息仍正常；保留设备隔离、Host/Origin 校验与撤销。公网体验仍取决于反向代理的浏览器侧 HTTP/2 配置。
- Link 单元/传输测试 54/54；Commander 移动/侧栏/模型/更新与最终多流定向集成测试 88/88；`npm run build:plus`、`npm run check` 通过。隔离真实 Harness Host + 配对会话联调通过，涵盖认证、TLS/SPKI、更新设置、模型、创建、历史、实时/完成消息与审批拒绝，无外部模型请求。
- Android 本地离线 `assembleDebug` 构建通过，APK 包含本轮扫码与命名修复；`testDebugUnitTest` 为 NO-SOURCE，不能当作 Android 原生单元测试通过。按项目约定未启动 GUI，未做设备视觉验收；本轮修复不包含多主机切换或电脑互连功能。未提交或发布新版本。

日期：2026-10-15。环境：Linux、Node.js 22.22.1。所有真实任务均在临时工作目录执行，未修改主项目或参考仓库。

## 自动测试

早期基线 `npm run test:commander`：20 项通过；当前增量见文末。

- 使用真实官方 Cordis `4.0.5-alpha.2` 加载/卸载插件。
- 使用真实官方 `dsh-tools 0.2.1-alpha.3` 注册、执行、验证输出与卸载工具。
- 验证模型侧会话隔离、真人审批/提问路由、原生问题格式转换。
- 验证双向 Codex JSON-RPC 与 OpenCode HTTP/SSE 协议夹具，包括审批、中断、恢复和版本拒绝。
- 验证本地 JSONL 客户端在 wait 未返回时仍能回答审批。
- 验证并发输入、重试去重、磁盘写入失败、审批超时、旧连接事件隔离、有界回放及单拥有者锁。

协议夹具由本项目编写，不代表真实工具的完整兼容性。

## 原生命令增量验证（2026-10-15）

新增服务接口 `Commander.commands(id)` 与 `Commander.command(id, {name, arguments?, requestId?})`。命令使用原生目录与独立执行映射；未知命令明确拒绝，不作为普通 prompt 执行。

针对性命令：

```sh
node --test plugins/commander/test/commands.test.mjs plugins/commander/test/runtime.test.mjs plugins/commander/test/codex.test.mjs plugins/commander/test/opencode.test.mjs plugins/commander/test/web.test.mjs
```

此次上述针对性测试 26 项通过（包含并行任务新增的 Web 会话导入验证）。

- Codex 夹具验证 `skills/list`、原生 skill 输入、`thread/compact/start` 与完成通知；非法 compact 参数在分配输入收据前拒绝。
- Pi 夹具验证 `get_commands`、带自定义压缩说明的 compact RPC、`agentInvoked:false`、旧版缺少该字段时的状态确认、原生命令输出；已收到 `agent_start` 时不因错误的 false 提前宣告空闲。
- OpenCode v1 夹具验证认证后的目录、command、compact/summarize 路由及 SSE 完成；未明确选择模型时在分配收据前拒绝压缩。命令和压缩使用较长请求窗口，避免沿用普通控制请求的 30 秒上限。
- 共用运行时验证命令/消息互斥、同 requestId 并发仅执行一次、命令与消息收据不可混用、不确定执行重试以及重启后不重复提交。
- Claude 命令目录和执行沿用 SDK `supportedCommands()` 与持续输入；增加无模型回合的零 token 结果展示。此次没有 Claude 专用协议夹具，也未进行真实引擎命令验收。

以上新增原生命令能力均未进行真实模型验收；此前 Codex/Pi 的真实聊天、委派与恢复记录不能代替本次命令验收。Codex 本地 custom prompts/goal、Pi autocompact 的额外映射和完整原生 TUI 命令对等仍未实现。参考源码：Paseo `d57096a4568cd2db106f35a0c5011627de53a646` 的 `packages/server/src/server/agent/providers/` 四工具适配器。

## 真实工具

| 工具 | 版本 | 已验证 | 结果与边界 |
| --- | --- | --- | --- |
| Codex | 0.159.3 | app-server 握手、真实文本增量、首轮完成、服务重启、保持 thread ID 恢复、第二轮正确引用前轮 token | 通过；首轮测试第二轮超过 60 秒，扩大等待窗口后完整通过，不能据此保证响应延迟 |
| Pi | 0.73.1 | RPC 握手、真实多轮文本、服务重启、原生文件恢复、确认工具请求后执行指定 `printf COMMANDER_TOOL_OK` | 通过；代理必须提供 undici 支持的 HTTP/HTTPS URL |
| Claude Code | 2.1.286，Agent SDK 0.3.300 | SDK/CLI 初始化、取得原生 session ID | 握手通过；真实模型回复两次在 60/120 秒窗口超时。直接运行原生 CLI 也连续出现 api_retry 并在 35 秒截止时无回复，说明问题也发生在插件之外；具体 API/账号/网络根因未确认。未验收真实多轮、恢复与工具审批 |
| OpenCode | 本机未安装 | v1 HTTP/SSE 适配器的本地协议夹具 | 未进行真实引擎验收；不支持 v2 |

真实模型测试使用原有 CLI 账号配置，未读取或输出凭据值。Claude 失败不标为成功；适配器现已向用户发布 provider.retry 状态。

## 未验证

- 在官方 Electron Desktop 中实际安装、运行和渲染审批/提问。
- 全量上游测试套件、完整 Paseo 功能对等、Link 远程客户端与 Voice 语音插件。
- macOS / Windows 行为，尤其原生工具路径与进程树清理。
- 对其他程序中正在运行的 CLI 进行热接管。
- OpenCode v2 与 Claude/OpenCode 的真实原生跨引擎委派。

官方 `deepseek-harness/` 源码保持未修改；当前插件独立安装到 profile 后才参与运行。

## Web 与项目制验收（2026-10-15 补充）

- 已在官方 `dsh web` profile 加载实际 `dsh.client` 包，通过真实 Chromium 验证侧栏项目、工具图标、新建会话、模型选择、消息发送和渲染，无 pageerror。
- 真实 Codex `gpt-6.1-sol`：浏览器选择项目与模型，发送只读测试消息，实际得到 `COMMANDER_WEB_OK`；直接链路不经过 DeepSeek API。
- 真实 Codex → Pi：Codex 使用 dynamic tool 请求委派，浏览器 owner 接口模拟人工批准指定测试任务，Pi 在同一目录回复 `COMMANDER_CHILD_OK`，结果回到 Codex，父/子均正常完成。
- 真实 Pi → Codex：Pi 扩展工具进入人工确认，随后进入委派确认，Codex 完成指定只读测试并回传，父/子均正常完成。
- 实际服务重启后，从网页重新连接 Codex，保持原生 thread ID 并真实返回 `RESTORE_WEB_OK`。桌面及 390px 宽浏览器均进行了页面截图检查。
- Codex、Pi、Claude 的原生模型目录已成功读取。Claude 的模型目录成功不代表其真实模型回复已恢复；此前响应超时的限制仍保留。OpenCode 本机未安装。
- 20 项自动测试包含共用官方项目、直接会话提交、断开恢复与原生身份保持、归档恢复、委派批准/拒绝、继承目录、跨父会话拒绝读取，以及 loopback capability 缺失/伪造/撤销后的拒绝。
- `npm --prefix plugins/commander run build:client`、`npm run test:commander`、`npm run check` 已通过；未修改官方子模块源码，未重跑全量上游测试。通过官方前端插件接口加载自有客户端，不需要重编译官方引擎。
- systemd 改为直接启动官方 profile 进程并使用 `KillMode=mixed`，已验证服务重启正常释放 DSH-Plus owner.lock，保留原生历史与句柄。

测试任务没有修改项目文件。测试会话标题包含验证标识，可从 UI 归档。项目共用只代表同目录、同项目注册，不代表上下文合并、文件冲突自动解决、Git worktree 隔离或完整 Paseo 功能对等。


## 官方聊天界面与命令适配增量（2026-10-15）

- 当前 `npm run test:commander`：43 项通过；包括真实 Cordis/LLM runtime 注册、流投影、人类消息筛选、持久去重、取消/卸载清理、子会话隔离与官方会话绑定。
- 已撤除 DSH-Plus 独立主面板、输入框及消息列表；通过真实 Chromium 验证四工具及模型进入官方模型菜单。新聊天复用官方启动页，空白 Harness 会话不显示侧栏，不启动原生会话。
- 已在官方 UI 实际验证 Codex 首发与第二轮回复，DSH-Plus 会话数量及原生 thread ID 保持不变；无独立 composer，无 pageerror。响应可能超过一分钟，未承诺延迟。
- Sidebar 改为项目/最近、单行标题、工具图标和搜索；无浏览器视觉验收，审美由用户验收。
- 官方 UI `/native` 已真实读取 Codex skills/compact 目录；官方停止按钮已真实中断 Codex native turn，无 pageerror。
- 四 Provider 新增命令目录与命令派发的协议测试。Codex skills/compact、Pi get_commands/compact、Claude supportedCommands/slash、OpenCode command/summarize 分别适配；并非任意 TUI 命令完整等价。
- 当前官方接入仅文字；原生工具详细事件尚未投影到 Harness 轨迹，旧会话文本尚未迁入官方 journal。Electron、Claude真实回复、OpenCode真实引擎与四工具全部命令尚未完成端到端验收。
- 官方模型菜单提交完成前发送可能沿用旧模型；测试需等待菜单关闭与触发器更新。未修改上游源码。


## 紧凑侧栏交互验收（2026-10-15）

- 构建插件客户端并重新加载现有 Web 服务；真实 Chromium 验证无账号菜单，设置按钮直接打开官方弹窗，折叠侧栏下仍可打开。
- 官方插件和自动化入口仍能切换原面板；新聊天、搜索过滤及清空恢复可用。列表 scrollbar-width 为 none，侧栏横向 padding 为 6px；未进行截图审美验收。
- 使用浏览器响应替换模拟 DSH-Plus running → waiting → idle，验证全局图标及 CSS 动画随状态出现、切换和消失；这项测试没有启动真实模型。
- 390px 页面宽度无页面横向溢出；未发现 pageerror。原生驱动未改动，未重跑真实模型与全量上游测试。

## 模型、项目选择与侧栏增量（2026-10-15）

- 当前插件测试 55/55 通过，包含目录过滤、GitHub 地址校验、Profile 工作区克隆、重名保护、失败清理、并发限制、归档删除与持久恢复。
- 真实 Chromium 验证同一弹窗工具→Codex模型→选中、探索品牌隐藏、侧栏图标对齐、删除确认取消、服务器目录搜索及上下级导航、GitHub表单、归档→恢复→删除闭环、收起侧栏与390px无横向溢出，无 pageerror。
- 真实 GitHub `octocat/Hello-World` 在临时 Profile 克隆成功，检查 `.git` 并清理临时数据。没有向用户项目目录写入测试仓库。
- 桌面选择文件夹复用官方 bridge，未进行 Electron 系统窗口端到端验收。此次未重新验证 Claude/OpenCode 真实模型、附件及原生工具轨迹。
## 本地字体（2026-10-15）

- 原始 TTF 7,411,920 字节，转为 87 个 WOFF2 子集，共 1,977,576 字节；Latin 子集 14,956 字节。全部 7,017 个字符保持，字重轴 200–700。
- 真实 Chromium 首次加载当前页面使用 33 个子集，全部解码成功；再次刷新字体资源 transferSize 全部为 0，命中缓存，无 pageerror。
- 官方文字字体变量正确使用 Commander FangYuan；代码字体仍为原有等宽栈。字体 swap 显示，不阻塞文字；首次显示仍有下载和解码开销，不承诺绝对零开销。
- 插件测试 56/56 通过，新增字体路由 WOFF2 签名、固定路径及私有长期缓存验证。官方引擎保持干净。


## 侧栏与模型选择视觉修正（2026-10-15）

- 对话搜索位于顶部工具栏后、插件/自动化入口前；选中态保留线条图标。
- 项目/最近使用整行 32px 点击区和 12px 标题，折叠状态保存在浏览器；折叠内容 inert，不进入键盘焦点。两者均折叠时分栏间距 3px。
- 分栏与单项目箭头仅由展开状态决定，取消通用悬停位移对箭头的干扰。
- 官方侧栏宽度过渡沿用其状态生命周期并优化曲线；归档列表 110ms 淡出、180ms 淡入，支持系统减少动态设置。
- 会话操作使用官方 body portal Modal，列表高度不变；包含归档/恢复、删除、复制对话 ID。复制 JSON 明确区分 Harness、DSH-Plus、原生工具 ID，另含工具、模型、父会话及项目路径；复制权限失败时提供可选中文本，排除凭据和事件。
- 模型搜索与工具标题同行，输入移除原生硬描边，保留柔和键盘焦点；返回标题横向 8px、模型按钮横向 10px 内边距。

验证：58/58 插件测试通过，build:client 与 npm run check 通过。服务重新部署且 active。Chromium 实页检查搜索位置、整行点击、折叠高度 0/inert、3px 间距、悬停箭头矩阵不变、归档 out/in 阶段、操作弹窗不改变列表高度、复制剪贴板 JSON 和 Escape 关闭；无 pageerror。模型选择组件由独立 Chromium DOM 检查确认标题与搜索同行、outline none 和两处横向 padding。未进行本次真实模型调用或全量上游测试。官方子模块源码保持 clean。


## DSH-Plus 状态与浮动菜单（2026-10-15）

- 产品显示名称改为 DSH-Plus，通过导出的 en/zh-CN locale meta.title 提供官方插件管理显示文案；包名、目录、持久化数据与工具契约保留兼容标识。
- 会话行左侧原工具图标在运行/连接时替换为绿色心跳圆环，等待授权/提问时黄色，失败红色，空闲恢复工具图标。16px 固定位置，不在标题右侧重复显示三条波纹。官方 uiSession.pendingInteraction 参与等待状态判断。
- 更多操作复用官方 Menu 的 portal/right 定位，不使用蒙层，保留复制完整信息、归档、删除确认；支持方向键、Escape、外部点击和视口避让。删除仍保留二次确认。
- 归档入口移至设置行右端，最近分栏右端改为 Iconsax edit 新聊天入口，折叠侧栏仍可进入归档。
- 原生授权与交互共用 waiting；修复原生提交失败路径的 pending 清理，增加并发审批/提问、完成失败及提交失败测试。

验证：61/61 插件测试通过，前端构建与 diff whitespace 检查通过；服务已重启 active。Chromium 实际页面检查归档位置/切换、新聊天入口、无蒙层菜单在按钮旁、剪贴板复制、Escape/外部点击关闭和三色16px圆环样式，无 pageerror。圆环样式通过临时 DOM 检查，未在生产会话人为触发真实授权/失败；四工具真实授权端到端未重跑，OpenCode 限 v1。官方子模块无源码改动。

## DSH-Plus 内置语音与用量（2026-10-16）

- Voice src/client/test/locale 已并入 voice/，独立包、安装链接及重复 profile bundle 已移除，当前技术包为 `dsh-plus`。
- 客户端构建通过；usage + codex + plugin 8/8 通过。覆盖累计计数差分、去重、未知字段、日期边界、持久化白名单、官方继承/路由防重及跨站拒绝。
- npm pack --dry-run --ignore-scripts --offline 通过，包含 voice/src、worklet 和内置文档；135 files，约 2.1 MB。
- 未做视觉验收、真实音频调用与真实工具账户用量对账；本次整合已重启服务。

### 本次整合补充

- 原独立 Voice 合入 DSH-Plus，原配置目录继续保留兼容；语音设置采用三个独立页签与弹性 segment 动效。
- 供应商管理复用官方 ModelsSection、凭据、发现和设置写入流程；插件仅适配选择器和 RouterGo 预设，不保留第二套 CRUD。构建时内存适配位置严格校验，升级官方引擎后需重新构建验证。
- 语音通过只读桥接解析官方供应商，密钥仅供服务端使用。RouterGo 真实模型发现返回 41 个模型，11 个按元数据/名称筛为语音模型；此结果不代表音频协议或音质已完成验收。
- 朗读独立喇叭图标开关，悬停提示状态；录音状态动画、字幕、右侧停止，当前输入栏录音期间隐藏发送。动画表示录音状态，不是实际音量测量。
- 用量接口已完成真实鉴权 HTTP 200 验证，读取 24 条历史记录和 4 个分组；统计覆盖本应用已有记录与后续接管工具事件，不自动扫描所有第三方工具数据库。速度是首段文本至完成区间的观测速率，含工具和暂停，不是纯模型解码速度。

最终验证：DSH-Plus 73/73、内置 Voice 42/42 测试通过，客户端构建与 npm run check 通过。Chromium fixture 验证喇叭图标/悬停提示、录音无旧浮层、录音状态动画、右侧停止、发送隐藏及停止后恢复，无 pageerror。仅假麦克风和转录 fixture，不保存生产语音配置或发聊天。

官方模型页运行验证通过：保留原供应商编辑/删除，添加入口仅一个；自定义供应商弹窗展示42项且无原生供应商select，无pageerror。已配置RouterGo不重复提供新增卡片。


### 官方指标与覆盖展示补充（2026-10-16）

- Harness adapter 仅把具有稳定请求标识的单次原生 usage 投影到官方流；Codex inclusive 输入扣除缓存读取后映射为官方互斥桶。回放及多请求回合不补造单次上下文或速度，独立账单继续保留。
- 模型目录实际报告正整数 contextWindow 时，经 resolveModel 透传官方 context；默认及未知模型不推测容量。
- 覆盖状态的纯函数测试区分缺失状态、扫描中、完成、部分覆盖、失败，并覆盖未发现日志、读取异常和扫描上限；保留真实计数，不把缺失等同零。
- focused 测试：harness-usage、harness-adapter、usage-state 共 15/15 通过；client 构建、models/adapter 语法检查及本次文件 diff whitespace 检查通过。未重启服务，未新增真实模型调用；本轮无需视觉验收。


### 全机统计与流式语音最终部署（2026-10-16）

- DSH-Plus 84/84、内置 Voice 54/54 通过；客户端构建、入口检查与 whitespace 检查通过。补齐 dsh-tools 实际导入的 scope/sandbox 精确版本开发依赖，确保安装 ws 后测试仍可复现。
- assistant/attempt 不单独记账，仅贡献同 step 首 Token 时间；原生历史只读导入并去重，缺失指标保持未知。跨预算 JSONL 仅在内存续读，不持久化正文；不完整尾行等待文件变化，避免后台空转。
- 重新部署 dowork-web.service，端口就绪后真实 Chromium fixture 验证图标式通话启停、10px 左内边距的662px录音条、用量弹窗，以及项目展开/收起移出后背景清除；无 pageerror。麦克风/转录使用 fixture，未向聊天发送测试内容。
- 已鉴权用量接口返回200，最终扫描 ready：Codex362文件/15353条、Claude60文件/2466条、Pi112文件/8563条，无读取错误；OpenCode未发现日志。查询时段2026-09-01至2026-10-17，去重后含Harness记录26388条；本机日志持续变化，数量非固定基准。
- 语音支持普通HTTP、MiMo/Step SSE、Step原生WSS。协议、取消与草稿冲突使用mock验证；RouterGo实际Step TTS成功，但ASR探测仍404/503。详细协议边界和实测见voice/STREAMING.md，不能视为真实ASR供应商验收完成。
- 官方子模块保持干净，未跑全量上游测试；真实手机麦克风、外放回声、弱网长通话未验收。

### 用量图表与自动朗读去重（2026-10-16）

- 用量概览将数据来源板块替换为 Token 用量、记录数量两张时间图；使用去重和日期筛选后的全量记录，不依赖历史分页。浏览器时区传给接口，当天按小时、多天按天、长区间按月或年汇总；空档和缺失 Token 明确区分。移除工具与模型表的最大上下文／容量列，并清理废弃来源面板样式与转换函数。
- 用量相关测试 13/13 通过：`node --test plugins/commander/test/usage-timeline.test.mjs plugins/commander/test/usage-ui.test.mjs plugins/commander/test/usage-chart.test.mjs plugins/commander/test/usage-format.test.mjs plugins/commander/test/usage-import.test.mjs`。覆盖全区间汇总、去重、分页独立性、时区、夏令时、空值、空状态和图表可访问描述。
- 语音修复最终成功消息与流式 attempt 的关联，仅补读新增后缀，避免同一回复二次朗读；`npm run test:voice` 81/81 通过。具体根因与回归范围见 voice/VERIFICATION.md。
- `npm --prefix plugins/commander run build:client` 通过，构建产物包含以上用量与语音变更。用量服务与时间序列模块语法检查通过。
- 现有 `usage.test.mjs` 因 tooling.mjs 引用的 `src/session-routes.mjs` 缺失而无法加载，该文件不在本次改动范围；其余上述专项测试正常。未启动图形应用，未做视觉验收或真实 TTS 播放，未重启现有服务。


## 2026-10-16 供应商选择与记录隔离

- 插件完整测试 157/157 通过；前端构建通过。Chromium 实际打开供应商首层、右上工具菜单及 Codex → RouterGo → 23 个模型，无 pageerror。未提交真实新会话或调用供应商推理 API。
- Codex/Claude 托管会话绑定供应商与模型，独立配置/历史目录；A/B 会话、默认变化、恢复、端点变化拒绝、密钥不落会话状态覆盖测试。Codex 真实 CLI 仅离线解析启动覆盖参数。
- 保存新会话默认只写插件状态，全局 CLI 导出需显式确认。部署前后 6 个本机配置/历史路径哈希一致。未覆盖或迁移既有原生记录。
- Pi/Hermes 等未验证隔离的工具保留原生能力，新供应商选择器显示限制；高级非空托管覆盖、角色/备用模型方案尚未开放。Windows/macOS、真实 Claude 供应商连通和跨供应商已有会话分支未验证。

### 用量合并图表（2026-10-16）

- Token 用量与记录数量合并为一张时间图，Token 使用左轴柱形、记录数量使用右轴折线；同一时间点可查看两项数值，保留全日期范围、缺失标记及历史分页独立性。删除原双图网格样式，更新说明。
- 图表、时间序列、用量 UI、数字格式专项测试 8/8 通过；客户端构建通过。按约定未做视觉验收，未重启服务。


## 2026-10-16 · 供应商设置与品牌统一

- 工具设置主表单保留供应商、模型、保存；生效摘要直接展示当前默认供应商和模型，高级字段折叠。
- 工具菜单、确认弹窗、官方入口供应商选择弹窗统一使用官方 bg-layer-2 实底，聊天模型菜单使用相同主题层。
- 模型设置列表/编辑标题/新增供应商、聊天供应商列表、工具设置共用本地厂商品牌标识；未知自定义供应商使用名称首字母。显式传递 declared 标记，避免根据名称误认厂商；内置 deepseek-official 预设保留 DeepSeek 品牌。
- 插件测试 159/159 通过，客户端构建成功；品牌预设补充后定向测试 2/2 通过并重新构建。线上 providers/catalog 接口返回 200，服务重启 active。未发送付费模型请求。
- 浏览器本地转发验收受临时代理 ECONNRESET/加载超时影响，未完成真实页面交互验收；不将该轮当作 UI 通过。
- 未改用户本机工具配置/历史；未修改官方子模块与 reference 源码。

## 2026-10-16 · RouterGo 思考能力与语音交互修复

- 根因分别确认：自定义路由缺少模型思考能力声明，导致 `off` 在本地校验阶段被拒绝；同一 RouterGo 上游的 Messages SSE 缺少 `message_start`，而 Chat Completions 正常。未修改官方适配器、流解析器或官方子模块。
- 模型选择入口不再沿用已失效的 effort；新增无密钥 RouterGo 配置示例及真实官方 LLM runtime / PiAi 插件回归测试。验证能力恰为 off/high，关闭和开启参数到达 SDK 出站请求，缺失声明可复现原错误且没有网络请求。
- Voice 仅发送识别出的用户正文，移除播放状态注记及其文本缓存，保留本地播放 ACK 和插话取消。旧播放器与跨会话异步回调隔离；此前流式/final 重复朗读修复保留。旧历史中的注记不重写。
- 用量、模型选择及供应商定向测试 26/26，新增路由回归 4/4，Voice 84/84 通过；客户端构建成功。本轮 `usage.test.mjs` 已能加载并通过，先前缺失 `session-routes.mjs` 的记录为当时状态，现已解除。
- 真实官方 LLM runtime + PiAi 调用 RouterGo flash：off/high 均有正文并正常 stop；off 实际发送 `thinking: {type: disabled}` 且不发送 `reasoning_effort`，high 发送 enabled + high。两次上游均返回推理内容，不能宣称上游完全遵从关闭参数。
- 本机配置写入前已作权限受限备份；仅修改目标 flash 的 reasoning/compat，停用指向 RouterGo 的畸形 Messages 路由。9 个受影响的闲置旧会话通过官方 selectModel API 改为 routergo/flash/off，保留历史及其他模型选择。确认无运行回合后重启 `dowork-web.service`，认证刷新正常。
- 部署后真实认证接口：默认 routergo/flash/off，模型目录提供 off/high，无供应商失败和遗留畸形路由选择；用量接口 200，所选范围全部 27,389 条记录进入汇总和时间序列，详细记录仍仅返回 50 条；语音配置接口 200。通过页面公开的插件合并资源地址读取客户端，返回 200，包含本次构建产物完整内容（包括思考档位检查和用量图表），没有旧播放注记构造函数。直接访问未公开的单模块地址返回 404，验收使用页面实际声明的资源地址。
- 按约定未启动图形应用，未做真实麦克风、ASR/TTS 或视觉验收。

## 2026-10-16 · 远端加载性能与侧栏选中态

- 只读测量时 CPU 约 90–94% idle、iowait 0–2%，可用内存约 9.3 GB；本机认证首页 TTFB 6–10 ms，未发现资源耗尽证据。项目 state 只取内存注册表/原生会话快照，不扫描项目文件；优化前实测 13–50 ms，官方 session/list 约 120–222 ms、87 条/117 KB。
- 确认插件目录放大：官方 modelCatalog 并发读取 8 个 commander-* provider，每个都重建全目录；provider 列表还逐供应商调用昂贵的 settings.describe()。优化前 session/modelCatalog 连续 13,392/12,551 ms，pickerCatalog 1,499/1,597 ms。修复为每次供应商读取只 describe 一次、并发目录共享在途任务、模型元数据并发解析。无完成结果 TTL，不缓存解析密钥；失败释放任务，返回对象隔离，invalidate 的旧任务不会清除新任务。
- 项目分组改为优先官方 workspaces.list.items，ready 空目录权威；新建会话实时取官方快照。原生状态空闲降为 10 秒，活动保留 2 秒，后台暂停并在返回时立即刷新；无变化不重复通知 React，单次状态请求有超时。
- 修复未打开会话时 undefined ownerSessionId 与 undefined activeHarnessId 相等导致全行选中；样式、aria-current、删除后跳转使用同一身份判断，并排除未迁移子代理跟随父行高亮。JSX 回归覆盖加载完成无活动会话、恢复、切换、官方快照先返回及权威空列表。
- `npm --prefix plugins/commander test` 187/187 通过，客户端构建成功。DSH-Plus 客户端启用 minify，本体由 614,014 B 降为 495,370 B（约 19%），gzip 为 148,858 B。未修改官方源码或依赖。
- 确认无运行回合后更新既有服务；部署后本机认证实测 modelCatalog 为 89/78/82 ms（3 个模型组、0 失败），pickerCatalog 为 72/59/66 ms；项目 state 为 38/14/11 ms，session/list 为 199/148/126 ms。首页与页面声明的合并插件资源均 200，资源内包含本次构建完整字节，服务 active。
- 冷启动仍有独立资源瓶颈：优化前首批 JS gzip 合计 5,300,208 B，解压约 13.39 MB；最大官方组 gzip 4.20 MB，官方账号设置包含约 3.21 MB 的 base64 图片。gzip 与 rev 版本包 immutable 缓存已正常；站点仍使用 HTTP/1.1，带 hash 的 shell assets 缓存可继续优化。本轮未修改 Nginx、访问白名单、官方资源打包和账号功能。
- 远端边界：服务器直连域名被现有 IP 白名单拒绝，未将 403 耗时当真实成功加载；上述成功测量通过认证 loopback 完成，不能替代用户设备网络/解析性能。按约定未打开 GUI 或做视觉验收；没有调用推理模型。


## 2026-10-19 多设备与服务器接入

- 先更新 Design/设备切换与服务器接入.md；设备接口同步 plugins/link/openapi.json。MCP delegation 未改变，不向 Agent 新增切换设备/SSH 凭据能力。
- Link 全套 73/73；Commander 侧栏、移动布局、模型选择、更新定向回归 58/58；新增代理重复切换/长流回归 4/4。
- 隔离真实 Harness：设备中心启动、电脑配对批准、完整代理工作台与 owner API 阻断、会话/模型/审批链路通过。
- 隔离服务器安装器：真实 Host、现有实例复用、SSH 引导授权、升级激活与端口/TLS保持通过；服务载体为 fake systemd，不能代表真实首次联网安装或系统部署。
- 正式 build:plus 与 npm run check 通过；Android assembleDebug、5 项原生单测通过。APK 内前端、服务器压缩包与当前构建字节及 SHA256 一致。
- 官方子模块保持原 pin 未修改；未启动 GUI、未做 Windows/Android 真机验收，未提交或发布。三个子代理均已结束。

## 2026-10-19 小角正式应用与新版 VI

- 应用 0.1.4、DSH-Plus 0.1.6、Link 0.1.2；新版正式 VI 同步 PC 与 Android，应用显示名统一“小角”，内部更新身份与用户数据路径保留。初始化加入左侧小角浮动与右侧 DeepSeek，并保留自动进入、失败重试及减少动态效果支持。
- Commander 全套 351/351、Link 全套 73/73、插件更新与打包 18/18、新品牌/初始化/应用更新/布局定向 25/25 通过；最终 build:plus、npm run check、git diff --check 通过。官方子模块保持原 pin 且 clean。
- Android assembleRelease、lintVitalRelease、5/5 原生单测通过；正式 APK 校验显示名小角、0.1.4/code4、不可调试、持久发行证书匹配，以及最新前端/服务器包/清单逐字节一致。Windows 配置与新旧更新名、LF/CRLF 兼容定向测试 7/7；原生运行、静默安装和旧版原位升级由发布 CI 执行。
- 原生 Windows CI 已完成整包构建及 packaged-runtime smoke；确认英文 Windows 的 WScript.Shell 读取中文快捷方式目标为空，而 IShellLinkW 返回正确目标。改用 Unicode 接口及规范长路径后全新安装、同目录升级、旧 exe 清理与数据保留均通过；另发现升级残留旧品牌快捷方式，补充限定原注册安装目录和旧快捷方式名的迁移清理，全部验证完成前不公开正式版本。

## 2026-10-19 Codex 开箱即用安装

- 更新 Design/Harness工具安装管理.md 与工具管理 OpenAPI；Codex 等 npm 工具缺失或不兼容的 Node.js/npm 自动准备到用户级托管目录，默认国内加速、可选官方直连，不修改系统 PATH、已有工具和用户 npm 配置。MCP 安装权限未扩大。
- 覆盖固定 Node.js 22.22.1 六平台 SHA256、Electron 排除、独立 Node/npm 环境、下载大小/超时、并发共享、取消清理、Windows 无 shell 参数传递及重启复用。会话启动和登录检测传递托管 PATH；版本文本排除前置警告。
- Node 环境、安装生命周期、工具设置交互、owner 接口、登录、Codex 协议与会话路由合计 70/70 定向测试通过。
- Linux x64 真实联网隔离测试：空 PATH、禁用宿主 Node 复用，从国内镜像下载并校验 Node.js，再安装 Codex；安装及重新创建安装器后均能执行 codex-cli 0.163.0。临时安装环境已删除。CLI 在 /tmp 下提示不创建辅助别名，版本与启动验证正常；不将该警告当失败。
- 插件及 Android 构建、资源字节校验完成后交付；Windows/macOS 尚无真实安装验收。未提交、发布或启动图形应用，官方子模块未修改；本次两个协作子任务已结束。
