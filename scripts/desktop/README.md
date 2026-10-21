# DSH-Plus 完整 Windows 安装包

交付目标是一个 `xiaojiao-<应用版本>-win-x64-setup.exe`：含官方 Electron Desktop、固定版本完整运行时、DSH-Plus、Voice、Link 和插件生产依赖。安装器用内置 Electron Node 初始化用户 Desktop profile，不要求用户安装 Node、CLI 或手动安装 Plus。

## 目录与职责

- `package-windows.mjs`：调用官方构建、运行时准备与 NSIS；不改官方源码。
- `plugin-bundle.mjs`：以 npm 发布白名单复制插件与依赖，复用官方服务，安装时离线登记或升级组合 bundle；清理已确认身份的顶层旧插件遮蔽，保留更高版本与用户禁用选择。
- `seal-runtime.mjs`：注入后通过官方 writer 重建完整文件哈希与共享包清单。
- `electron-builder.config.mjs`：扩展官方配置，独立 appId / 产品名，预览关闭自动更新与强制升级策略；不引用官方更新服务。
- `prepare-brand.mjs`：从 `assets/brand/` 生成小角 Windows、托盘、安装/卸载图标，官方源码保持不变。
- `prepare-tray.mjs`：官方完整构建后复用官方 tsdown 主进程配置，仅在编译输入中将 Windows 托盘菜单改为“主窗口”“退出”（英文 Main Window / Quit），并接入启动卡片。编译结果写到 `.local/desktop/main/`。electron-builder 会丢弃应用目录外的 from/to 映射，因此只在收集 asar 文件时临时换入 `apps/desktop/lib/main.js`，收集后立即恢复官方产物。不修改子模块源码，不运行时拦截。官方模块、配置或文案锚点变化立即中止打包。
- `renderer/`：打包时通过官方文件映射替换初始化页面，只展示小角和工作台准备状态，通过已有 `dshWelcome.skip()` 进入工作台；失败可重试，不写入虚假凭据或登录状态。模型凭据在工作台内配置。
- `prepare-startup.mjs` / `startup-window.mjs`：复用根目录主进程编译步骤，在官方 `main()` 开始时加载 420×300 小角启动卡片，覆盖后端初始化等待；其他窗口显示、致命错误或退出时销毁。编译锚点变化中止打包，不修改上游源码、不做运行时拦截。仅正式 Plus Windows 打包入口接入，普通官方 dev/start 不变。
- `renderer/splash.html`：本地 Logo、墨黑描边与冷青 loading，不显示虚假百分比，不设最低停留时长；20 秒后提示仍在准备，支持减少动效。卡片只能在 Electron ready 后显示，无法覆盖操作系统加载 exe 的阶段，也不缩短实际初始化时间。

启动卡片验证：`node --test scripts/desktop/startup-window.test.mjs scripts/desktop/startup.test.mjs` 覆盖窗口显示/销毁、失败回退、编译锚点和页面重试；主进程编译与打包映射复用 `prepare-tray.test.mjs`。2026-10-20 已通过定向测试和实际主进程编译（当前 Node 22 使用仓库 tsx loader）；未生成新 Windows EXE、未实跑 Windows GUI。
- `smoke-windows.mjs`：验证打包资源、官方 Host 启动、离线配对 profile 初始化与认证 Link 管理接口。
- `test-install-windows.ps1`：CI 静默安装、旧实体残留重装修复与原位升级；通过官方解析器验证实际插件元数据、入口及客户端路径。

官方完整运行时放在 `resources/app.asar/dsh`，Windows 物理文件解包到 `resources/app.asar.unpacked/dsh`。额外安装初始化脚本放在 `resources/dsh-plus/`。构建产物按 `artifacts/windows/` 分类，不提交二进制。

## 构建

必须使用原生 Windows x64（推荐 Node 24）、官方锁定的 pnpm、Python、Visual Studio C++ Build Tools 与 Windows SDK。不能在 Linux 上把一个插件包改名为 EXE。仓库的 `DSH-Plus Windows installer` Actions 使用 `windows-2022`，可手动触发。

```powershell
npm run setup
npm ci --prefix plugins/link
npm ci --prefix plugins/commander
npm run build:plus
npm run package:plus:win
```

完整构建会下载 Electron、Node/Python/Git 等官方 runtime 资源与生产包。不使用签名或上传凭据；产物为未签名预览安装包，Windows 可能显示 SmartScreen 提示。

托盘改字定向验证：使用 Node 24 执行 `node --test scripts/desktop/prepare-tray.test.mjs scripts/desktop/packaging-config.test.mjs`。测试实际编译主进程、验证菜单文字及原显示/退出行为，打入临时 ASAR 后读取校验并自动清理；不启动 GUI 或构建完整 EXE。正式打包的 `afterPack` 同样读取实际 `app.asar/lib/main.js`，防止资源映射漏装。2026-10-20 已通过这 8 项测试；Windows GUI 与完整新安装包尚未验证。

## 数据和更新边界

appId 为 `cn.draftgo.dshplus`，Electron 用户界面数据与原版隔离。Harness 工作数据仍遵循官方 `DSH_HOME`，默认 `~/.dsh`，Desktop profile 为 `profiles/desktop`。不要同时运行原版 Desktop 和 Plus 使用同一个 profile。现有 profile 的其他插件和配置保留；第一次将旧直接 Plus bundle 转为组合 bundle，后续不强行恢复用户禁用。

Plus 的构建只扩展打包组合，不恢复旧社区 Stable/Beta/Next 或 runtime patches。官方原有模块内部准备步骤保持原样。参考旧 `dsh-desktop` 提交 `47574b1a83` 的原生 Windows + NSIS 交付方式。

## 已验证交付

2026-10-17（北京时间），提交 `8f203ca0d1` 的 Windows Actions `38928099138` 完成。产物 `dsh-plus-0.1.0-win-x64-setup.exe` 包含完整官方 Desktop 与预装 Plus，不要求先安装 DSH。

Windows CI 已通过：官方完整构建、运行时完整性校验、离线插件安装/移除、办公文件转 PDF、打包后 Host 启动、Plus profile 初始化、owner 认证 Link 管理 API，以及 NSIS 静默安装和预装 Plus 检查。

未验证：人工 Windows GUI 首次启动、真实模型调用、手机真机与公网蜂窝网络。安装器为未签名预览版，SmartScreen 可能提示。下载通过 `draftgo/dsh-plus` Releases 提供。
