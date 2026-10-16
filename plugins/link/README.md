# Link · 多端直连

DSH-Plus 内置的远程连接模块。入口是桌面 **设置 → 远程连接**。默认关闭，开启后独立监听加密端口，模型凭据和执行进程留在主机，不需要第三方账号或公共中继。

已完成源码、桌面插件打包、Android debug APK 构建与服务测试；移动真机、Windows/macOS 桌面安装尚需验收。Android 工程与当前构建结果见 [移动端](mobile/README.md)。

## 目录

```text
src/
  pairing/        一次性配对、设备凭据与持久化
  transport/      HTTPS 监听、证书身份、请求边界
  session/        官方 Harness 与直接 Commander 会话适配
client/           桌面入口、移动共用界面、原生桥接
mobile/android/   Android 原生网络、扫码与安全存储
scripts/          Web 构建
test/            配对、TLS、权限边界与会话适配测试
```

`dist/web/` 为忽略提交的生成资源。Commander 构建把服务打入 `plugins/commander/lib/link.mjs`，网页复制到 `lib/link-web/`，安装插件时不依赖同级 Link 源码目录。`reference/` 不参与构建。

## 局域网

1. 桌面设置中启用 Link，默认地址 `0.0.0.0:48721`，保存。
2. 选择“局域网 · Android App”，生成二维码。
3. Android App 扫码，填写设备名并连接；桌面确认后才能操作。
4. 手机与电脑必须能相互访问；防火墙只需允许选定的 Link 端口。访客 Wi-Fi 的客户端隔离可能阻断连接。

App 用二维码中的真实 SPKI 指纹信任主机证书，不需要域名或手机安装 CA。页面资源随 App 安装，网络由原生 OkHttp 承载。局域网 IP 变化后需重新扫码；离开局域网后不能保证通过流量连接。

## 公网 HTTPS

填写自己的可达 HTTPS 根地址，例如 `https://desk.example.com`，并把 `/link/` 路径反向代理到 Link 的 HTTPS 端口。仅保存地址不会创建 DNS、证书或公网路由。iPhone、Android、Windows 和 macOS 浏览器均可使用公网网页；Android App 也可粘贴公网 App 配对地址，用系统证书校验连接。

反代示例见 [Nginx 配置](config/nginx.example.conf)。若同域名还部署 Harness，`/link/` 走 Link，上游其他路径继续走现有 Harness。不要把整个官方 API 匿名开放。反代需保留 Host，公网浏览器必须访问受系统信任的 HTTPS 证书。内置证书的 PEM 位于 Commander 数据目录下 `link/host-cert.pem`，用于反代验证上游；不用 `proxy_ssl_verify off`。

局域网和公网配对码五分钟有效、单次使用。公网二维码打开网页，App 配对地址单独复制。手机无入站路径、NAT/CGNAT、防火墙阻断时，扫码不会自动建立公网链路。

## 会话与权限

- 官方会话通过公开 Connection Peer + Typert Gateway 操作，保留官方会话归属、审批和问题处理。
- 仅显示已注册工作区的顶层会话。新会话使用主机模型目录，可选原生 Commander 模型；不会把 API key 或 CLI 登录凭据交给手机。
- 旧 `commander-web:` 直接会话可继续查看、发送、停止、审批。已归属 Harness 的原生会话须通过官方会话操作，防止重复 writer。
- 发送重试保留 `requestId`；断线不会取消正在执行的 Agent。实时文本使用前台短轮询，后台保活、推送、远程语音不在本版范围。
- 设备授予的是可信个人设备权限：可读取所有已注册项目、发送指令并回答审批，不是只读访客。桌面确认前明确展示该范围。
- 每设备独立 Peer；撤销立即禁用令牌并释放 Peer。仅保存令牌 SHA-256，App 凭据使用 Keystore AES-GCM，网页令牌仅在当前浏览会话的 sessionStorage。
- 远程 API 是明确动作白名单，不接受任意 namespace、Shell 或文件路径。Host/Origin 校验、配对限流、请求体限制、TLS 和设备授权共同生效。

官方会话可查看最近消息、翻页、实时文本、停止、权限审批和结构化问题。旧直接会话只展示 Commander 保留的最近事件，不假装拥有完整原生历史。首版不含桌面投屏、文件编辑、终端、公共中继、iOS 原生包及远程语音。

## 开发

```sh
npm ci --prefix plugins/link
npm ci --prefix plugins/commander
npm run build:plus
npm run test:link
npm run test:commander
npm run check
```

安装现成 Commander 插件包无需单独安装 Link。源码重建需先安装 Link 的依赖，根目录仍无独立依赖树。

服务协议：桌面 owner 管理接口 `POST /api/commander-link`；独立 TLS 远端仅提供 `/link/` 静态资源与 `/link/api/info`、`pair`、`pair/status`、`rpc`。所有远程 RPC 在设备令牌验证后进入显式动作适配器。测试与实际联调边界见 [实现记录](../../Design/Link入口与移动端实现记录.md)。
