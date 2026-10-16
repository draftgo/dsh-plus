# DSH-Plus

为官方 DeepSeek Harness 增加编码 Agent 接管、Voice 语音与 Link 多端直连。保留官方引擎，不修改其源码。

## 安装插件

已安装官方 DSH CLI 的用户，克隆仓库后从根目录执行：

```sh
git clone https://github.com/draftgo/dsh-plus.git
cd dsh-plus
dsh plugin --profile desktop add ./plugins/commander
```

重启 Desktop，进入「设置 → 远程连接」。Web 用户把 profile 改为 `web`，重启实际使用的 Web Host；安装命令与运行 Host 必须使用相同的 `DSH_HOME`。仓库包含已构建的插件资源，不需要为安装再构建完整官方应用。

局域网：启用 Link，手机安装 Android App，扫码后在桌面确认。无需域名和公共中继，需要同网互通并放行 Link 端口（默认 48721）。

公网：配置自己可达的 HTTPS 根地址，按 [Nginx 示例](plugins/link/config/nginx.example.conf) 反代 `/link/`；Android App 或手机/电脑浏览器配对后接入。公网模式不会自动打通家中 NAT；iPhone 首版使用公网网页。

下载验收包见 [Releases](https://github.com/draftgo/dsh-plus/releases)。Android debug 包用于验收；没有 iOS 原生包。Windows/macOS Desktop、手机真机与蜂窝网络验收边界见 [实现记录](Design/Link入口与移动端实现记录.md)。

## 项目结构

```text
plugins/
  commander/          DSH-Plus 安装单元，含 Voice；lib 为随包交付的构建资源
  link/               直连服务、桌面设置、共享移动界面
    src/pairing/      配对与设备管理
    src/transport/    TLS 与请求边界
    src/session/      官方 / 原生会话适配
    client/           桌面与移动 React 界面、原生桥接
    mobile/android/   Kotlin App、扫码、OkHttp、Keystore
    config/           公网反代示例
    test/             单元测试与可选真实联调
Design/               设计、开发清单及实际实现记录
scripts/              官方命令与 Android 构建封装
artifacts/            本地产物分类；二进制忽略 Git，下载走 Releases
deepseek-harness/     官方 Git 子模块，版本由 upstream.json 锁定
reference/            可选只读参考，不随仓库交付或参与构建
```

## 源码开发

使用官方要求的 Node（建议 Node 24）、兼容 pnpm 11 的 Corepack。根目录没有独立依赖树。修改前端需安装官方工作区依赖；官方源码始终保持干净。

```sh
git submodule update --init --recursive
npm run setup
npm ci --prefix plugins/link
npm ci --prefix plugins/commander
npm run build:plus
npm run test:commander
npm run test:link
npm run check
```

`npm run check` 仅验证版本与入口一致性；`npm run build/dev/start` 转发官方 Desktop 命令，平台与签名要求以官方文档为准。

Android 还需要 JDK 17、Android SDK Platform 35 / Build Tools 35，通过 `ANDROID_HOME` 或本机 `local.properties` 配置：

```sh
npm run build:android
```

命令先构建共享网页，再执行 `assembleDebug`。APK 位于 `plugins/link/mobile/android/app/build/outputs/apk/debug/app-debug.apk`。正式分发需自行配置 release 签名，不提交 keystore 或密码。

## 功能与验证边界

- 官方与 Commander 会话共用主机状态：项目、模型、新建、历史、流式文本、发送、停止、审批与问题。
- 设备需桌面确认，授权可撤销；可信设备能操作所有已注册工作区，首版没有逐项目访客权限。
- Android 一次保存一台主机，支持清除重配；任务留在主机运行，前台短轮询恢复状态。
- 不含桌面投屏、远程终端/文件编辑、公共中继、穿透、iOS 原生包或后台保活承诺。

详细说明：[DSH-Plus](plugins/commander/README.md) · [Link](plugins/link/README.md) · [移动端](plugins/link/mobile/README.md) · [实现与测试](Design/Link入口与移动端实现记录.md)。

## 许可

项目遵循 [MIT](LICENSE)。官方引擎及第三方资产遵循各自许可证；图标、字体与内联依赖说明见 [NOTICE](plugins/commander/NOTICE)。字体不属于本项目 MIT 许可。`reference/` 的仓库不是产品依赖，Link 未复制 Remote 源码。
