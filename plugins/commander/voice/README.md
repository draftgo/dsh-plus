# DSH-Plus 语音

最新流式识别协议、使用方式和真实供应商状态见 [STREAMING.md](STREAMING.md)。下文分段接口说明为兼容参考。

DSH-Plus 内置语音模块，目录 `plugins/commander/voice/`，技术包名 `@dowork/commander`。不修改官方引擎，复用官方输入框、消息流、模型选择、Agent 与人工审批。

## 使用

在「设置 → 语音」中分别启用语音转文本、朗读回复、实时通话，填写 ASR/TTS 的 API 地址、模型、密钥和 TTS 音色，保存后即可使用。三项默认关闭，不预设供应商或冒用文字模型凭据。

- **语音转文本**：输入工具栏的麦克风开始/停止；每约 2 秒上传一个 WAV 片段，按顺序实时更新可编辑草稿。不会自动发送。用户编辑导致草稿 revision 变化时保留转录提示，不覆盖用户输入。
- **朗读回复**：点击独立扬声器图标切换，悬停显示开启/关闭气泡。开启后跟随新生成的当前对话输出，按句预取合成、按顺序流式播放；最终消息按 turn/step 关联流式 attempt，只补读尚未推送的后缀，不重读已推送正文或历史。
- **实时通话**：点击「通话」，停说并识别完成后提交给当前对话的原有 Agent。仅发送真实转录文字，不追加内部播放状态。用户再次开口立即清空本地播放、取消当前生成，隔离迟到结果；工具权限仍须在原有屏幕界面确认，语音不自动批准。点击「挂断」释放采集、识别、合成、播放与通话租约。

浏览器需要 HTTPS 或 localhost，以及麦克风授权；远程服务部署时使用已配置的 HTTPS 域名。所有请求走现有 Harness owner 鉴权，无额外中继。ASR 接收音频，TTS 接收经过过滤的回复文本，当前 Agent 接收转录文本，实际数据出口取决于你填写的服务地址。

## 模型接口

ASR：`POST <baseURL>/audio/transcriptions`，multipart 字段 `file`（24 kHz 单声道 PCM16 WAV）、`model`，接受 JSON `text`。首版是**分段实时转录**，不是供应商原生 WebSocket/token 级 ASR。

TTS：`POST <baseURL>/audio/speech`，JSON `model`、`voice`、`input`、`response_format: pcm`；供应商必须返回 **PCM16LE / 24000 Hz / 单声道**音频流。MP3、WAV、其他采样率不在首版适配范围。并非任意文字模型 API 都支持这些接口。

API Key 仅存服务端，配置文件权限 0600，目录权限 0700。前端只获得已配置标记和掩码；留空密钥保留原值，明确点击清除才删除。存储为 `$DSH_HOME/voice/config.json`，插件配置 `dataDir` 可覆盖。

## 安装与构建

```sh
npm --prefix plugins/commander install --ignore-scripts
npm run build:voice
npm run test:voice
```

向官方 profile 的 `package.json` 添加 `dependencies: {"@dowork/commander":"link:/absolute/path/plugins/commander"}`，并在 `dsh.profile.bundles` 数组加入 `@dowork/commander`，在该 profile 安装依赖后由官方 `dsh web` / Desktop 启动。当前服务器 Web profile 已接入；其他 profile 需自行安装。不改上游工作区、源码或锁文件。

## 机制与边界

参考 [实时语音 Agent 处理层实现详解](../../../Design/实时语音Agent处理层实现详解.md)（DraftGo 分析基线 `eed72d1`），复用其生命周期、取消隔离和播放确认思路。本文描述本插件实际实现，不能把原项目的全部能力视为已经迁移。

- AudioWorklet 连续采集和播放，保留重采样相位；24 kHz PCM16LE。实际消费完整片段后确认播放，收到数据不等于听到。
- 浏览器 AEC / NS / AGC，自适应 RMS VAD、预卷和停说判定。已使用持续 windowed-sinc 重采样与自适应起播缓冲；**未移植 TEN VAD、RNNoise**，外放建议先用耳机验证。
- 文本可朗读过滤、安全断句、2 路 TTS 预取、有序播放、有限缓冲；过滤不等于完备敏感数据防护。
- 单会话单主动设备，45 秒租约，15 秒心跳，最长 30 分钟；进程重启不恢复旧音频、不重放工具。
- 挂断、断网、切换会话、插件卸载和配置更新传播取消；取消不会撤销已经完成的工具操作。
- 播放确认仅用于本地片段队列与播放状态，不发送给 Agent，也不追加到用户消息。官方 `conversation.send(text)` 将文本原样提交为用户消息，目前没有接入可按轮安全传递播放事实的私有上下文接口；不承诺模型知道用户实际听到的位置。发送失败仅恢复待发转录，切换会话丢弃旧会话待发内容与迟到回调。

验证包含模拟供应商协议、取消、租约、音频采样/队列、输出过滤和客户端 Agent 事件桥接；未使用实际 ASR/TTS 供应商账号验收，未测真实手机麦克风、外放回声和弱网长通话。
