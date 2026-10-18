# Android 品牌资源

小角为 DSH-Plus 的吉祥物与 LOGO IP。图形来自根目录 `assets/brand/dsh-plus-mark.svg`，保留原始米白、朱红、墨黑配色。

- `ic_dsh_plus.xml`：传统方形图标与 Android 8–11 启动图。
- `ic_dsh_plus_foreground.xml`：Adaptive Icon 与 Android 12+ 启动图，共用无底色的小角矢量，放在 108dp 画布中央的 56 × 37.33dp 区域。角色外轮廓处于 66dp 安全圆内，兼容圆形、圆角与方圆遮罩。
- `mipmap-anydpi-v26/ic_dsh_plus.xml`：墨黑背景的自适应图标，同时用于普通和圆形启动器入口。

包名及 Link 配对行为保持不变。修改公共主标识时同步这些 Android VectorDrawable 路径与品牌色。
