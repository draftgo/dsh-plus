# 首版验证记录

## 2026-10-16 语音输入正文清理

- 官方 `IConversation.send(text)` 只接收文本并按用户 text block 原样提交；未接入可靠的逐轮私有播放上下文。已移除拼接到转录后的播放状态注记及其正文缓存，Agent 和消息列表只接收真实转录。旧会话已保存的历史消息保持原样。
- 保留 AudioWorklet 消费 ACK、本地有界片段队列、插话停止播放和取消生成；播放确认改为片段 ID 集合，不再缓存已听正文。发送失败恢复转录；切换会话屏蔽旧发送/取消失败和旧播放器回调。
- 新增纯转录、插话取消与 ACK、失败后重试、跨会话迟到结果回归；`npm run test:voice`：84/84 通过。未执行真实 ASR/TTS、视觉验收或图形启动，客户端构建由主流程统一执行。

## 2026-10-16 自动朗读去重修复

- 根因：官方成功回复通过普通 `append` 发布最终 `assistant/message`，消息仅含 turn/step；流式正文却按 attemptId 缓存。原桥接只正确处理 `settle-assistant`，普通追加无法匹配已朗读前缀，导致整条回复再读一次。
- 修复：按 turn/step 关联流式 attempt，最终消息只补发未推送后缀；无正文的 attempt 退役也清理缓存。自动朗读和实时通话共用这一去重路径，不按正文内容全局去重，后续相同回复仍可正常播放。
- 验证：`npm run test:voice`，81/81 通过。新增回归覆盖成功追加、重复发布、流式基线、跨 step 相同正文，以及自动朗读开启后进入通话仍只有一条播放链。
- 未执行图形应用、视觉检查或真实 TTS 播放；客户端构建由本次集成统一执行。

最新补充验证见 [STREAMING.md](STREAMING.md)，下文为首版历史记录。

日期：2026-10-16。只验证本插件及其公开接入点，未修改官方引擎与参考仓库。

- `npm run test:voice`：原独立语音测试 40/40 通过。覆盖配置持久化/密钥脱敏、模拟 ASR/TTS、流取消、同设备租约、采集重采样、实际消费 ACK、分段转写顺序、断句过滤、合成预取、Agent 增量去重、插话和启动/挂断竞态、审批保护。
- `npm --prefix plugins/commander run build:client`：通过。
- `npm run check`：官方 0.2.1-alpha.3，提交 571902028a75c64c1d767f4ae5fd099485f0ddf0，子模块干净；此命令不是功能验收。
- 当前 Web profile 已添加并安装 `dsh-plus`，服务正常；认证后的 `/api/voice` 返回默认全关闭、模型未配置的安全配置；匿名访问仍受官方鉴权保护。
- Chromium 交互检查：设置 → 语音页显示三个开关与模型配置，未捕获页面错误。
- Chromium 假麦克风 + 浏览器拦截的转录 fixture：输入栏麦克风启动、停止、AudioWorklet 加载及转录文字回填原生草稿成功，无页面错误。fixture 仅在该浏览器上下文生效，未保存测试供应商配置、未发真实模型请求、未创建聊天消息。

未验证：真实供应商、真实麦克风/扬声器及移动设备，长通话外放回声、弱网和服务端进程退出的工具取消。持续 sinc 重采样、自适应起播缓冲已实现；尚未迁移 TEN VAD、RNNoise 和完整生产延迟指标。ASR 当前为分段实时 HTTP 转录；TTS 要求原始 PCM16LE 24k 单声道流。

## 2026-10-20 低延迟媒体调度

- 二进制持续上行替代实时路径的逐包 HTTP/NDJSON；20 ms 采集、600 ms 有界待发、12 帧 ACK 窗口、拥塞丢旧/过期音频并反馈，保留供应商 PCM 协议与显式模型选择。
- Web/Desktop 复用官方 owner upgrade 鉴权；Link 工作台与设备本地代理增加配对认证通道，连接 ticket 一次性且 10 秒有效，撤销设备/租约/配置关闭媒体。部署样例增加精确 WS 升级路由。
- 停说/插话/起播参数、首分句流式合成、取消释放与旧路径删除见 STREAMING.md；没有引入 Opus、TEN VAD、RNNoise，也未将参考项目文档当作已实现能力。
- 本地真实 WebSocket fixture 验证二进制 PCM → 上游 append/commit → final、clear 重连 epoch、ticket 重放/错误租约拒绝、租约关闭；浏览器模拟验证延迟 ACK、队列淘汰/过期、跨语段屏障、拥塞警告、重复静音和未响应连接释放。未调用真实供应商、未启动图形应用，未验证真机麦克风、外放与弱网长通话。
- 最终自动回归：`npm run test:voice` 136/136；Link workbench/devices/transport 18/18。新增完整客户端 → 真实媒体 WebSocket → 模拟供应商 → final，以及真实 Cordis 兄弟 scope 的 Link 接入测试；Link 使用显式 `ctx.get('voice')` 获取可用服务，避免未注入属性在实际运行时抛错。挂断先于 start 响应的迟到租约也已验证释放。
- `npm --prefix plugins/commander run build:client` 通过，已同步客户端、Link 服务与服务器 seed；本次范围 `git diff --check` 通过。`npm run check` 确认官方子模块干净、入口一致，仅属结构检查。未修改或重载线上代理，未重启用户服务。
