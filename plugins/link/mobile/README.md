# DSH Plus 移动端

`android/` 是 Kotlin 原生 Android 壳，使用 WebViewAssetLoader 加载共享的 `plugins/link/dist/web/`，所有主机请求通过原生 OkHttp 适配器，不加载远程网页。

## 构建

先构建 Link Web 资源，再安装 JDK 17、Android SDK Platform 35 / Build Tools 35，并通过 `ANDROID_HOME` 或本机 `android/local.properties` 提供 SDK 路径。

```sh
# 仓库根目录：先构建共享网页，再构建 APK
npm ci --prefix plugins/link
npm run build:android
# 安装到连接的真机
adb install -r plugins/link/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

debug 包仅用于本轮验收。正式分发需使用自己的 release keystore 和发布签名，禁止提交密码、keystore 或 local.properties。iOS 原生 App 不在此目录交付范围，首版可使用公网 HTTPS 手机网页。

## 配对与安全边界

- 桌面显示 `dshlink://pair?url=<HTTPS_BASE>&pin=<BASE64_SHA256_SPKI>&code=<一次性码>`，App 支持扫码或系统深链打开；摄像头不可用时保留共享页面的粘贴流程。
- 局域网使用二维码固定主机 SPKI 公钥，仅严格匹配该公钥且有效的证书通过；pin 模式仅允许配对 URL 的主机名，接受该公钥对应证书的 SAN 与局域网 IP 不同。公网无 pin 时使用系统证书信任链及标准主机名校验。禁止 HTTP 和重定向，不使用全局信任所有证书。
- Android Keystore 中的 AES-GCM 密钥加密配对身份，应用备份关闭；清除设备身份会删除本机令牌和密钥。服务器端撤销仍由桌面执行。
- JS bridge 仅存在于本地 appassets 页面；所有外部导航转系统浏览器，文件访问、混合内容和远程子资源禁用。原生网络仅接受已配对 HTTPS 主机的 `/link/api/*` GET / POST。
- 前台轮询由共享 UI 管理；本版本不承诺后台保活或系统强制停止后的实时接收。
- 一次安全保存一台主机；换主机或地址变化时，在配对页选择“清除并重新配对”。清除本机凭据不等于在主机撤销旧设备，撤销需从桌面设备列表执行。

## 原生桥接

`window.LinkNative.bootstrap()` 返回 JSON `{url,pin,code,name,token}`；`saveIdentity(json)`、`clearIdentity()`、`scan()` 返回 JSON 结果。

`request(JSON.stringify({id,method,path,body,headers}))` 异步执行并调用 `window.__linkNativeResult(id,jsonString)`，结果为 `{ok,status,body}`（body 已解析 JSON），失败为 `{ok:false,status:0,error}`。扫码或收到深链后发出 `link:bootstrap` 事件。

## 当前验证

2026-10-16：已安装隔离 JDK 17、Android SDK 35 与 Gradle 8.9，真实 `assembleDebug` 构建成功。验收包位于 `artifacts/android/dsh-plus-link-0.1.0-debug.apk`，分发下载见仓库 Releases；源码目录的原始产物位于 `android/app/build/outputs/apk/debug/app-debug.apk`。

共享网页包含在 APK 离线 assets 内。当前没有连接 Android 设备，未完成真机安装、扫码、软键盘、证书拒绝提示或切后台恢复验收。debug APK 有调试签名，不是正式 release 签名包。
