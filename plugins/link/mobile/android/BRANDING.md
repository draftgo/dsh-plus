# Android 品牌资源

应用名称为“小角”，DSH-Plus 为插件名称。品牌采用新版小角 IP v2.1，正式素材来自根目录 `assets/brand/dsh-plus-logo.svg` 与 `dsh-plus-mark.svg`，保留暖米白身体、砖红切角、深墨豆形眼与浅米背景。

- `ic_dsh_plus.xml`：来自正式应用图标的浅米底方形图标与 Android 8–11 启动图。
- `ic_dsh_plus_foreground.xml`：Adaptive Icon 与 Android 12+ 启动图，共用无底色的小角矢量，放在 108dp 画布中央的 56 × 37.33dp 区域。角色外轮廓处于 66dp 安全圆内，兼容圆形、圆角与方圆遮罩。
- `mipmap-anydpi-v26/ic_dsh_plus.xml`：浅米背景 `#EDE4D3` 的自适应图标，同时用于普通和圆形启动器入口。Android 12+ 启动页与系统栏使用同一背景。

包名及 Link 配对行为保持不变。修改公共主标识时同步这些 Android VectorDrawable 路径与品牌色。

## 原生连接依赖

- mwiede/JSch 2.28.8：BSD 3-Clause，SSH 会话、主机指纹与本机端口转发。
- Bouncy Castle bcprov-jdk18on 1.80：MIT，Android 平台的现代 SSH 密钥算法。
- 原始许可证随依赖 JAR 的 META-INF 保留，APK 不排除这些资源。

服务器安装资源由根目录 node scripts/server/package-seed.mjs 生成到 plugins/link/dist/server/，Android 构建复制至 assets/server/。缺少资源时构建明确失败，避免发布带空安装入口的客户端。

## 正式发行与签名

应用显示名称为“小角”，applicationId 保留 `cn.draftgo.dshplus.link`，DSH-Plus 继续作为插件产品名。`npm run build:android` 默认构建非 debuggable 的签名 release APK；开发验收需显式 `npm run build:android -- --debug`。

本地持久密钥位于被忽略的 `.local/release-keys/xiaojiao-android-release.jks`，同目录 `xiaojiao-android-release.env` 仅保存签名配置，两者权限均为 600。维护者需安全备份密钥与密码，禁止重建覆盖或提交到仓库。构建脚本仅读取所需变量，不输出凭据。

- Gradle 环境变量：`DSH_ANDROID_KEYSTORE_PATH`、`DSH_ANDROID_KEYSTORE_PASSWORD`、`DSH_ANDROID_KEY_ALIAS`、`DSH_ANDROID_KEY_PASSWORD`。
- Actions Secrets：`DSH_ANDROID_KEYSTORE_BASE64`、`DSH_ANDROID_KEYSTORE_PASSWORD`、`DSH_ANDROID_KEY_ALIAS`、`DSH_ANDROID_KEY_PASSWORD`。工作流仅在 runner 临时目录还原密钥，构建后删除。
- 工作流验证名称、版本、包名、不可调试状态、实际 APK 发行证书及内置前端/服务器资源，再产生 `xiaojiao-<version>-android.apk` 与 SHA256。仅显式启用 publish 才上传到应用版本 Release。
- 旧 debug 包与正式版签名不同，首次切换需卸载旧验收包，可能清除本机保存的连接；之后正式版始终使用同一发行密钥，可直接覆盖升级。
