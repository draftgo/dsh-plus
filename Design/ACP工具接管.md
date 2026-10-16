# ACP 工具接管

## 参考与范围

参考 Paseo `d57096a45` 的 `packages/app/src/data/acp-provider-catalog.ts` 和 `packages/server/src/server/agent/providers/acp-agent.ts`；原参考代码使用 Apache-2.0，仓库已有 `plugins/commander/PASEO-LICENSE`。本实现复用协议思路与公开命令契约，未复制其业务实现。

已实现通用 JSON-RPC ACP 客户端 `src/providers/acp.mjs`，默认入口：

| 工具 | 启动 | 参考版本 |
| --- | --- | --- |
| Gemini CLI | `gemini --acp` | 0.52.0 |
| Hermes | `hermes acp` | manual |
| Grok Build | `grok agent stdio` | 0.2.11 |
| MiniMax Code | `mcode acp` | 0.1.2 |

安装版本必须实际支持上述 ACP 协议；失败会直接返回工具错误，不回退到裸 shell 或假装支持。

## 已实现能力

- `initialize`、`session/new`、`session/load`、流式 `session/update`、`session/prompt` 与 `session/cancel`。恢复必须有 `loadSession` 能力，缺失历史或不匹配 ID 显式拒绝，不创建替代会话。恢复时的历史通知不再当成新消息输出。
- 原生模型表及配置选项发现，选择模型通过 `session/set_model` 或 `session/set_config_option`；未公布模型拒绝猜测。`driver.models()` 读取当前会话，无额外会话。
- 新建和恢复会话均注入 Commander stdio MCP（`command/args/env`），支持主动跨工具委派。stdio 属于 ACP 基础协议，不依赖 HTTP/SSE 能力声明。工具拒绝 MCP 时明确报错，不静默移除委派或退回 shell。
- 获取原生会话 ID 后先通知宿主持久化并等待完成，再执行可失败的模型切换，避免生成不可追踪的孤儿会话。
- 原生命令 `available_commands_update`、文本/思考/工具调用/计划流；原生上下文通知保留为信息事件，不把上下文占用伪装成计费 token。
- 权限请求转发 DSH 授权，仅单次明确允许选择 `allow_once`；其他情况、超时、取消和不提供单次允许的工具均拒绝。永不自动选择 `allow_always`。
- 不宣称提供客户端文件系统或终端能力，相关反向 RPC 显式拒绝；不增加绕开权限的执行路径。
- 初始化、提示、授权与取消响应均有超时，异常关闭进程与待处理 RPC。进程生命周期沿用 `LineProcess`。

## 集成契约与边界

- 导出 `acpProviderClasses` 与 `ACP_TOOL_DEFAULTS`，由 runtime 注册。配置 `args` 是 launcher 的前置参数，其后附加固定 ACP 参数，便于 `node cli.js --acp` 等无 shell 入口。
- `provider.models({cwd,nativeId})` 用短连接查询，但无 nativeId 时会创建真实原生会话；不要在探索页自动调用它制造空会话。优先复用连接后 `driver.models()`，或采用已有供应商模型表。
- 会话列表仅在工具声明 ACP list 时可用；独立历史查询尚无统一 ACP 方法，使用已有 `session/load` 回放，不伪造 history。
- 未实现 ACP 文件客户端、终端客户端、多媒体提示、进程外持久会话与自定义厂商扩展；不自动接管工具自带后台服务。
- 通过 fake ACP 子进程覆盖四种入口、新建/恢复的委派 MCP 参数、拒绝委派、模型失败前 ID 持久化、恢复、模型、命令、消息、授权、取消与超时。未在本机真实安装四种工具或调用付费模型。
