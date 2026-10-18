# Harness 工具安装管理

参考 CC Switch `51ac86f` 的 `commands/misc.rs` 工具清单与 npm 包映射；`reference` 仅作参考，不参与运行。

## 已实现

- 固定工具清单：Claude Code、Claude Desktop、Codex、Gemini CLI、Grok Build、OpenCode、OpenClaw、Hermes、Pi、MiniMax Code。`grokbuild`、`minimax` 等别名归一化。
- npm 工具安装到 DSH-Plus 独占 `<root>/<tool>` 前缀，使用固定官方包名及 `@latest`；启用 Node engines 严格检查，依赖可选二进制纳入安装。安装成功后必须验证托管入口存在且 `--version` 成功，即使系统同名工具已安装也不会误用系统入口完成验证。
- Hermes 使用 `uv tool install` 与官方 Git 仓库，隔离工具目录、Python 3.14 和命令目录；没有 uv 时展示明确原因，不尝试错误的同名 PyPI 包。
- 异步任务：排队、默认最多 2 个并发、同工具互斥、15 分钟超时、取消、有限日志与状态；公开输出脱敏，安装子进程不继承服务中的 API Key 等秘密变量。安装脚本与版本检查使用独立 HOME/XDG/AppData，不继承 CODEX_HOME、CLAUDE_CONFIG_DIR 等用户配置位置，避免安装时读写现有账户。Linux/macOS 取消整个进程组；取消后必须等子进程退出才释放管理锁。
- 卸载仅移除有 DSH-Plus 安装凭据的独占工具前缀，保留用户配置、聊天历史、外部安装。目录已存在但无凭据时拒绝认领或覆盖；拒绝符号链接目录。`isRunning(toolId)` 拒绝操作运行中的工具。
- 生命周期通过 `install`、`update`、`reinstall`、`uninstall` 明确区分：安装仅创建独立副本；更新在已有托管前缀更新到最新版本，Hermes 显式使用 uv `--upgrade`；重装清理托管前缀后重新安装；卸载移除托管前缀。更新、重装、卸载均要求 DSH-Plus 安装凭据，绝不对系统安装执行全局管理。安装失败仍保留凭据，可重装或卸载清理；不承诺更新失败自动回滚。
- `resolveExecutable(toolId)` 优先保留系统 PATH 工具，没有系统安装时才使用带有效凭据的托管入口；安装独立副本不会自动抢占用户原来的工具。检测排除指向托管目录的 PATH 与符号链接，准确区分来源。
- 清单同时返回 `systemExecutable`、`managedExecutable`、`managedInstalled`、`managedVersion` 与当前 `executable/source`，以及安装、更新、重装、卸载的可用性和不可用原因，允许同时展示两份工具。保留 `source: external/managed/none` 契约。
- `resolveLaunch(toolId)` 提供无 shell 的 Windows npm JS 入口解析，系统 npm shim 从自身目录解析包，托管副本从托管前缀解析，返回 `{ command, args }`。接管适配器应同时传递 `args`。

## 支持边界

- npm 安装支持 Linux、macOS、Windows；Windows 需要 Node 附带 `npm-cli.js`。Windows 安装路径逻辑已做模拟测试，未在真实 Windows 安装验证。
- Hermes 当前支持 Linux/macOS，依赖 uv 与 Git，Windows 自动安装暂不支持。该方式为最小 CLI 安装，不自动运行 setup、添加服务或安装所有额外组件。
- Claude Desktop 展示配置能力，但自动安装/卸载暂不支持；需使用官方平台安装器，Linux 不支持。
- 外部工具仅检测命令位置，版本保持未知；不以猜测版本或空跑假装安装成功。外部工具的全局更新、卸载与安装迁移不在此版范围；用户可以主动安装并管理另一份 DSH-Plus 独立副本，系统工具保持默认优先。
- 目录清单不代表每个工具均已完成聊天接管；`chatSupported` 与 `configSupported` 分开标记。当前接管 Claude Code/Codex/Pi/OpenCode，其余由配置适配层管理。
- 未覆盖 CC Switch 的 MCP/Skills、反向代理、托盘与完整平台更新器；不能据此宣称完美平替全部功能。

## 验证

`node --test plugins/commander/test/tool-install.test.mjs` 使用临时目录与 fake executor 验证生命周期；不会安装或卸载当前机器的真实工具。另以 Node 无害子进程验证 argv 无 shell 与取消。真实发行包安装及桌面平台联调仍需在对应环境验证。
