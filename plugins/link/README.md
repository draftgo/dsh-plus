# Link · 多端直连

DSH-Plus 内置的远程连接模块。入口是桌面 **设置 → 远程连接**。默认关闭，开启后独立监听加密端口，模型凭据和执行进程留在主机，不需要第三方账号或公共中继。

云端通过公网 HTTPS 域名打开工作台时，默认复用该域名配对；在本地电脑或私网地址打开时，默认使用同网络 Android App 直连，不要求公网。手动切换保留在高级设置。域名配对仍要求部署者为 `/link/` 配置反向代理，前端不会凭保存 URL 创建路由。

已完成源码、桌面插件打包、Android debug APK 构建与服务测试；移动真机、Windows/macOS 桌面安装尚需验收。Android 工程与当前构建结果见 [移动端](mobile/README.md)。

## 目录

```text
src/
  pairing/        一次性配对、设备凭据与持久化
  transport/      HTTPS 监听、证书身份、请求边界
  session/        官方 Harness 与直接 DSH-Plus 会话适配
client/           桌面入口、移动共用界面、原生桥接
mobile/android/   Android 原生网络、扫码与安全存储
scripts/          Web 构建
test/            配对、TLS、权限边界与会话适配测试
```

`dist/web/` 为忽略提交的生成资源。DSH-Plus 构建把服务打入 `plugins/commander/lib/link.mjs`，网页复制到 `lib/link-web/`，安装插件时不依赖同级 Link 源码目录。`reference/` 不参与构建。

## 局域网

1. 打开桌面「设置 → 远程连接」，点击「连接手机」；未启用时会自动开启 Link 并生成二维码。
2. 手机和电脑接入同一网络，用 Android Link App 扫码后自动发送连接请求，无需再次点击连接；浏览器打开二维码配对链接同样自动连接。默认设备名称为“我的手机-五位随机字母”，生成后在本机保留，也可在扫码前修改。粘贴配对地址时保留手动连接按钮。
3. 在桌面确认设备申请，之后即可操作；配对设备可读取已注册项目、发送指令和审批，随时可撤销。
4. 手机与电脑必须能相互访问；防火墙只需允许选定的 Link 端口。访客 Wi-Fi 的客户端隔离可能阻断连接。

默认自动选择连接地址，不要求用户辨认 IP。监听地址、端口、手动选择地址、连接诊断和公网配置收在折叠的「高级设置」中，默认监听 `0.0.0.0:48721`。候选地址会过滤容器、宿主专用虚拟网卡及链路本地地址，保留普通网桥、物理网卡和 VPN 地址；局域网优先私网 IPv4，监听 `0.0.0.0` 时仅使用 IPv4，监听 `::` 时优先 IPv4。候选地址和本机启用状态不代表已验证手机或公网可达；无合适候选时提示检查网络，不生成指向手机自身的回环地址。

App 用二维码中的真实 SPKI 指纹信任主机证书，不需要域名或手机安装 CA。页面资源随 App 安装，网络由原生 OkHttp 承载。工作台 HTTPS 支持 HTTP/2 多路复用，避免多个长期订阅占满浏览器连接池；兼容 HTTP/1.1 客户端和反向代理。局域网 IP 变化后需重新扫码；离开局域网后不能保证通过流量连接。

## 公网 HTTPS

公网配置和连接方式选择位于「高级设置」。iPhone 浏览器使用此路径，当前无 iOS 原生 App。

填写自己的可达 HTTPS 根地址，例如 `https://desk.example.com`，并把 `/link/` 路径反向代理到 Link 的 HTTPS 端口。仅保存地址不会创建 DNS、证书或公网路由。iPhone、Android、Windows 和 macOS 浏览器均可使用公网网页；Android App 也可粘贴公网 App 配对地址，用系统证书校验连接。

反代示例见 [Nginx 配置](config/nginx.example.conf)。若同域名还部署 Harness，`/link/` 走 Link，上游其他路径继续走现有 Harness。不要把整个官方 API 匿名开放。反代需保留 Host，公网浏览器必须访问受系统信任的 HTTPS 证书。内置证书的 PEM 位于 DSH-Plus 数据目录下 `link/host-cert.pem`，用于反代验证上游；不用 `proxy_ssl_verify off`。

局域网和公网配对码五分钟有效、单次使用。公网二维码可用手机相机打开网页，也可用更新后的 Android App 扫描 HTTPS 配对页；App 配对地址仍可单独复制。旧 APK 若不识别 HTTPS 码，使用「复制 App 地址」粘贴配对。手机无入站路径、NAT/CGNAT、防火墙阻断时，扫码不会自动建立公网链路。

## 移动端预览与验证

真实配对后进入共享网页工作台，默认「最近」；侧边栏、消息输入、斜杠命令、模型、权限预设、内置插件、Harness 工具与语音配置均由官方网页组件和同一主机设置接口提供，不在手机维护副本。桌面与手机共用会话、模型、插件状态和配置。Android 原生界面仅负责扫码、设备信任和 HTTPS/WebView；浏览器配对复用同源 HTTPS 工作台。移动侧栏、设置弹窗和软键盘针对窄屏适配。

工作台仅对已由电脑允许的设备签发路径限定 HttpOnly Cookie，网页 API 与 Gateway 流使用该设备独立 Peer；撤销后立即失效。配对设备具备完整个人工作台权限，包含操作项目、发送指令、管理权限交互及使用网页已启用的工具。语音服务沿用主机配置，但 Android 麦克风需系统授权；iOS 浏览器依赖 Safari 麦克风权限。

发送中仍可继续编辑下一条。网络失败时原消息与幂等编号保留供重试，不会覆盖新草稿；中文输入法组合输入不会误触发发送。

`/mobile` 是 `/link/` 的兼容入口，跳转至同一真实配对和工作台流程。浏览器已有配对身份时会直接进入完整 Harness 工作台；未配对时先连接并由电脑允许。`npm --prefix plugins/link run build:preview` 生成该入口的静态跳转页，不含模拟数据，也不提供任何授权绕过。

Linux 可执行 `node plugins/link/test/lan-offline.mjs`：以两个隔离网络命名空间模拟主机与手机，均无默认路由，在私网完成 TLS/SPKI、配对、桌面允许、带令牌 RPC 和撤销；需 `ip`、`unshare` 与 `CAP_NET_ADMIN`/`CAP_SYS_ADMIN`。这是无公网网络层验证，不等同于 Android 真机、相机和 Wi-Fi 路由器验收。

## 会话与权限

- 官方会话通过公开 Connection Peer + Typert Gateway 操作，保留官方会话归属、审批和问题处理。
- 仅显示已注册工作区的顶层会话。新会话使用主机模型目录，可选原生 DSH-Plus 模型；不会把 API key 或 CLI 登录凭据交给手机。
- 旧 `commander-web:` 直接会话可继续查看、发送、停止、审批。已归属 Harness 的原生会话须通过官方会话操作，防止重复 writer。
- 发送重试保留 `requestId`；断线不会取消正在执行的 Agent。实时文本使用前台短轮询，后台保活、推送、远程语音不在本版范围。
- 设备授予的是可信个人设备权限：可读取所有已注册项目、发送指令并回答审批，不是只读访客。桌面确认前明确展示该范围。
- 每设备独立 Peer；撤销立即禁用令牌并释放 Peer。仅保存令牌 SHA-256，App 凭据使用 Keystore AES-GCM，网页令牌仅在当前浏览会话的 sessionStorage。
- 远程 API 是明确动作白名单，不接受任意 namespace、Shell 或文件路径。Host/Origin 校验、配对限流、请求体限制、TLS 和设备授权共同生效。

官方会话可查看最近消息、翻页、实时文本、停止、权限审批和结构化问题。旧直接会话只展示 DSH-Plus 保留的最近事件，不假装拥有完整原生历史。首版不含桌面投屏、文件编辑、终端、公共中继、iOS 原生包及远程语音。

## 开发

```sh
npm ci --prefix plugins/link
npm ci --prefix plugins/commander
npm run build:plus
npm run test:link
npm run test:commander
npm run check
```

安装现成 DSH-Plus 插件包无需单独安装 Link。源码重建需先安装 Link 的依赖，根目录仍无独立依赖树。

服务协议：桌面 owner 管理接口 `POST /api/commander-link`；独立 TLS 远端提供配对页 `/link/`、受设备令牌保护的 `POST /link/api/workbench` 会话签发、cookie 保护的 `/link/workbench/` 网页/API/模块资源/Gateway 流，以及 Link 会话 API。远程设备不能访问 owner 管理 API；设备撤销会清除会话并释放 Peer。测试与实际联调边界见 [实现记录](../../Design/Link入口与移动端实现记录.md)。

## 多设备与服务器

侧栏“设备”打开本机设备中心，支持保存、重命名、移除多台电脑与服务器。电脑粘贴目标 Link 配对地址并等待批准，手机支持扫码。工作台隔离，切换不停止主机任务；Android 顶部可返回设备列表，离线仍可切换，自动迁移已有身份。

添加服务器：SSH 地址/端口/用户名 → 确认 SHA256 指纹 → 密码/私钥认证 → 检查安装并建立环回隧道。默认国内镜像，可选直连。支持 Ubuntu/Debian、x64/arm64 与 systemd 用户服务；密码私钥仅操作内存使用。服务支持状态、启停、重启、日志、升级；移除连接不卸载服务，常驻需要用户会话 linger，安装结果会提示。

Node 令牌存私有权限文件，与官方本机凭据提供器一样信任当前 OS 用户；Android 使用 Keystore 加密。代理工作台独立浏览器源，远端禁止访问本机管理接口。接口见 openapi.json，设计见 Design/设备切换与服务器接入.md。MCP delegation 不变，不向 Agent 开放设备切换或 SSH 凭据工具。

npm run build:plus 生成服务器 seed 和 SHA256 清单，经 SSH 上传，不依赖尚未发布的 Linux 资产。新增 Android 原生多设备与 SSH 能力需重新构建客户端。
