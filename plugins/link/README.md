# Link · 多端直连

DSH-Plus 内置的远程连接模块。统一入口是侧栏 **设备中心**，通过「连接 / 设备」分段切换管理主机授权与保存的设备；设置弹窗不再提供设备与连接入口。默认关闭，开启后独立监听加密端口，模型凭据和执行进程留在主机，不需要第三方账号或公共中继。

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

1. 目标主机打开「设备 → 允许其他设备连接」，生成二维码或复制连接信息；未启用时自动开启 Link。
2. 另一台电脑打开「设备 → 添加设备 → 连接已有设备」，粘贴完整连接信息；目标主机批准后保存设备身份。
3. 手机和电脑接入同一网络，用 Android Link App 扫码后自动发送连接请求，无需再次点击连接；浏览器打开二维码配对链接同样自动连接。默认设备名称为“我的手机-五位随机字母”，生成后在本机保留，也可在扫码前修改。粘贴配对地址时保留手动连接按钮。
4. 在桌面确认设备申请，之后即可操作；配对设备可读取已注册项目、发送指令和审批，随时可撤销。
5. 手机与电脑必须能相互访问；防火墙只需允许选定的 Link 端口。访客 Wi-Fi 的客户端隔离可能阻断连接。

默认自动选择连接地址，不要求用户辨认 IP。监听地址、端口、手动选择地址、连接诊断和公网配置收在折叠的「高级设置」中，默认监听 `0.0.0.0:48721`。候选地址会过滤容器、宿主专用虚拟网卡及链路本地地址，保留普通网桥、物理网卡和 VPN 地址；局域网优先私网 IPv4，监听 `0.0.0.0` 时仅使用 IPv4，监听 `::` 时优先 IPv4。候选地址和本机启用状态不代表已验证手机或公网可达；无合适候选时提示检查网络，不生成指向手机自身的回环地址。

App 用二维码中的真实 SPKI 指纹信任主机证书，不需要域名或手机安装 CA。页面资源随 App 安装，网络由原生 OkHttp 承载。工作台 HTTPS 支持 HTTP/2 多路复用，避免多个长期订阅占满浏览器连接池；兼容 HTTP/1.1 客户端和反向代理。局域网 IP 变化后需重新扫码；离开局域网后不能保证通过流量连接。

## 公网 HTTPS

公网配置和连接方式选择位于「高级设置」。iPhone 浏览器使用此路径，当前无 iOS 原生 App。

填写自己的可达 HTTPS 根地址，例如 `https://desk.example.com`，并把 `/link/` 路径反向代理到 Link 的 HTTPS 端口。仅保存地址不会创建 DNS、证书或公网路由。iPhone、Android、Windows 和 macOS 浏览器均可使用公网网页；Android App 也可粘贴公网 App 配对地址，用系统证书校验连接。

反代示例见 [Nginx 配置](config/nginx.example.conf)。若同域名还部署 Harness，`/link/` 走 Link，上游其他路径继续走现有 Harness。不要把整个官方 API 匿名开放。反代需保留 Host，公网浏览器必须访问受系统信任的 HTTPS 证书。内置证书的 PEM 位于 DSH-Plus 数据目录下 `link/host-cert.pem`，用于反代验证上游；不用 `proxy_ssl_verify off`。

局域网和公网配对码五分钟有效、单次使用。公网二维码可用手机相机打开网页，也可用更新后的 Android App 扫描 HTTPS 配对页；App 配对地址仍可单独复制。旧 APK 若不识别 HTTPS 码，使用「复制连接信息」粘贴配对。手机无入站路径、NAT/CGNAT、防火墙阻断时，扫码不会自动建立公网链路。

## 移动端预览与验证

真实配对后进入共享网页工作台，默认「最近」；侧边栏、消息输入、斜杠命令、模型、权限预设、内置插件、Harness 工具与语音配置均由官方网页组件和同一主机设置接口提供，不在手机维护副本。桌面与手机共用会话、模型、插件状态和配置。Android 原生界面仅负责扫码、设备信任和 HTTPS/WebView；浏览器配对复用同源 HTTPS 工作台。移动侧栏、设置弹窗和软键盘针对窄屏适配。

工作台仅对已由电脑允许的设备签发路径限定 HttpOnly Cookie，网页 API 与 Gateway 流使用该设备独立 Peer；撤销后立即失效。配对设备具备完整个人工作台权限，包含操作项目、发送指令、管理权限交互及使用网页已启用的工具。语音服务沿用主机配置，但 Android 麦克风需系统授权；iOS 浏览器依赖 Safari 麦克风权限。

实时语音通过独立 `/link/workbench/api/voice/realtime` WebSocket 持续发送二进制 PCM，识别事件与 ACK 同连接返回；复用工作台 Cookie、Host/Origin 校验和主机一次性连接 ticket。本地设备代理保留二进制帧与 TLS 信任约束，撤销设备或关闭工作台会关闭媒体连接。公网反代需配置 [Nginx 示例](config/nginx.example.conf) 中该路径的 Upgrade 路由；普通 HTTP/SSE 语音识别继续走共享 API。主机须明确配置服务支持的实时 WSS 协议与对应模型；Android WebView、自签名证书及真机外放听感仍待设备验证。

发送中仍可继续编辑下一条。网络失败时原消息与幂等编号保留供重试，不会覆盖新草稿；中文输入法组合输入不会误触发发送。

`/mobile` 是 `/link/` 的兼容入口，跳转至同一真实配对和工作台流程。浏览器已有配对身份时会直接进入完整 Harness 工作台；未配对时先连接并由电脑允许。`npm --prefix plugins/link run build:preview` 生成该入口的静态跳转页，不含模拟数据，也不提供任何授权绕过。

Linux 可执行 `node plugins/link/test/lan-offline.mjs`：以两个隔离网络命名空间模拟主机与手机，均无默认路由，在私网完成 TLS/SPKI、配对、桌面允许、带令牌 RPC 和撤销；需 `ip`、`unshare` 与 `CAP_NET_ADMIN`/`CAP_SYS_ADMIN`。这是无公网网络层验证，不等同于 Android 真机、相机和 Wi-Fi 路由器验收。

## 会话与权限

- 官方会话通过公开 Connection Peer + Typert Gateway 操作，保留官方会话归属、审批和问题处理。
- 仅显示已注册工作区的顶层会话。新会话使用主机模型目录，可选原生 DSH-Plus 模型；不会把 API key 或 CLI 登录凭据交给手机。
- 旧 `commander-web:` 直接会话可继续查看、发送、停止、审批。已归属 Harness 的原生会话须通过官方会话操作，防止重复 writer。
- 发送重试保留 `requestId`；断线不会取消正在执行的 Agent。实时文本使用前台短轮询，后台保活与推送不在本版范围。共享工作台的语音使用主机 Voice 服务与通话租约。
- 设备授予的是可信个人设备权限：可读取所有已注册项目、发送指令并回答审批，不是只读访客。桌面确认前明确展示该范围。
- 每设备独立 Peer；撤销立即禁用令牌并释放 Peer。仅保存令牌 SHA-256，App 凭据使用 Keystore AES-GCM，网页令牌仅在当前浏览会话的 sessionStorage。
- 远程 API 是明确动作白名单，不接受任意 namespace、Shell 或文件路径。Host/Origin 校验、配对限流、请求体限制、TLS 和设备授权共同生效。

官方会话可查看最近消息、翻页、实时文本、停止、权限审批和结构化问题。旧直接会话只展示 DSH-Plus 保留的最近事件，不假装拥有完整原生历史；语音入口在共享网页工作台。当前不含桌面投屏、文件编辑、终端、公共中继及 iOS 原生包。

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

服务协议：桌面 owner 管理接口 `POST /api/commander-link`；独立 TLS 远端提供配对页 `/link/`、受设备令牌保护的 `POST /link/api/workbench` 会话签发、cookie 保护的 `/link/workbench/` 网页/API/模块资源/Gateway 流，以及 Link 会话 API。远程设备不能访问 owner 管理 API；设备撤销会清除会话并释放 Peer。测试与实际联调边界见 [实现记录](../../Design/01-设备与远程连接/设计.md)。

## 云端访问密钥

设置 → 远程连接 → 访问密钥：点击「生成密钥」，复制保存并勾选「我已保存密钥」，然后启用。也可自定义 16–512 个字符。其他浏览器首次访问时输入一次，后续自动保持登录；可随时更换或关闭。网络与部署说明收在维护文档，默认页面只保留操作所需信息。

访问密钥与 Link 监听开关独立。只保存带随机盐的 scrypt 派生值，私有文件原子写入；登录使用 12 小时 Secure / HttpOnly / SameSite=Strict 的随机会话 Cookie。轮换、关闭、服务重启会清除旧会话。设置不会回显已保存的密钥；云站同源管理员启用/轮换后会保留当前登录，本机管理员需在云域名单独登录。

`dsh.draftgo.cn` 已由维护端接入，用户无需设置环境变量或 Nginx；保留该站现有 IP 规则。其他部署仍需维护者完成以下一次性接入，插件不会静默修改 Nginx：

服务启动后状态分别返回 configured（环回服务已启动）与 ready（登录反代已实测）。服务端仅向配置的精确 HTTPS 源访问登录路由，拒绝重定向并验证当前进程随机标识，保留正常 TLS 校验；30 秒缓存用于非阻塞状态轮询，启用/轮换前强制验证，未就绪不会保存新密钥。此检查证明登录入口抵达当前实例，不代替部署者对全站 auth_request 规则的验证。持久配置损坏不会让 Link 管理接口消失：状态显示错误，云端 check 返回 503 拒绝访问；修复需从本机管理环境处理。关闭服务立即拒绝新操作和会话，清理过程可重复调用。

1. 给 Harness 进程配置精确 HTTPS origin 的 DSH_LINK_CLOUD_ORIGIN，例如 https://cloud.example.com；并设置独立环回端口 DSH_LINK_CLOUD_AUTH_PORT，例如 48722，重启进程。未配置时设置页不可启用。端口 0 仅供隔离测试随机分配。
2. 按 [全站 Nginx 示例](config/nginx-cloud-access.example.conf) 在现有 HTTPS server 引入 auth_request，保护 owner 主页、API、事件流/WS、插件资源和移动预览；同时引入 [Link 示例](config/nginx.example.conf)，仅指定的 /link/ 路由委托 Link 自身认证。satisfy all 避免 allow all 绕过；owner location 必须继承鉴权。仅登录页面和登录接口公开，check 子请求必须 internal。鉴权服务不可用时拒绝访问。
3. 若根路径有官方 owner launch-token bootstrap，按示例在原 named location 增加前置检查与错误转交，保留已有私有 token 桥；否则根路径覆盖 error_page 可能导致匿名访问绕过或无法进入登录页。不要将 owner token 输出给客户端，不要给 API 401 转 HTML。
4. Harness 后端、Link 监听和鉴权端口仅绑定环回，不开放可绕过 Nginx 的原始端口；现有局域网直连部署需自行选择相应隔离策略。先保留本机管理入口并确认登录页可访问，再启用密钥。设置显示“服务已配置”不代表反向代理已接入，应从未登录浏览器确认所有路径被拦截。

登录在 POST body 传密钥，要求精确 Origin 和专用 CSRF 头；不信任客户端转发 Host/IP。全局连续 5 次错误会暂停验证一分钟，最多 4 路并发，避免伪造 IP 绕过；这也意味着连续错误可能短暂影响其他访客。接口/事件流未登录返回 JSON 401，文档导航转登录，跳转仅允许站内路径；配对 fragment 保留在浏览器，不写入服务端 URL。部署者应避免记录请求体/Cookie。

全站访问密钥不替代官方 owner 身份与 Link 配对授权。按配套反代配置后，已配对 Link 工作台无需重复输入 owner 密钥，Android 可直接使用 HTTPS 配对；旧反代须由维护者更新。设备凭据不能进入 owner 页面或管理 API。MCP 未增加密钥、设备或 SSH 管理工具。接口见 [OpenAPI](openapi.json)。

## 设备与服务器管理

侧栏“设备”统一管理当前主机的设备与连接：允许连接、批准申请、授权设备、其他工作台和高级设置。设置弹窗不再保留“设备与连接”标签，设备相关操作统一从设备中心进入。云端浏览器同样支持，凭据及 SSH 操作属于当前云主机；部署需配置设备网关与独立 HTTPS 工作台源，见 [Nginx 示例](config/nginx-devices.example.conf)。电脑粘贴连接信息，手机可扫码；切换不停止目标主机任务。

移动端设备切换位于对话标题栏侧栏按钮右侧，返回设备列表时保留已打开的工作台页面。浏览器设备中心只接受已挂载工作台 frame 的精确来源消息，确认标题栏导航可用后才隐藏重复顶栏；旧工作台或导航失效保留外层返回入口。Android 使用限定来源、限定主 frame 的独立导航通道，仅允许返回设备列表，不开放设备管理原生桥；离线仍可切换。普通配对工作台没有父设备中心时不显示无效切换按钮。

添加设备 → 安装到服务器：SSH 地址/端口/用户名 → 确认 SHA256 指纹 → 密码/私钥认证 → 检查安装并建立环回隧道，验证 TLS、设备令牌和真实工作台后才保存设备。默认国内镜像，可选直连。支持 Ubuntu/Debian、x64/arm64 与 systemd 用户服务；密码私钥仅操作内存使用。服务支持状态、启停、重启、日志、升级；移除连接不卸载服务，常驻需要用户会话 linger，安装结果会提示。

Node 令牌存私有权限文件，与官方本机凭据提供器一样信任当前 OS 用户；Android 使用 Keystore 加密。代理工作台独立浏览器源，远端禁止访问本机管理接口。接口见 openapi.json，设计见 [设备与远程连接](../../Design/01-设备与远程连接/设计.md)。MCP delegation 不变，不向 Agent 开放设备切换或 SSH 凭据工具。

npm run build:plus 生成服务器 seed 和 SHA256 清单，经 SSH 上传，不依赖尚未发布的 Linux 资产。新增 Android 原生多设备与 SSH 能力需重新构建客户端。

SSH 隧道仅供当前客户端访问，不会自动让手机通过公网连接。原有公网直连仍需可达 HTTPS 地址和反代；自有中继采用下述独立出站通道，不提供公共中转。

## 自有中继（首版）

一台用户自有服务器对应一个 Link 主机及独立 HTTPS origin，支持 IP 地址加高位端口，不要求域名。目标主机开机、联网并启用 Link 后主动连接中继；浏览器继续使用现有配对批准和工作台权限。TLS 在中继终止，中继运营者能读取内容，因此只能配置用户控制的可信服务器。中继凭据独立于设备令牌，不向 MCP 暴露。

目标主机通过进程环境配置 `DSH_LINK_RELAY_URL=https://<公网IP>:<高位端口>` 与 `DSH_LINK_RELAY_TOKEN`（至少 32 字符的随机专用密钥）。中继密钥仅存受限权限的服务环境配置，不通过配对 URL 分享。设备中心的连接方式增加“自有中继”，仅主机通道连接后允许生成 HTTPS 配对信息；主机批准后按既有流程进入工作台。关闭 Link 会同时断开中继。当前通道在线不代表访问端网络可达，必须从实际设备验收。

当前已提供核心中继通道、显式 IP 证书操作及 opt-in user systemd 自动续期 timer；真实公网 ACME、服务器 systemd 与端到端公网连接仍需在目标环境验收。SSH 一键部署、LAN 自动优先/失败回退和 Android 全路径尚未完成。旧 SSH 云端部署与直连继续可用。

### IP 地址证书约束

Let's Encrypt 的 IP 地址证书免费，`shortlived` profile 有效期 160 小时，需自动续期。Certbot 5.4+ 支持 IP 地址 webroot。HTTP-01 验证必须经过公网 80，TLS-ALPN-01 必须经过 443，不能把验证端口替换为业务高位端口；IP 不支持 DNS-01。中继业务可监听独立高位端口，证书不绑定端口。

已有 Web 服务时仅复用其显式 HTTP-01 webroot 路径，不抢占标准端口、不自动改写 Nginx 或防火墙。不具备安全验证路径时部署应报错；不会停掉已有网站换取签发成功。IP 更换须重新签发。证书申请、续期及失败恢复仍需真实 ACME 环境验收，不能据本地测试宣称公网永久可达。

依据：[IP 证书公开签发](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability.html)、[Certbot 支持](https://letsencrypt.org/2026/03/11/shorter-certs-certbot.html)、[验证方式](https://letsencrypt.org/docs/challenge-types/)。

#### 显式证书与续期操作

以下命令面向 Linux 上已安装 Certbot 5.4+ 的部署者。先为公网 80 配好现有 HTTP-01 路由，并准备已存在、当前用户可写的 webroot 和状态目录；工具不会安装 Certbot，也不会改写 Web 服务或防火墙。

```sh
node scripts/ip-certificate.mjs dry-run --ip 203.0.113.10 --email admin@example.com --webroot /srv/www/acme --state-dir /var/lib/dsh-link --challenge-port 80 --relay-port 24680 --confirm-public-ip true
node scripts/ip-certificate.mjs issue --ip 203.0.113.10 --email admin@example.com --webroot /srv/www/acme --state-dir /var/lib/dsh-link --challenge-port 80 --relay-port 24680 --confirm-public-ip true
node scripts/ip-certificate.mjs status --state-dir /var/lib/dsh-link
node scripts/ip-certificate.mjs renew --ip 203.0.113.10 --email admin@example.com --webroot /srv/www/acme --state-dir /var/lib/dsh-link --challenge-port 80 --relay-port 24680 --confirm-public-ip true --restart-relay-unit dsh-link-relay.service
```

`203.0.113.10` 是文档示例地址，不能用于真实签发。真实签发前须替换为服务器实际公网 IP。`renew` 仅在证书链或私钥内容变化时切换活动版本；带 `--restart-relay-unit` 时只对已运行的 `dsh-link-relay.service` 执行 try-restart。重启失败会保留待重试标记，下次运行续期时重试。

自动续期默认关闭。签发成功后，只有显式运行下列命令才会安装并启用当前用户的每日 systemd timer；它运行在当前用户的 systemd manager 下，不需要 root。证书状态目录、webroot 和 Certbot 对该用户必须可用。若用户服务要在退出登录后继续运行，服务器还需自行启用该用户的 linger。

```sh
node scripts/ip-certificate.mjs install-timer --state-dir /var/lib/dsh-link
node scripts/ip-certificate.mjs uninstall-timer
```

安装只创建 `dsh-link-ip-certificate-renew.service` 与 `dsh-link-ip-certificate-renew.timer`；同名文件已存在且不归本工具管理时会拒绝覆盖。卸载只禁用该 timer 并删除校验通过的本工具 unit，不停止或删除 relay 服务。timer 更新证书后只尝试重启固定名称 `dsh-link-relay.service`，不会重启其他服务；每日无证书变化时不会中断现有连接。

timer 安装前必须先由同一 OS 用户配置并启动 `dsh-link-relay.service`。发布插件包后，工具位于 `plugins/commander/lib/relay/`；在源码仓库内开发时，对应文件位于 `plugins/link/scripts/`。

复制 `relay.example.json` 到当前用户的配置目录并填写实际 IP、未占用的高位端口、随机中继密钥，以及证书活动路径。中继 TLS 私钥和配置文件都须保持当前用户所有且权限为 `0600`；随机密钥可用 `openssl rand -hex 32` 生成。

```json
{
  "host": "0.0.0.0",
  "port": 24680,
  "publicUrl": "https://198.51.100.10:24680",
  "token": "替换为 openssl rand -hex 32 生成的值",
  "keyFile": "/home/link/.local/state/dsh-link/dsh-link-ip-certificate/active/privkey.pem",
  "certFile": "/home/link/.local/state/dsh-link/dsh-link-ip-certificate/active/fullchain.pem"
}
```

`198.51.100.10` 和 `/home/link` 仅为示例，须替换为真实公网 IP 和运行服务的 OS 用户路径。端口须与证书命令中的 `--relay-port` 相同，并在服务器及云防火墙中放行 TCP；若端口已被占用，中继启动会失败，换成未占用的 `20000–49151` 端口后同步更新 URL 与证书配置。将下面的绝对路径替换为该服务器上打包后的实际位置：

```ini
[Unit]
Description=DSH Link self-hosted relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node /absolute/path/plugins/commander/lib/relay/run-relay-server.mjs --config /home/link/.config/dsh-link/relay.json
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
```

使用运行证书工具的同一 OS 用户安装 relay unit，再安装续期 timer：

```sh
install -d -m 700 "$HOME/.config/dsh-link" "$HOME/.config/systemd/user"
chmod 600 "$HOME/.config/dsh-link/relay.json"
install -m 600 /dev/stdin "$HOME/.config/systemd/user/dsh-link-relay.service" <<'UNIT'
[Unit]
Description=DSH Link self-hosted relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node /absolute/path/plugins/commander/lib/relay/run-relay-server.mjs --config /home/link/.config/dsh-link/relay.json
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now dsh-link-relay.service
systemctl --user status dsh-link-relay.service
node /absolute/path/plugins/commander/lib/relay/ip-certificate.mjs install-timer --state-dir "$HOME/.local/state/dsh-link"
```

上例中 service unit 的 `ExecStart` 路径也须按实际安装目录和用户路径修改。退出登录后仍需常驻时，由服务器管理员按部署策略为该用户启用 linger；证书 timer 和 relay 必须使用同一用户级 systemd manager。


### SSH 一键部署自有中继

在桌面小角的「设备中心 → 连接 → 部署自有中继」填写 SSH 地址、用户名、公网 IP、证书通知邮箱与专用业务端口，核对 SSH 指纹后提交认证。服务器需 Linux/systemd、系统路径 Node 22+、npm、Python3 venv，以及 root 或免密 sudo。密码、私钥和 passphrase 仅用于此次操作。

向导使用免费的 Let's Encrypt IP 短期证书，不强制域名。业务端口范围 20000–49151，不自动开放安全组或防火墙；HTTP-01 必须公网 80 可达。80 空闲时部署专用验证服务，已有站点时选择 webroot 并自行映射 `/.well-known/acme-challenge/`；不会停用已有站点或改写其配置。服务安装到 `/opt/xiaojiao-relay`，中继以独立系统用户运行，root 续期任务每日检查。重跑部署更新工具并保留中继身份；非本工具目录或同名单元拒绝接管。

部署完成先验证公网可信 TLS，再自动保存并启用当前主机的出站连接。等待主机通道在线后生成配对信息，在其他设备中粘贴并回到主机批准。TLS 成功不等于手机或工作台全路径验收成功。管理面板支持状态、有限日志、启停、重启及显式卸载；再次管理需重新提供 SSH 凭据。Android 支持连接中继，当前不提供部署入口。

新配对从已认证响应保存可信 routes，桌面与 Android 在打开工作台前优先探测固定 SPKI 的直连，网络不可达时回退系统 CA 验证的中继。证书异常、授权失效不降级，不重放写操作，不迁移活动流；切网后重新进入工作台。旧配对保留原单地址，需要重新配对获取多路径。浏览器通过当前 HTTPS 入口连接，不自动扫描内网。一个独立中继 origin 对应一台主机；多中继池调度未纳入此版本。
