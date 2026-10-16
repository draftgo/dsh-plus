# 方圆体

用户提供原文件：AlimamaFangYuanTiVF-Thin.ttf，内部名称「阿里妈妈方圆体 VF」。
原文件保留在 source/，生产包只包含 web/ WOFF2 字符分包及 manifest.json。
字体权利归原作者；用户未同时提供独立许可证，本目录不将字体声明为插件 MIT 许可。

构建：安装 Python fonttools[woff] 与 brotli，执行 python3 plugins/commander/scripts/build-fonts.py。
保留全部原始字符和 200–700 可变字重，将 BEVL 固定为原始默认值 1。
修正原字体无效 STAT 轴引用；字形轮廓不变。

unicode-range 按显示字符加载，font-display: swap 避免等待字体时文字不可见。
使用内容哈希文件名与私有长期缓存，字体不内嵌 JavaScript、不连接外部字体服务。
通过官方文字字体默认变量接入；已有用户字体设置优先，代码与终端仍使用等宽字体。
