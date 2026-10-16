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

桌面入口是「设置 → 远程连接」。局域网选地址后显示带真实 TLS SPKI 的二维码；Android 校验固定公钥、证书有效期与配对主机。公网填写自有 HTTPS 根地址，网页与 `/link/api/` 保持同源；App 公网连接使用系统信任链和主机名校验。保存公网 URL 不等于部署成功，不自动建立 NAT 穿透。

设备通过五分钟单次配对码申请，桌面确认后获得可撤销令牌。桌面管理接口继承官方 owner Connection；公网远端仅有 info / pair / pair-status / rpc 白名单。设备可信权限覆盖所有已注册工作区，界面明确告知，不提供按设备项目 ACL 或任意 Shell 入口。

每设备建立官方 owner Peer，经 Typert Gateway 操作已注册项目的顶层会话；审批和问题通过同 Peer 的官方 `$events` 应答。原生旧 `commander-web:` 会话另做受限适配，不解除 Harness-owned 会话所有权。模型凭据与执行进程始终留在主机。

手机支持项目、模型、会话创建、历史翻页、前台短轮询输出、发送、停止、批准/拒绝与结构化问题。发送重试保留 requestId；断开手机不终止主机任务。Android 一次记住一台主机，切换或地址变化需清除身份后重配；暂无多主机列表、mDNS 和后台保活。

## 已执行验证

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

Android `assembleDebug` 已真实构建成功，验收产物归类在 `artifacts/android/`；签名与设备验收边界见 [移动端记录](../plugins/link/mobile/README.md)。没有真机完成扫码、相机授权、软键盘、切后台恢复和安装验收。Windows 完整 EXE 已通过 CI 静默安装，尚未人工验收 GUI；macOS 安装、iPhone Safari、真实反代与蜂窝网络尚未实测。

本版不提供 iOS 原生安装包、桌面投屏、远程文件编辑、终端、公共中继、VPN、穿透或远程语音。公网需要用户已具备到执行主机的可达路径；家中主机不能仅凭一个域名被手机流量访问。

## 参考与许可

Paseo 参考提交 `d57096a4568cd2db106f35a0c5011627de53a646`；Remote 参考提交 `4a2862d168ee3f99ce226c282a4899bf7427c06e`。仅用于职责与恢复流程参考，Link 未复制 Remote 源码。第三方图标、字体、官方 UI 与构建内联依赖的声明保留于 Commander NOTICE 和 `lib/LINK-THIRD-PARTY-LICENSES.txt`，字体不属于插件 MIT 许可。
