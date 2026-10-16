# 本地交付产物

本目录只放可重新生成的交付文件，不放源码或凭据；二进制忽略提交，版本下载通过 GitHub Releases 提供。

```text
plugins/    DSH-Plus 插件 .tgz
android/    Android 验收用 debug .apk
windows/    完整 Windows 安装程序 .exe
```

插件：先执行 `npm run build:plus`，再执行 `npm pack ./plugins/commander --pack-destination artifacts/plugins`（需先创建目录）。

Android：执行 `npm run build:android`，默认产物在 `plugins/link/mobile/android/app/build/outputs/apk/debug/app-debug.apk`；交付时复制到 `artifacts/android/`。需要 JDK 17 与 Android SDK 35，详见 [移动端](../plugins/link/mobile/README.md)。

Windows：执行 `npm run package:plus:win`，原生 Windows x64 构建完整 `dsh-plus-<版本>-win-x64-setup.exe`，含官方 DSH、Plus、Voice 与 Link。构建和安装验证见 [桌面交付](../scripts/desktop/README.md)。

debug APK 用于验收，不包含正式发布签名。不要把 keystore、密码、local.properties 或工具链放入本目录。
