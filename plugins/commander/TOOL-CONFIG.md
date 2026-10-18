# 原生工具配置服务

实现参考 reference/cc-switch@51ac86f 的配置格式，不参与参考项目构建。支持 Claude Code、Claude Desktop、Codex、Gemini、Grok Build、OpenCode、OpenClaw、Hermes、Pi、MiniMax Code。Claude Code、Codex、Pi、OpenCode、Gemini、Hermes、Grok Build、MiniMax Code 同时具备 Commander 会话驱动。配置支持不等于会话驱动支持。

createToolProfiles({directory, providers, home?, env?, platform?}) 同步创建服务；providers 传入现有 createModelProviders(ctx)，复用官方供应商和凭据，不复制供应商 CRUD。下列方法均异步：

- list() → {profiles,defaults,applied,backups,capabilities,bindings,native}；get(tool) → profile 或 null。
- save({tool,providerId,model,protocol?,overrides?,quickSettings?,contextWindow?,expectedRevision?}) → 带 revision 的方案草稿。保存仅写插件目录；setDefault({tool,revision}) 设置新会话默认，不写本机配置。原生同步另行显式执行 apply。
- setBindings({providerId,tools}) → {bindings}。tools 支持十工具及 harness；未设 binding 表示未限制，空数组表示未分配。供应商的 API 协议兼容性由用户选择，本服务不做协议代理转换。
- preview({tool,revision?}) → {tool,revision,files:[{role,path,exists,checksum,changed}],warnings}。不返回原生文件正文、diff 或密钥。
- apply({tool,confirmNativeWrite:true,revision,checksums:{path:checksum|null}}) → {tool,backupId,files:[{path,checksum}],warnings}。
- restore({backupId,confirmNativeWrite:true,checksums?}) → 同 apply。恢复逐字节原配置，并为恢复动作创建逆向备份；同步回滚 applied profile。外部改动后拒绝覆盖，应先另存和手动合并。
- runtime(tool) → {configured,providerId?,model?,provider?,env}，仅返回上次成功 apply 的方案。Claude/Gemini env 含真实密钥，**仅服务端内部调用，禁止 HTTP 返回**。其余 CLI 按原生文件读取，Pi/OpenCode 使用 dsh-plus provider。

高级 overrides 按文件角色组织，例如 {config:{model_reasoning_effort:"high"}}。禁止凭据字段、端点覆盖、环境和执行入口，防止将官方供应商密钥传向其他地址。max_tokens 等正常推理参数允许保存。原生配置、方案、备份均为 0600，方案只存 providerId 引用，不存供应商密钥。

JSONC、YAML、TOML、JSON5、dotenv 分别解析合并并保留未知字段。JSONC/YAML 尽量保留注释；TOML/JSON5 会重排格式和注释并给出 warning。模型数组按 id 合并，Hermes providers、Desktop entries 保留非本服务条目。MiniMax 仅登记 provider+models，默认模型仍由原生工具管理。Desktop 使用第三方 Claude-3p/configLibrary gateway profile，需要支持该功能的 Desktop 版本。

文件写入使用同目录临时文件、fsync、rename；多文件操作先保存完整备份，失败回滚已写文件。预览校验和与写前重读检查外部变更；跨服务进程使用目录锁，拒绝符号链接路径。异常终止遗留锁时，须确认无写操作后人工移除 dataDir/.tool-profiles.lock。备份包含原生凭据，只保留服务端，列表仅公开元数据。

验证命令：node --test plugins/commander/test/tool-config.test.mjs。覆盖十工具写入、未知字段、格式、0600、冲突、恢复、绑定、敏感字段拒绝，以及 draft/apply/runtime/restore 状态。本次未对十个真实 CLI 执行联网推理，也未声称实现 CC Switch 代理转换、故障转移、MCP/Skill 同步等全部功能。

## 2026-10-17：保护已有工具与账户

- 检测原生配置只返回文件路径、存在状态及不可读状态，不返回正文、密钥、登录令牌，也不根据文件存在推断订阅。默认保存、安装、更新、重装与卸载不写账户配置或历史。
- 本机原有可执行入口优先；DSH+ 独立副本不抢占系统工具，更新、重装、卸载仅操作有本插件 receipt 的目录。外部安装仅展示，不由插件升级或卸载。
- 即使直接调用配置服务，apply 也必须携带明确确认、当前草稿修订及完整预览校验和；restore 同样要求明确确认。已有供应商与非托管字段在显式同步中保留；当前默认目标可能改变，界面单独确认并提供逐字节备份恢复。
- quickSettings 使用 shared/tool-quick-settings.mjs 的工具级白名单和类型校验。Claude Code 支持 Agent Teams、Agent 窗口、思考/推理强度和 Hooks；Codex 支持多 Agent、并发、深度、思考/上下文/压缩；Gemini、Pi、OpenCode、OpenClaw、Hermes、Grok 提供已映射的原生快捷项。其它工具保留高级配置，不显示未经核实的开关。
- Claude/Codex 托管 API 会话在创建时捕获快捷配置，后续更改默认不影响已有会话；模型入口手动选择供应商仍继承当时的工具快捷设置。高级任意覆盖仍不允许用于隔离会话。
- 订阅识别来自官方 OAuth 认证元数据及原生 CLI 的只读登录状态探测，只允许对应工具；不把用户“登录”当成已验证付费有效。登录探测不读取或复制账户文件，不返回令牌或原始命令输出。Codex/Claude 的订阅会话保留原生账户目录，不复制 OAuth，不导出为 API 密钥；连接时分别通过 account/read、SDK accountInfo 验证工具本机账户。原生登录失效或类型不符则拒绝执行，不回落到 API。订阅模式读取/使用该工具自身历史与配置环境，不承诺 API 模式那样的独立历史目录。
- 参考版本仍为 reference/cc-switch@51ac86f。未实现的 CC Switch 代理转换、故障转移、历史迁移、MCP/Skill 同步不冒充为已内置功能。分屏需要用户环境支持 tmux/iTerm2；本次未启动图形应用验收。
