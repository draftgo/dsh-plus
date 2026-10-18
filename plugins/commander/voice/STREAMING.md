# 流式语音协议与验证

当前说明更新于 2026-10-18；历史探测日期另行标注。语音实现位于 `plugins/commander/voice/`，不修改上游和 reference。

设置 → 语音 → 识别协议显式选择。默认采用 OpenAI 兼容接口；协议与路由不根据供应商域名或 ID 判断。Step 模型只是当前预填偏好，不代表绑定供应商。显式 `protocol` 始终优先；无协议字段的明确旧 MiMo/Step 模型保留兼容推断。

| 协议 | 默认上游接口 | 能力 |
| --- | --- | --- |
| `transcriptions` | `/audio/transcriptions` | WAV 分段上传，JSON `text` |
| `transcriptions-sse`（新配置默认） | `/audio/transcriptions`，multipart + `stream=true` | 分段上传后增量输出 |
| `openai-websocket` | `/realtime?intent=transcription` | OpenAI session/delta 协议，持续 PCM 输入 |
| `step-websocket` | `/realtime/asr/stream` | 独立 Step wire adapter，累计文本、修订、commit/final |
| `mimo-sse` | `/chat/completions`，`input_audio` + `stream` | 供应商扩展，片段上传后增量返回 |
| `step-sse`（旧接口） | `/audio/asr/sse`，`audio.data/input` | 供应商扩展，仅明确支持时使用 |

原生 WSS 共用连接、鉴权、浏览器采集和事件转发机制，各协议 adapter 只处理上游 wire format。浏览器通过现有 owner 鉴权 HTTP 上传约 100 ms PCM，使用 NDJSON 接收识别事件，服务端保持上游 WSS；密钥仅在服务端通过 `Authorization` 请求头发送。客户端 VAD 手动 commit，停说等待 final；挂断、断网、租约失效和配置变更关闭媒体流与连接。

`transcriptions-sse`、`mimo-sse` 与 `step-sse` 均为分段上传后的流式输出，不是双向连续音频。浏览器在约 1.5 秒音频或停说后形成 WAV 分段；SSE 最多 2 个分段请求并发，结果按分段顺序合并。模型必须支持所选接口；例如历史 Step 文件转录使用 `stepaudio-2.5-asr`，不能替换成仅支持 WSS 的 `-stream` 模型。Step 1.1 增量 delta 语义不在 Step adapter 范围。

## 实时路由配置

设置页可选填完整实时 WSS 地址。不填写时按所选协议与 `baseURL` 构造默认路径；持久化的 `asr.realtime` 还支持非敏感查询配置：

```json
{
  "asr": {
    "protocol": "openai-websocket",
    "model": "your-transcription-model",
    "realtime": {
      "url": "wss://speech.example/v1/realtime?region=example",
      "query": { "model": "{model}" }
    }
  }
}
```

`url` 接受完整 `ws(s)` 或 `http(s)` 地址，HTTP(S) 会转换为 WS(S)，可包含非敏感 query；`query` 叠加路由字段，支持 `{model}` 替换并安全编码。不能包含用户名、密码、片段、API Key、token 或授权查询字段；密钥仍走服务端 `Authorization`。供应商切换且未显式提供新的 `realtime` 时清理旧覆盖，避免沿用上一个服务的路径和查询。

以下只是 RouterGo 的显式配置实例，不是默认路径，也不触发域名或供应商识别：

```json
{
  "asr": {
    "protocol": "step-websocket",
    "model": "stepaudio-2.5-asr-stream",
    "realtime": {
      "url": "wss://routergo.cn/api/v1/realtime",
      "query": {
        "model": "{model}",
        "intent": "transcription",
        "exit_id": "stepfun.audio.transcriptions.websocket"
      }
    }
  }
}
```

## TTS 合同

默认 `speech` 使用 `/audio/speech`，仅发送 `model`、`voice`、`input`、`response_format: pcm`；明确选择 `step-speech` 才额外发送 `sample_rate: 24000`、`stream: true`。无协议字段且模型明确属于旧 Step TTS 时兼容推断为 `step-speech`，显式 `speech` 始终覆盖推断。默认音色分别为 `alloy` / `cixingnansheng`，用户填写的音色优先。

两种协议共用 PCM16LE、24 kHz、单声道播放合同；上游元数据冲突即拒绝。允许三段并发预取，响应禁止代理缓冲。接口路径兼容不保证所有模型、音色或媒体格式均可用，需按服务实际能力配置。

## 当前输入与播放确认（2026-10-16）

语音通话只把识别转录提交给官方 `conversation.send(text)`，不再追加“已完整听到 / 未确认完整听到”等播放状态注记。该接口没有逐轮私有上下文参数，目前也未接入其他可靠的私有播放上下文通道。AudioWorklet ACK、插话停止播放和取消生成仍在本地生效；模型不能据此判断用户听到的具体位置。发送失败仅恢复待发转录，挂断和切换会话清除旧输入，旧异步错误与播放器回调不影响新通话。此前追加播放事实到普通用户消息的行为已移除；历史会话消息不改写。

## 验证

历史记录（2026-10-16）：当时语音测试 90/90 通过，覆盖 SSE partial/final、截断/取消、Step WSS update/append/commit/修订/final、当时的 RouterGo 路由、下行背压、鉴权、PCM 转发、配置失效、stop 等待 final 和草稿 revision 冲突；当时客户端构建通过，新增运行依赖 `ws@8.19.0`。这不是当前测试计数。

本轮新增通用实时路由配置、OpenAI WSS adapter 和标准/Step TTS 协议隔离；OpenAI adapter 仅经本地 mock（含本机 WebSocket）验证，尚未进行真实供应商账号联调。真实 WSS 仅有下文 101 握手记录，不能视为音频事件闭环成功。本轮实际测试结果以交付记录为准，不沿用历史计数。

通话 conversation without inject 已修复：从真实 Cordis 未注入 session scope 通过 get 获取 conversation，发送和取消回归通过。录音波形来自真实 PCM RMS；朗读与通话使用独立 Iconsax 图标，提供状态气泡和 reduced-motion。

## 供应商实例与历史验证

以下为特定供应商、模型和部署环境的历史事实，不定义通用协议或当前默认配置。

### 早期 RouterGo 探测记录（已由下方正确路由复测更新）

仅使用服务生成的短测试语音，无历史消息或用户录音。密钥仅服务器内读取，未输出到日志或文档。

| 请求 | 实际结果 |
| --- | --- |
| Step TTS stepaudio-2.5-tts / cixingnansheng / pcm / 24000 | 200，audio/pcm，103680 bytes，PCM16 mono24k 为 2.16 秒 |
| MiMo TTS mimo-v2.5-tts / alloy / pcm | 400，参数校验失败 |
| MiMo ASR mimo-v2.5-asr / chat/completions stream | 503 |
| Step /audio/asr/sse | 404；本次探测使用 stream 模型，非 SSE 合规模型 |
| WSS `/realtime/asr/stream` | 旧探测路径不适用于 RouterGo |
| RouterGo WSS `/api/v1/realtime?model=stepaudio-2.5-asr-stream&intent=transcription&exit_id=stepfun.audio.transcriptions.websocket` | 101 Switching Protocols；握手后保持连接，尚未完成真实音频会话验证 |

协议实现和 mock 验证完成；RouterGo Step WSS 已完成 101 握手验证，真实音频事件闭环和延迟仍待账号联调。MiMo/Step SSE 已有真实接口验证。真实手机麦克风、外放回声、弱网长通话未验证。TEN VAD、RNNoise 尚未迁移；持续 sinc 重采样与自适应起播缓冲已在本轮实现。

协议依据：Step 官方 api-reference/audio/asr-stream.md、asr-sse.md，以及 MiMo Speech Recognition API 文档。


### 正确 RouterGo 路由复测与修复（2026-10-16）

使用服务端现存供应商凭据，生成一句合成测试语音，不使用用户录音、不输出密钥，不修改官方引擎。

- MiMo `mimo-v2.5-asr`、Step `stepaudio-2.5-asr`：正确接口均为 `POST /audio/transcriptions`，multipart `file/model/response_format=json/stream=true`，`Accept: text/event-stream`。真实均 200，收到多个 `transcript.text.delta` 和最终 `transcript.text.done`；测试音正确转写。模型列表支持 ASR 不表示网关支持厂商私有路径。
- 2026-10-17 同一段 2.84 秒测试音复测：MiMo 首 partial/final 为 2253/2439 ms；Step `stepaudio-2.5-asr` 为 4365/4388 ms；Step `stepaudio-3-asr-max` 为 4845/4911 ms。此前对 RouterGo 旧路径的 404/503 探测已被纠正：正确 `/api/v1/realtime` 路由可完成 101 握手。
- RouterGo `stepaudio-2.5-asr-stream`（实时转写）和 `stepaudio-3-realtime-preview`（实时对话）均已确认可 101 升级；前者可通过 DSH-Plus 的 Step adapter 与显式实时路由配置接入，后者是完整双向对话协议，当前自有 Agent + ASR + TTS 架构暂不直接使用。
- 早期 `/chat/completions` MiMo 请求仍返回 503 `model_unavailable`，私有 Step `/audio/asr/sse` 使用正确非 stream 模型也为 404。因此新增明确的 `transcriptions-sse` 协议，不再将两个失败接口误判为 ASR 模型本身不可用。
- 插件真实处理器复测：Step TTS 200，41 个 PCM 包、122880 字节；合成音进入 MiMo ASR 后，NDJSON 返回 8 次 partial 和 final，文本为“你好，这是流式语音测试。”。单样本 TTS 首包约 3226 ms，ASR 首 partial 约 3171 ms、final 3422 ms；只是当次服务端时间，不是浏览器端整轮延迟或性能保证。
- ASR 属于持续采集、分段提交、响应增量的组合架构。RouterGo 原生双向 WSS 已完成握手验证，完整音频事件闭环仍待真实账号联调；不能将 SSE 描述为持续 PCM 双向识别。
- 历史迁移曾针对已知 RouterGo MiMo/Step 文件模型补齐 `transcriptions-sse`。当前迁移不判断 RouterGo 域名或供应商 ID，只对无协议字段的明确旧模型兼容推断；显式协议保留。迁移生效于启动内存快照，下次用户保存设置时持久化。
- Step 原生 ASR 清空使用 `asr.clear`：替换上游 socket，等待新 `session.updated`，保留浏览器 session id 与事件流，旧 socket epoch 事件全部丢弃，避免不支持 clear 的供应商污染新输入。
- TTS 采样率/声道元数据若与 24 kHz mono 矛盾立即拒绝；保持 PCM 半样本跨包拼接和取消传播。错误仅向前端返回状态与有界机器码，不转发供应商原始错误消息。

### `MALFORMED_RESPONSE` 根因

线上默认 `deepseek-official` 适配器被配置到 RouterGo `/messages`。真实短请求返回 200 SSE，但只有 `message_delta` 和 `message_stop`，无 `message_start` 或内容块。官方引擎按合同拒绝并报 `event precedes message_start`；朗读只消费已有 Agent 输出，不制造这些事件。相同模型 RouterGo `/chat/completions` 返回正常 `chat.completion.chunk`。应使用共享供应商 `routergo` 的 `openai-completions` 路由，不伪造缺失事件，也不修改官方翻译器。


### 历史部署路由修复

当时该部署的默认路由已在 `.local/web/router.overlay.yml` 与 Web profile patch 持久改为 `routergo / deepseek-v4.1-flash`，修改前文件保存在 `.local/web/backups/voice-route-*`（目录 0700、文件 0600）。当前已加载、空闲且使用不兼容默认路由的失败会话通过官方 `session/selectModel` 切到同一模型的 RouterGo 路由，并用 `session/list` 复核；未编辑任何 Session append-only 日志，其他工具/模型选择未改变。服务重启由主部署流程执行。

### 技术方案边界

后端对应技术方案的职责包括：固定 24 kHz PCM16 mono 媒体合同、受限并发、流式转录/合成、取消传播、配置失效、原生 ASR 连接 epoch 隔离和清空、供应商路由实测。不把 SSE 音频文件识别标成原生双向识别，不把有限真实样本延迟当作性能保证。TEN VAD、RNNoise、Go 服务实现不在本后端移植范围；前端轮次/安全断句/连续播放/ACK 的具体实现以对应源码与验证记录为准。


### 可朗读过滤实现记录

跨增量保留行内代码内容；代码块、表格、裸 URL 分别每轮至多一次替代提示。Markdown 链接仅读标签，长未闭合链接/围栏仅保留有界状态。过滤短动作/舞台描述与表情，保留普通括号解释；仍使用同步有界处理进入现有三并发 PCM 队列，不等待网络或播放。断句保留完整句优先和安全 idle 补切。
