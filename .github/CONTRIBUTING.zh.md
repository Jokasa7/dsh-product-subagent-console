# 贡献指南

[English](CONTRIBUTING.md) | 简体中文

感谢你改进 Product Subagent Console。贡献应聚焦用户可感知的结果，并且只展示受支持的 DeepSeek Harness 契约能够提供的事实。

## 开始之前

- 使用 Node.js `^22.19.0` 或 `>=24.0.0`、pnpm `11.7.0` 和 DSH `0.1.1-rc.2`。
- 提交问题或功能建议前，请先搜索已有 Issue。
- 较大的改动请先提交 Issue，在实现前对齐兼容性和产品边界。
- 不得提交凭据、认证配置、私人提示词、模型输出、本机路径、环境变量、原生 stderr 或真实用户任务数据。

## 产品边界

- 运行状态必须来自权威的 DSH Session、生命周期事件或插件自身的执行记录。
- 不得虚构进度、成功、队列状态、重试、child Session 或 Provider 能力。
- 画布交互可以改变展示方式，但不能静默改变任务父级或修改正在运行的工作。
- 仓库根目录必须保持为可直接安装的 DSH Bundle，不依赖未发布 API 或修改过的 Harness。

## 本地流程

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
pnpm run pack:check
pnpm run publint
pnpm run smoke:web
```

测试只能使用合成数据或经过刻意控制的测试数据。UI 改动应附脱敏截图，或简要描述已经验证的浏览器流程。

## Pull Request

- 每个 PR 保持单一目标，并说明用户可见的结果。
- 对受影响的生命周期、持久化、恢复和隐私行为增加或更新测试。
- 共同内容发生变化时，同步更新 `README.md` 与 `README.zh.md`。
- 用户可见行为需要更新 `CHANGELOG.md`。
- 提交前运行 `pnpm run verify:public`。它会阻止内部指令、临时产物、私人路径、凭据、日志和未审查文件类型进入公开树。

安全漏洞请通过 [GitHub Security Advisories](https://github.com/Jokasa7/dsh-product-subagent-console/security/advisories/new) 私密报告，不要创建公开 Issue。
