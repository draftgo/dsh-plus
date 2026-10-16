# Link 验证

单元与传输测试：`node --test plugins/link/test/*.test.mjs`。

`node plugins/link/test/live-harness.mjs` 是主动执行的真实 Harness 联调，不包含在默认单元测试中。需要已安装官方工作区依赖及 tsx、已构建的 Commander／Link 包，以及包含 `@dowork/commander` 的 profile 依赖目录。

- `LINK_TEST_NODE`：Node.js 24 可执行文件；默认根目录 `node_modules/.toolchain/node_modules/node/bin/node`。
- `LINK_HARNESS_NODE_MODULES`：已准备的 profile `node_modules`；默认 `.local/web/home/profiles/web/node_modules`。

脚本先检查依赖，再创建临时 profile。执行时使用独立 `DSH_HOME` 和 `DSH_AGENTS_HOME`，不继承模型凭据，不启动图形应用，不接触用户现有服务。所有模型响应来自本机临时 OpenAI SSE mock；审批测试拒绝原生 Agent 启动。结束时清理临时进程、服务与目录。
