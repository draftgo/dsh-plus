# Dowork 插件

自有插件统一放在本目录，不修改 `deepseek-harness/` 官方源码。

| 目录 | 名称 | 职责 | 状态 |
| --- | --- | --- | --- |
| [commander](commander/README.md) | DSH-Plus | 接管、驱动和编排 Claude Code / Codex / Pi / OpenCode 会话 | 已实现 Web 共用项目、工具/模型选择、直接聊天、侧栏工具图标与跨引擎委派；验收边界见插件文档 |
| [link](link/README.md) | Link · 直连 | 手机、桌面及其他客户端直接连接执行主机 | 已实现桌面入口、TLS 配对、官方会话与移动界面；原生构建验收见 Link 文档 |
| [commander/voice](commander/voice/README.md) | DSH-Plus 语音模块 | 可配置听写、流式朗读及实时通话 | 内置于 DSH-Plus，独立开关 |

## 组合方式

- Commander 提供统一外部 Agent 会话服务；桌面、远程客户端和语音通过同一服务操作，避免分别创建执行进程。
- Link 负责设备身份、连接与访问权限；复用 Harness Host/Client Remote 机制，业务状态留在执行主机。
- Voice 通过会话适配器接入 Harness Agent 或 Commander 外部会话；不重新实现 Agent 推理循环。
- DSH-Plus 的文字与语音能力可独立开关；Link 默认关闭并随插件打包，语音不强制使用外部 Agent。
- 插件互调走显式服务契约和依赖注入，不读取其他插件的私有存储。

一个产品插件可以由多个 Cordis 包、Host/Client 贡献及一个 Bundle 组成，不要求塞进一个源文件或进程。独立媒体服务如有必要，由插件持有生命周期。

## 开发约定

Commander 已有独立 npm 包、Bundle 清单和运行入口，需要显式安装到官方 profile 才会加载；Voice 已并入 DSH-Plus，不再独立安装；Link 作为独立源码模块随 Commander 构建打包，不单独安装。

进入实现时，先验证官方扩展接口及外部包加载路径，再添加各插件自己的包、依赖和构建配置；不使用上游工作区内部的 `workspace:*` 作为外部依赖。不为接入插件修改官方 pnpm workspace 或锁文件。

公共契约应明确版本、能力探测、取消、错误、事件顺序与资源释放。外部 Agent 适配器报告真实能力，不支持的操作返回不可用。参考源码审计基线见 [Paseo 设计](../Design/paseo-agent-drivers.md)；复制代码时保留对应许可证和版权声明。
