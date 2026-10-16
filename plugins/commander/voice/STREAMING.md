# 流式语音协议与验证

日期：2026-10-16。语音实现位于 plugins/commander/voice，不修改上游和 reference。

设置 → 语音 → 识别协议显式选择，不根据模型名悄悄降级。

| 协议 | 上游接口 | 能力 |
| --- | --- | --- |
| 普通 HTTP | /audio/transcriptions | WAV 分段上传，JSON text |
| OpenAI 转录 SSE | /audio/transcriptions，multipart + stream=true | 分段上传后实时增量输出，RouterGo MiMo/Step 已真实验证 |
| MiMo SSE | /chat/completions，input_audio + stream | 片段上传后增量返回 |
| Step SSE | /audio/asr/sse，audio.data/input | 片段上传后 delta/done |
| Step 原生 WSS | /realtime/asr/stream | 约 100 ms 连续 PCM、修订、commit/final |

原生 WSS 适配 stepaudio-2.5-asr-stream 累计 text/stash 协议。浏览器通过现有 owner 鉴权 HTTP 上传 PCM、NDJSON 下行事件，服务器保持同一个上游 WSS。无第三方中继，密钥不进入浏览器。客户端 VAD 手动 commit，停说等待 final；挂断、断网、租约失效和配置变更关闭媒体流与连接。

MiMo SSE 与 Step SSE 是分段音频上传后的流式输出，不是双向连续音频。Step SSE 使用 stepaudio-2.5-asr，不能使用仅支持 WSS 的 -stream 模型。Step 1.1 增量 delta 语义不在本适配范围。

TTS 请求固定 PCM16LE、单声道、sample_rate 24000，并显式发送 stream=true；允许三段并发预取，响应禁止代理缓冲。Step 模型未填音色时默认 cixingnansheng，其他模型默认 alloy；供应商支持范围不同，请按实际服务配置。

## 当前输入与播放确认（2026-10-16）

语音通话只把识别转录提交给官方 `conversation.send(text)`，不再追加“已完整听到 / 未确认完整听到”等播放状态注记。该接口没有逐轮私有上下文参数，目前也未接入其他可靠的私有播放上下文通道。AudioWorklet ACK、插话停止播放和取消生成仍在本地生效；模型不能据此判断用户听到的具体位置。发送失败仅恢复待发转录，挂断和切换会话清除旧输入，旧异步错误与播放器回调不影响新通话。此前追加播放事实到普通用户消息的行为已移除；历史会话消息不改写。

## 验证

语音测试 54/54 通过：SSE partial/final、截断/取消、WSS update/append/commit/修订/final、下行背压、鉴权路由、PCM 转发、配置变更关闭连接、stop 等待 final、草稿 revision 冲突。客户端构建通过。新增运行依赖 ws@8.19.0。

通话 conversation without inject 已修复：从真实 Cordis 未注入 session scope 通过 get 获取 conversation，发送和取消回归通过。录音波形来自真实 PCM RMS；朗读与通话使用独立 Iconsax 图标，提供状态气泡和 reduced-motion。

### 早期 RouterGo 探测记录（已由下方正确路由复测更新）

仅使用服务生成的短测试语音，无历史消息或用户录音。密钥仅服务器内读取，未输出到日志或文档。

| 请求 | 实际结果 |
| --- | --- |
| Step TTS stepaudio-2.5-tts / cixingnansheng / pcm / 24000 | 200，audio/pcm，103680 bytes，PCM16 mono24k 为 2.16 秒 |
| MiMo TTS mimo-v2.5-tts / alloy / pcm | 400，参数校验失败 |
| MiMo ASR mimo-v2.5-asr / chat/completions stream | 503 |
| Step /audio/asr/sse | 404；本次探测使用 stream 模型，非 SSE 合规模型 |
| WSS /realtime/asr/stream | 404 |
| WSS /realtime?model=stepaudio-2.5-asr-stream | 503 |

协议实现和 mock 验证完成，不等于 RouterGo 已支持实时 ASR。Step WSS、MiMo/Step SSE 真实账号联调待完成；需要实际支持对应协议的供应商或网关。真实手机麦克风、外放回声、弱网长通话未验证。TEN VAD、RNNoise 尚未迁移；持续 sinc 重采样与自适应起播缓冲已在本轮实现。

协议依据：Step 官方 api-reference/audio/asr-stream.md、asr-sse.md，以及 MiMo Speech Recognition API 文档。


### 正确 RouterGo 路由复测与修复（2026-10-16）

使用服务端现存供应商凭据，生成一句合成测试语音，不使用用户录音、不输出密钥，不修改官方引擎。

- MiMo `mimo-v2.5-asr`、Step `stepaudio-2.5-asr`：正确接口均为 `POST /audio/transcriptions`，multipart `file/model/response_format=json/stream=true`，`Accept: text/event-stream`。真实均 200，收到多个 `transcript.text.delta` 和最终 `transcript.text.done`；测试音正确转写。模型列表支持 ASR 不表示网关支持厂商私有路径。
- 早期 `/chat/completions` MiMo 请求仍返回 503 `model_unavailable`，私有 Step `/audio/asr/sse` 使用正确非 stream 模型也为 404。因此新增明确的 `transcriptions-sse` 协议，不再将两个失败接口误判为 ASR 模型本身不可用。
- 插件真实处理器复测：Step TTS 200，41 个 PCM 包、122880 字节；合成音进入 MiMo ASR 后，NDJSON 返回 8 次 partial 和 final，文本为“你好，这是流式语音测试。”。单样本 TTS 首包约 3226 ms，ASR 首 partial 约 3171 ms、final 3422 ms；只是当次服务端时间，不是浏览器端整轮延迟或性能保证。
- ASR 属于持续采集、分段提交、响应增量的组合架构。该网关原生双向 WSS 仍未实证可用；不能将 SSE 描述为持续 PCM 双向识别。
- 旧 Voice 配置没有协议字段时，已知 RouterGo MiMo/Step 文件模型一次性迁移为 `transcriptions-sse`；用户显式选择的协议始终保留。迁移生效于启动内存快照，下次用户保存设置时持久化。
- Step 原生 ASR 清空使用 `asr.clear`：替换上游 socket，等待新 `session.updated`，保留浏览器 session id 与事件流，旧 socket epoch 事件全部丢弃，避免不支持 clear 的供应商污染新输入。
- TTS 采样率/声道元数据若与 24 kHz mono 矛盾立即拒绝；保持 PCM 半样本跨包拼接和取消传播。错误仅向前端返回状态与有界机器码，不转发供应商原始错误消息。

### `MALFORMED_RESPONSE` 根因

线上默认 `deepseek-official` 适配器被配置到 RouterGo `/messages`。真实短请求返回 200 SSE，但只有 `message_delta` 和 `message_stop`，无 `message_start` 或内容块。官方引擎按合同拒绝并报 `event precedes message_start`；朗读只消费已有 Agent 输出，不制造这些事件。相同模型 RouterGo `/chat/completions` 返回正常 `chat.completion.chunk`。应使用共享供应商 `routergo` 的 `openai-completions` 路由，不伪造缺失事件，也不修改官方翻译器。


### 部署路由修复

默认路由已在 `.local/web/router.overlay.yml` 与 Web profile patch 持久改为 `routergo / deepseek-v4.1-flash`，修改前文件保存在 `.local/web/backups/voice-route-*`（目录 0700、文件 0600）。当前已加载、空闲且使用不兼容默认路由的失败会话通过官方 `session/selectModel` 切到同一模型的 RouterGo 路由，并用 `session/list` 复核；未编辑任何 Session append-only 日志，其他工具/模型选择未改变。服务重启由主部署流程执行。

### 技术方案边界

本轮后端对应技术方案的职责包括：固定 24 kHz PCM16 mono 媒体合同、受限并发、流式转录/合成、取消传播、配置失效、原生 ASR 连接 epoch 隔离和清空、供应商路由实测。不把 SSE 音频文件识别标成原生双向识别，不把有限真实样本延迟当作性能保证。TEN VAD、RNNoise、Go 服务实现不在本后端移植范围；前端轮次/安全断句/连续播放/ACK 的具体实现以对应源码与验证记录为准。


### 本轮可朗读过滤对齐

跨增量保留行内代码内容；代码块、表格、裸 URL 分别每轮至多一次替代提示。Markdown 链接仅读标签，长未闭合链接/围栏仅保留有界状态。过滤短动作/舞台描述与表情，保留普通括号解释；仍使用同步有界处理进入现有三并发 PCM 队列，不等待网络或播放。断句保留完整句优先和安全 idle 补切。
