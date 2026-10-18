# Link 入口与移动端实现记录

日期：2026-10-16。本文记录实际实现，需求与未完成验收见 [开发清单](Link首版远程管理开发清单.md)。

## 目录与交付关系

```text
plugins/commander/          DSH-Plus 安装单元，复用官方 Desktop / Web
  client/                  现有桌面界面及 Link 设置挂载
  lib/link.mjs             构建生成、可独立加载的 Link 服务
  lib/link-web/            构建生成、随插件交付的移动网页
plugins/link/
  src/pairing/             短时配对、设备令牌哈希、持久化
  src/transport/           HTTPS 监听、证书和请求校验
  src/session/             官方会话与旧 Commander 直接会话适配
  client/                  桌面设置、共享移动 React 界面及原生桥接
  mobile/android/          Kotlin App、OkHttp、Keystore、扫码
  config/                  用户自建公网反代示例
  scripts/                 Web 构建
  test/                    自动测试及可选真实 Harness 联调
Design/                    设计与实现记录
artifacts/                 本地插件包 / APK / Windows EXE，分类存放、二进制不提交 Git
deepseek-harness/          锁定版本的官方子模块，未修改源码
reference/                 只读参考，不参与依赖、打包或上传
```

用户只安装 DSH-Plus，Link 服务随插件加载、默认不监听网络。源码中分目录维护，安装包不依赖相邻源码目录。Android 使用离线共享页面及原生网络传输；没有直接复用 Remote 的账号、Relay 或 React Native 工程。

## 连接与权限

2026-10-17 移动端第三轮：连接后默认显示跨项目「最近」，按真实更新时间分组，支持项目/会话搜索和运行中筛选。左侧抽屉统一最近、新会话和连接管理入口，取消底部导航和首页项目卡选择；仅新建会话选择工作位置与模型，默认推断最近有效项目。最近列表、聊天和抽屉共用现有 Iconsax 与 Commander 中性配色，支持整页深浅主题、焦点约束和 Escape；聊天保留各会话草稿与发送幂等重试，阅读历史时不强制滚到底部。

2026-10-17 移动端第四轮：真实连接后转入同源 `/link/workbench/`，复用同一 Harness 网页入口、会话、输入/斜杠命令、模型、权限预设、内置插件、Harness 工具及 Voice 设置，不再复制移动端会话/配置界面。网页侧使用官方组件和共享状态，Commander 仅添加可逆的窄屏工具栏、侧栏抽屉和设置视口适配；Android 配对页成功后移除 JS bridge 并加载受限来源的工作台 WebView，精确校验 TLS/SPKI 和麦克风权限。

工作台通过配对设备 Bearer 令牌签发 `/link/workbench/` 限定的 Secure、HttpOnly、SameSite=Strict Cookie；API 及官方 Gateway 流沿用设备独立 Peer，不能访问 owner 设备管理接口。撤销设备会同步清除 Cookie、取消请求/流并释放 Peer。设备因而拥有完整可信个人工作台权限，而非窄范围会话只读接口。

移动编辑器允许在发送或其它后台请求期间继续输入。未确认消息保留原正文和幂等编号供重试，后续草稿独立保存；中文 IME 输入提交和可视视口键盘适配已经覆盖。真实公网 Chromium 配对实测成功加载共享工作台，`/help` 草稿输入及语音/模型/插件/预设设置入口正常呈现；390px 页面无横向溢出。Android Kotlin 编译通过，未连接实体手机；Android WebView 麦克风、相机、软键盘和 iOS Safari 仍待实机验证。APK 未重打包，旧 APK 不包含远程共享工作台桥接。

交互参考本地 Paseo 提交 `d57096a4568cd2db106f35a0c5011627de53a646` 的移动侧栏分层和会话结构；结合 Codex 式会话优先布局，未复制参考仓库源码，也未修改官方 Harness 子模块。`/mobile` 兼容入口跳转至真实 `/link/` 配对流程，已有设备身份可直接进入完整工作台。

2026-10-17 第二轮：公网 HTTPS 页面默认复用当前域名配对，本地 Desktop/私网页面默认 LAN；用户可在高级设置手动切换。当前云实例把 `/link/` 反代到独立 Link 端口，验证上游证书，放行该路径的移动访问而保留主工作台 IP 限制；不再要求手机直连服务器 IP 的 48721 端口。网络超时只能证明这条路径未连通，不能据此断言证书错误或 LAN 不可用。

移动端配对、工作台、会话、模型和聊天统一为紧凑深浅色界面；`/mobile` 现在直接复用 `/link/` 真实配对和设备授权流程，不再展示与完整工作台不一致的模拟页。Android 离线入口仍使用本地配对界面和真实 LAN runtime。远程连接入口/弹窗统一官方 Iconsax，修复缺失资产回退和双层图标，备用配对码限宽省略并提供完整复制。Android 专用扫码页支持相机权限与失败恢复。

桌面入口是「设置 → 远程连接」。默认点击「连接手机」即可自动启用 Link、选择地址并生成带真实 TLS SPKI 的二维码；用同一网络下的 Android Link App 扫码，再在桌面允许设备。监听地址、端口、手动地址选择及公网 HTTPS 收在折叠的「高级设置」，默认不向新手展示 IP 列表。Android 校验固定公钥、证书有效期与配对主机。公网填写自有 HTTPS 根地址，网页与 `/link/api/` 保持同源；App 公网连接使用系统信任链和主机名校验，iPhone 浏览器使用公网 HTTPS。保存公网 URL 不等于部署成功，不自动建立 NAT 穿透。

2026-10-17：连接候选过滤 Docker/容器网桥、宿主专用虚拟网卡和 IPv6 链路本地地址；IPv4 通配监听只推荐 IPv4，双栈监听优先 IPv4。普通网桥和 VPN 保留，HTTP Host 本机地址白名单不受发现筛选影响。未发现候选时明确报错，不再回退生成 `127.0.0.1` 配对码；本机启用状态不等于手机已可达。

设备通过五分钟单次配对码申请，桌面确认后获得可撤销令牌。桌面管理接口继承官方 owner Connection；公网远端仅有 info / pair / pair-status / rpc 白名单。设备可信权限覆盖所有已注册工作区，界面明确告知，不提供按设备项目 ACL 或任意 Shell 入口。

每设备建立官方 owner Peer，经 Typert Gateway 操作已注册项目的顶层会话；审批和问题通过同 Peer 的官方 `$events` 应答。原生旧 `commander-web:` 会话另做受限适配，不解除 Harness-owned 会话所有权。模型凭据与执行进程始终留在主机。

手机支持项目、模型、会话创建、历史翻页、前台短轮询输出、发送、停止、批准/拒绝与结构化问题。发送重试保留 requestId；断开手机不终止主机任务。Android 一次记住一台主机，切换或地址变化需清除身份后重配；暂无多主机列表、mDNS 和后台保活。

## 已执行验证

- 2026-10-17 移动第三轮：Link 42/42 测试通过，正式 Plus/Web 与独立预览构建通过。浏览器交互验证跨项目最近、搜索、运行中筛选、抽屉焦点与 Escape、会话草稿保留、工作位置/模型选择、新建发送、发送后排序、深浅色、网络恢复和明确的演示配对授权。320/390/768 像素无横向溢出，演示页面无真实 API 请求、无页面错误。
- 正式 `/link/` 使用独立临时浏览器设备完成真实配对、桌面允许、默认最近展示 94 条会话与连接管理入口；测试设备已撤销。此验证不调用外部模型、不替代实体手机与相机验收；APK 仍待前端验收后打包。

- 2026-10-17 第二轮：Link 36 项、相关 Commander 集成 8 项通过；build:plus、独立 build:preview、根 check 和限定范围差异检查通过。
- 无公网 LAN：独立网络命名空间、无默认路由与 DNS 的手机/主机双端，完成真实 TLS / SPKI 校验、错误 pin 拒绝、配对确认、RPC 和撤销后 401；脚本为 plugins/link/test/lan-offline.mjs。这不替代实体手机与路由器验收。
- 云端真实反代完成浏览器配对、桌面批准、读取 2 个项目与 69 个模型、撤销后 401；使用标准证书校验，测试设备已清除。联调通过本机域名解析访问反代，尚未证明用户手机蜂窝网络链路。
- /mobile 浏览器交互通过扫码演示、桌面允许、进入工作台、发送、失败恢复和深浅色；320 / 390 / 768 像素无横向溢出，无真实 API 请求或 JavaScript 页面错误。此入口是界面预览，不保存真实配对。
- 桌面远程连接弹窗经浏览器检查：320 / 390 / 1280 像素无横向溢出，备用码 overflow 为 hidden，没有可见的重复 Bold 图标层，Escape 可关闭。
- Android 本轮离线 compileDebugKotlin、配对解析 25 项 JVM 断言及错误映射 10 项断言通过；新增云端 HTTPS 二维码支持，保留局域网 SPKI 校验。既有 APK 尚不含本轮改动，待预览验收后重新打包。

- 2026-10-17 新手连接流程调整：Link 23 项测试、相关 Commander 集成 7 项测试、`npm run build:plus` 和根 `npm run check` 通过；生成的 Link 服务另经隔离临时监听验证启用、地址过滤、默认配对 SPKI 和停用。未重启用户实例，未新增手机或 GUI 实测。

- Commander 原有自动测试 169 项通过。
- Link 自动测试 16 项通过，覆盖真实 TLS、配对过期与撤销、监听管理、会话归属、输入幂等、审批/问题和原生直接会话；具体数量以当次 `npm run test:link` 输出为准。
- Commander 前端、Link Web 与打包通过；插件包包含 Link 服务、Web 资源及第三方许可。
- 隔离真实 Harness 联调通过 owner 认证、工作区注册、TLS CA / QR SPKI、配对确认、模型/会话创建与幂等、消息、实时文本、最终历史、真实官方审批拒绝及设备撤销。
- 联调模型仅请求本机临时 SSE mock，没有调用外部模型，也没有改动现有服务。测试审批拒绝后不启动原生 CLI。
- Android `assembleDebug` 真实构建通过，生成验收用 debug APK。
- 2026-10-17（北京时间），Windows Actions `38928099138` 通过完整 EXE 构建、官方运行时校验、打包后 Host 与 Link owner API 联调、NSIS 静默安装及 Plus 自动启用。完整安装包包含官方 DSH + Plus + Voice + Link，详见 [桌面交付](../scripts/desktop/README.md)。
- 根 `npm run check` 通过，仅证明 pin、入口和工作区一致性。官方版本 `0.2.1-alpha.3`，提交 `571902028a75c64c1d767f4ae5fd099485f0ddf0`。

真实联调脚本 `plugins/link/test/live-harness.mjs` 是可选环境测试，不纳入默认单元测试。需已安装官方引擎及含 DSH-Plus 的 Web profile；通过 `LINK_HARNESS_NODE_MODULES` 指向该 profile 的 node_modules，通过 `LINK_TEST_NODE` 指定符合官方要求的 Node。脚本使用隔离数据目录与本机 mock，不读取模型密钥，退出后清理临时进程和目录。

## 尚待验收

历史 Android `assembleDebug` 已真实构建成功，验收产物归类在 `artifacts/android/`；签名与设备验收边界见 [移动端记录](../plugins/link/mobile/README.md)。既有 APK 未包含本轮扫码与界面改动，本轮未重新打包。没有真机完成扫码、相机授权、软键盘、切后台恢复和安装验收。Windows 完整 EXE 已通过 CI 静默安装，尚未人工验收 GUI；macOS 安装、iPhone Safari、用户手机蜂窝网络尚未实测。云端真实反代已完成浏览器配对与 RPC 联调。

本版不提供 iOS 原生安装包、桌面投屏、远程文件编辑、终端、公共中继、VPN、穿透或远程语音。公网需要用户已具备到执行主机的可达路径；家中主机不能仅凭一个域名被手机流量访问。

## 参考与许可

Paseo 参考提交 `d57096a4568cd2db106f35a0c5011627de53a646`；Remote 参考提交 `4a2862d168ee3f99ce226c282a4899bf7427c06e`。仅用于职责与恢复流程参考，Link 未复制 Remote 源码。第三方图标、字体、官方 UI 与构建内联依赖的声明保留于 Commander NOTICE 和 `lib/LINK-THIRD-PARTY-LICENSES.txt`，字体不属于插件 MIT 许可。
