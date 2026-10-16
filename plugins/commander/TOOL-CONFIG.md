# 原生工具配置服务

实现参考 reference/cc-switch@51ac86f 的配置格式，不参与参考项目构建。支持 Claude Code、Claude Desktop、Codex、Gemini、Grok Build、OpenCode、OpenClaw、Hermes、Pi、MiniMax Code。Claude Code、Codex、Pi、OpenCode、Gemini、Hermes、Grok Build、MiniMax Code 同时具备 Commander 会话驱动。配置支持不等于会话驱动支持。

createToolProfiles({directory, providers, home?, env?, platform?}) 同步创建服务；providers 传入现有 createModelProviders(ctx)，复用官方供应商和凭据，不复制供应商 CRUD。下列方法均异步：

- list() → {profiles,backups,capabilities,bindings}；get(tool) → profile 或 null。
- save({tool,providerId,model,protocol?,overrides?,contextWindow?,expectedRevision?}) → 带 revision 的方案草稿。保存不影响运行时，必须 apply 才生效。
- setBindings({providerId,tools}) → {bindings}。tools 支持十工具及 harness；未设 binding 表示未限制，空数组表示未分配。供应商的 API 协议兼容性由用户选择，本服务不做协议代理转换。
- preview({tool,revision?}) → {tool,revision,files:[{role,path,exists,checksum,changed}],warnings}。不返回原生文件正文、diff 或密钥。
- apply({tool,revision?,checksums?:{path:checksum|null}}) → {tool,backupId,files:[{path,checksum}],warnings}。
- restore({backupId,checksums?}) → 同 apply。恢复逐字节原配置，并为恢复动作创建逆向备份；同步回滚 applied profile。外部改动后拒绝覆盖，应先另存和手动合并。
- runtime(tool) → {configured,providerId?,model?,provider?,env}，仅返回上次成功 apply 的方案。Claude/Gemini env 含真实密钥，**仅服务端内部调用，禁止 HTTP 返回**。其余 CLI 按原生文件读取，Pi/OpenCode 使用 dsh-plus provider。

高级 overrides 按文件角色组织，例如 {config:{model_reasoning_effort:"high"}}。禁止凭据字段、端点覆盖、环境和执行入口，防止将官方供应商密钥传向其他地址。max_tokens 等正常推理参数允许保存。原生配置、方案、备份均为 0600，方案只存 providerId 引用，不存供应商密钥。

JSONC、YAML、TOML、JSON5、dotenv 分别解析合并并保留未知字段。JSONC/YAML 尽量保留注释；TOML/JSON5 会重排格式和注释并给出 warning。模型数组按 id 合并，Hermes providers、Desktop entries 保留非本服务条目。MiniMax 仅登记 provider+models，默认模型仍由原生工具管理。Desktop 使用第三方 Claude-3p/configLibrary gateway profile，需要支持该功能的 Desktop 版本。

文件写入使用同目录临时文件、fsync、rename；多文件操作先保存完整备份，失败回滚已写文件。预览校验和与写前重读检查外部变更；跨服务进程使用目录锁，拒绝符号链接路径。异常终止遗留锁时，须确认无写操作后人工移除 dataDir/.tool-profiles.lock。备份包含原生凭据，只保留服务端，列表仅公开元数据。

验证命令：node --test plugins/commander/test/tool-config.test.mjs。覆盖十工具写入、未知字段、格式、0600、冲突、恢复、绑定、敏感字段拒绝，以及 draft/apply/runtime/restore 状态。本次未对十个真实 CLI 执行联网推理，也未声称实现 CC Switch 代理转换、故障转移、MCP/Skill 同步等全部功能。
