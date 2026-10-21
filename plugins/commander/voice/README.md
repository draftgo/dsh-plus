# DSH-Plus 语音

协议配置、使用方式与验证范围见 [STREAMING.md](STREAMING.md)。默认采用 OpenAI 兼容接口；供应商特有协议需要明确选择。

DSH-Plus 内置语音模块，目录 `plugins/commander/voice/`，技术包名 `dsh-plus`。不修改官方引擎，复用官方输入框、消息流、模型选择、Agent 与人工审批。

## 使用

在「设置 → 语音」中分别启用语音转文本、朗读回复、实时通话，填写 ASR/TTS 的 API 地址、模型、密钥和 TTS 音色，按服务支持范围选择协议后保存。原生实时识别还可填写完整 WSS 地址。三项默认关闭；新配置中的 Step 2.5 模型 ID 仅是当前预填偏好，不预设或绑定供应商，也不代表该模型能在任意服务上使用。

- **语音转文本**：输入工具栏的麦克风开始/停止；普通 HTTP/SSE 每约 1.5 秒上传一个 WAV 片段，按顺序实时更新可编辑草稿。不会自动发送。用户编辑导致草稿 revision 变化时保留转录提示，不覆盖用户输入。
- **朗读回复**：点击独立扬声器图标切换，悬停显示开启/关闭气泡。开启后跟随新生成的当前对话输出，按句预取合成、按顺序流式播放；最终消息按 turn/step 关联流式 attempt，只补读尚未推送的后缀，不重读已推送正文或历史。
- **实时通话**：点击「通话」，停说并识别完成后提交给当前对话的原有 Agent。仅发送真实转录文字，不追加内部播放状态。用户再次开口立即清空本地播放、取消当前生成，隔离迟到结果；工具权限仍须在原有屏幕界面确认，语音不自动批准。点击「挂断」释放采集、识别、合成、播放与通话租约。

浏览器需要 HTTPS 或 localhost，以及麦克风授权；远程服务部署时使用已配置的 HTTPS 域名。所有请求走现有 Harness owner 鉴权，无额外中继。ASR 接收音频，TTS 接收经过过滤的回复文本，当前 Agent 接收转录文本，实际数据出口取决于你填写的服务地址。

## 模型接口

ASR 默认采用 OpenAI 兼容 `POST <baseURL>/audio/transcriptions`：multipart 字段包含 `file`（24 kHz 单声道 PCM16 WAV）、`model`、`response_format: json`。`transcriptions` 接收 JSON `text`；`transcriptions-sse` 额外发送 `stream=true`，接收转录增量。SSE 是分段上传后的流式输出，不是持续音频输入。

持续 PCM 输入显式选择 `openai-websocket` 或 `step-websocket`：前者使用 OpenAI session/delta 协议，默认 `<baseURL>/realtime?intent=transcription`；后者是独立的 Step wire adapter，默认 `<baseURL>/realtime/asr/stream`。两者共用 20 ms PCM 采集、独立二进制 WebSocket、有界发送队列、服务端 WSS 和取消机制；不会根据域名或供应商 ID 改写路由。`asr.realtime.url` 可配置完整 HTTP(S)/WS(S) 地址及非敏感查询参数，`asr.realtime.query` 支持非敏感路由字段与 `{model}` 占位符，详见 [STREAMING.md](STREAMING.md)。切换供应商会清理旧实时路由覆盖；显式 `protocol` 优先，只有无协议字段的明确旧模型配置保留兼容推断。

TTS 默认 `speech` 使用 OpenAI 兼容 `POST <baseURL>/audio/speech`，只发送 `model`、`voice`、`input`、`response_format: pcm`。明确选择 `step-speech` 才额外发送 `sample_rate: 24000`、`stream: true`；无协议字段的明确 Step 旧模型保留兼容推断，显式 `speech` 可覆盖。播放合同统一为 **PCM16LE / 24000 Hz / 单声道**，并拒绝冲突的采样率或声道元数据；MP3、WAV、其他采样率不在当前适配范围。并非任意文字模型 API 都支持语音接口。

API Key 仅存服务端，通过上游 `Authorization` 请求头传递，禁止放入实时 URL 或查询参数。配置文件权限 0600，目录权限 0700。前端只获得已配置标记和掩码；留空密钥保留原值，明确点击清除才删除。存储为 `$DSH_HOME/voice/config.json`，插件配置 `dataDir` 可覆盖。

## 安装与构建

```sh
npm --prefix plugins/commander install --ignore-scripts
npm run build:voice
npm run test:voice
```

向官方 profile 的 `package.json` 添加 `dependencies: {"dsh-plus":"link:/absolute/path/plugins/commander"}`，并在 `dsh.profile.bundles` 数组加入 `dsh-plus`，在该 profile 安装依赖后由官方 `dsh web` / Desktop 启动。当前服务器 Web profile 已接入；其他 profile 需自行安装。不改上游工作区、源码或锁文件。

## 机制与边界

复用历史实时语音处理层的生命周期、取消隔离和播放确认思路。本文描述本插件实际实现，不能把原项目的全部能力视为已经迁移。

- AudioWorklet 连续采集和播放，保留重采样相位；24 kHz PCM16LE。实际消费完整片段后确认播放，收到数据不等于听到。
- 浏览器 AEC / NS / AGC，自适应 RMS VAD、预卷和停说判定。已使用持续 windowed-sinc 重采样与自适应起播缓冲；**未移植 TEN VAD、RNNoise**，外放建议先用耳机验证。
- 实时上行待发送队列最多 600 ms，拥塞淘汰旧帧并提示，避免延迟累积；不会因此直接挂断。播放 60–180 ms 自适应起播、短暂欠载不解除回声保护，插话确认 200 ms、停说 320 ms（实现值，非端到端性能保证）。
- 文本可朗读过滤、首句/首分句及时合成、3 路 TTS 预取、有序播放、有限缓冲；过滤不等于完备敏感数据防护。
- 单会话单主动设备，45 秒租约，15 秒心跳，最长 30 分钟；进程重启不恢复旧音频、不重放工具。
- 挂断、断网、切换会话、插件卸载和配置更新传播取消；取消不会撤销已经完成的工具操作。
- 播放确认仅用于本地片段队列与播放状态，不发送给 Agent，也不追加到用户消息。官方 `conversation.send(text)` 将文本原样提交为用户消息，目前没有接入可按轮安全传递播放事实的私有上下文接口；不承诺模型知道用户实际听到的位置。发送失败仅恢复待发转录，切换会话丢弃旧会话待发内容与迟到回调。

验证包含本地模拟协议与 WebSocket、取消、租约、音频采样/队列、输出过滤和客户端 Agent 事件桥接。历史 RouterGo HTTP/SSE ASR 与 Step TTS 已使用合成短音真实探测；原生 WSS 仅确认 101 握手，尚无真实音频闭环。新增 OpenAI WSS adapter 仅经本地 mock 验证，未用真实账号联调；真实手机麦克风、外放回声和弱网长通话未验证。具体记录见 STREAMING.md。
