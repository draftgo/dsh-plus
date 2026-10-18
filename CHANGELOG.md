# 更新记录

## v0.1.1 - 2026-10-18

- 实时语音默认使用 OpenAI 兼容协议，并支持显式 WebSocket ASR 适配器；路由地址和查询参数由配置提供，不绑定任何供应商。
- ASR 默认模型更新为 `stepaudio-2.5-asr`，TTS 默认模型更新为 `stepaudio-2.5-tts`。
- 朗读与实时通话新增统一语速设置，默认 `1.2`，范围 `0.25-4`，步进 `0.05`。
- 优化实时音频分片、增量转写、播放预缓冲和取消/重连生命周期。
- 增强 Voice、Commander、Link 与 Android 配对体验及安全校验。
- 版本同步至根项目、Commander、Link 和 Android 客户端 `0.1.1`。

验证：Voice 全量测试、Commander 249 项测试、Link 测试、`npm run check`、Voice 客户端构建通过。Windows 安装器由 GitHub Actions 原生 Windows x64 构建；Android 发布包为 debug 签名验收包。
