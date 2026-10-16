# DSH-Plus 完整 Windows 安装包

交付目标是一个 `dsh-plus-<Plus版本>-win-x64-setup.exe`：含官方 Electron Desktop、固定版本完整运行时、DSH-Plus、Voice、Link 和插件生产依赖。安装器用内置 Electron Node 初始化用户 Desktop profile，不要求用户安装 Node、CLI 或手动安装 Plus。

## 目录与职责

- `package-windows.mjs`：调用官方构建、运行时准备与 NSIS；不改官方源码。
- `plugin-bundle.mjs`：以 npm 发布白名单复制插件与依赖，复用官方服务，首次安装启用组合 bundle。
- `seal-runtime.mjs`：注入后通过官方 writer 重建完整文件哈希与共享包清单。
- `electron-builder.config.mjs`：扩展官方配置，独立 appId / 产品名，预览关闭自动更新与强制升级策略；不引用官方更新服务。
- `smoke-windows.mjs`：验证打包资源、官方 Host 启动、离线配对 profile 初始化与认证 Link 管理接口。
- `test-install-windows.ps1`：CI 静默安装并检查用户 profile 已启用 Plus。

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

## 数据和更新边界

appId 为 `cn.draftgo.dshplus`，Electron 用户界面数据与原版隔离。Harness 工作数据仍遵循官方 `DSH_HOME`，默认 `~/.dsh`，Desktop profile 为 `profiles/desktop`。不要同时运行原版 Desktop 和 Plus 使用同一个 profile。现有 profile 的其他插件和配置保留；第一次将旧直接 Plus bundle 转为组合 bundle，后续不强行恢复用户禁用。

Plus 的构建只扩展打包组合，不恢复旧社区 Stable/Beta/Next 或 runtime patches。官方原有模块内部准备步骤保持原样。参考旧 `dsh-desktop` 提交 `47574b1a83` 的原生 Windows + NSIS 交付方式。

当前构建状态以 Actions 实际结果为准。安装包只有通过 Windows 构建与必要 smoke 后才上传 Releases；本地 Linux 的 3 项预装测试与真实 owner 管理 API 联调不能代替 EXE 或 Windows 安装成功。
