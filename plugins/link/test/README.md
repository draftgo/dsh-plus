# Link 验证

单元与传输测试：`node --test plugins/link/test/*.test.mjs`。

`mobile-pairing-ui.test.mjs` 覆盖扫码自动请求、重复原生事件去重、桌面确认、拒绝后重新扫码、网络失败手动重试、粘贴地址手动提交，以及随机设备名称持久化。`workbench.test.mjs` 通过真实 TLS/HTTP/2 在一个连接保持八条订阅，同时验证会话 API、更新 API、上行消息、Host/Origin 校验及 HTTP/1.1 兼容；不等同于 Android 真机或公网反向代理验收。

`node plugins/link/test/live-harness.mjs` 是主动执行的真实 Harness 联调，不包含在默认单元测试中。需要已安装官方工作区依赖及 tsx、已构建的 Commander／Link 包，以及包含 `dsh-plus` 的 profile 依赖目录。

- `LINK_TEST_NODE`：Node.js 24 可执行文件；默认根目录 `node_modules/.toolchain/node_modules/node/bin/node`。
- `LINK_HARNESS_NODE_MODULES`：已准备的 profile `node_modules`；默认 `.local/web/home/profiles/web/node_modules`。

脚本先检查依赖，再创建临时 profile。执行时使用独立 `DSH_HOME` 和 `DSH_AGENTS_HOME`，不继承模型凭据，不启动图形应用，不接触用户现有服务。所有模型响应来自本机临时 OpenAI SSE mock；审批测试拒绝原生 Agent 启动。结束时清理临时进程、服务与目录。
