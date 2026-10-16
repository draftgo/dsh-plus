# DSH-Plus 工具管理与 CC Switch 替代进度

参考版本：reference/cc-switch@51ac86f；ACP 命令参考 reference/paseo@d57096a45。参考目录不参与运行依赖，官方 Harness 源码不修改。

## 已实现

入口：设置 → Harness 工具。官方设置 → 模型继续负责供应商增删改及密钥；工具管理只保存 providerId 引用。

| 工具 | 隔离安装/卸载 | 原生供应商配置 | 对话接管 |
| --- | --- | --- | --- |
| Claude Code | npm | JSONC settings | SDK |
| Codex | npm | TOML | app-server |
| Pi | npm | JSON 模型与设置 | RPC |
| OpenCode | npm | JSONC | HTTP |
| Gemini CLI | npm | JSONC + env | ACP |
| Hermes | uv，需 uv 与 Python 3.14 | YAML | ACP |
| Grok Build | npm | TOML | ACP |
| MiniMax Code | npm | JSON | ACP |
| OpenClaw | npm | JSON5 | 尚未接入 |
| Claude Desktop | 官方安装器手动安装 | 第三方 gateway profile | 尚未接入 |

安装有队列、日志、取消和超时；卸载只移除本插件管理目录，保留原生配置及历史；外部安装可检测并使用，不能一键卸载。平台不兼容及缺少 uv 时显示原因。不会自动安装全部工具。

供应商适用工具多选；模型自动读取共用供应商目录，也可手填 ID。协议按工具选择，不把 OpenAI Chat、Responses、Anthropic、Gemini 当作同一个协议。适配不包含协议转换代理。

高级 JSON 按原生文件角色组织，支持推理参数等覆盖项，禁止密钥、地址、环境、执行入口覆盖。保存仅形成草稿；预览确认后备份并写入，运行时仅采用已应用方案。原文件未知字段保留；配置及备份权限0600；校验和防止覆盖外部修改；恢复保留逐字节原内容。运行中工具禁止应用/恢复/卸载。

ACP 模型菜单不创建空会话：初始使用默认模型或已应用模型；已有连接可复用原生广告模型。原生未广告某模型时拒绝强行切换。恢复、权限、取消均按工具声明能力执行，不模拟成功。MiniMax 配置登记模型目录，默认模型仍由原生工具管理。

## 待实现的完整 CC Switch 平替范围

当前完成上述安装与供应商配置核心闭环，不等于 CC Switch 全功能平替。代理接管/协议转换、聚合与故障转移、MCP/Skills/Prompts 统一同步、CC Switch 数据导入导出、云同步、Desktop 一键安装及 OpenClaw 会话接管尚未实现。Harness 标签只保存适用范围元数据，原生官方模型页面筛选不受此标签控制。

## 验证范围

配置与安装测试使用临时目录和模拟执行器；ACP 使用假进程测试真实 JSON-RPC 生命周期及权限拒绝，不产生付费推理。已跑插件回归、语音回归、客户端构建和根目录一致性检查；不声称全部真实工具联网推理已通过。

本轮实际结果：插件118/118、语音54/54通过；客户端构建、npm run check通过。线上只读浏览器验证：工具目录200，10工具/3已配置供应商，设置页、工具切换、适用范围弹窗正常，pageerror为0。未在生产配置上测试应用/恢复，相关写入闭环已在临时home测试。
