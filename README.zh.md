# DSH 产品子代理控制台

[English](README.md) · 简体中文

[![CI](https://github.com/Jokasa7/dsh-product-subagent-console/actions/workflows/ci.yml/badge.svg)](https://github.com/Jokasa7/dsh-product-subagent-console/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Jokasa7/dsh-product-subagent-console?include_prereleases)](https://github.com/Jokasa7/dsh-product-subagent-console/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

无需离开 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 对话，即可设计、运行和检查多 Agent 任务。

> 需要 DSH `0.1.1-rc.2`。这是独立社区插件。

![DSH 产品子代理控制台](docs/assets/subagent-canvas-live.jpg)

## 功能亮点

- **运行** — 在可拖动的分支画布上查看原生子会话和兼容 Provider 运行。
- **方案** — 把目标转换为可编辑的角色、任务、依赖、并行批次、Provider、工具与预算。
- **对照** — 将已批准的计划任务与真实 Workflow 尝试、状态、耗时和子会话逐项对应。
- 点击任意卡片查看详情，调整或自动适配画布，并可直接打开原生子会话。
- 完整支持英文和简体中文界面。

## 安装

从对应的 [GitHub Release](https://github.com/Jokasa7/dsh-product-subagent-console/releases) 下载 `.tgz` 和 `SHA256SUMS.txt`，校验后安装到 Web Profile：

```sh
sha256sum --check SHA256SUMS.txt
dsh plugin --profile web add ./dsh-product-subagent-console-0.4.0-alpha.1.tgz
dsh --profile web --dump-config
```

安装后请重启 Web Profile。

## 启用 Agent 方案设计器

将方案工具添加到复制后的 **Agent 预设**，保存后使用该预设新建对话：

```yaml
- id: agent-planner
  name: dsh-product-subagent-console/plan-tool
  config:
    toolName: design_subagent_plan
    executeToolName: execute_subagent_plan
```

预设修改只对新建对话生效。即使没有启用方案工具，普通委派任务仍会显示在**运行**模式中。

## 使用

1. 打开**子代理 → 方案**，输入目标并生成或手动创建草案。
2. 在画布和设置中编辑方案，保存修订，然后运行预检。
3. 处理阻塞问题、确认警告，并批准该修订。
4. 打开**对照**，请求执行，并查看每项计划任务对应的真实运行。

完整流程与字段说明见 [Agent 方案设计器](docs/agent-planner.zh.md)。

## 兼容性

- DeepSeek Harness Web Profile `0.1.1-rc.2`
- Node.js `^22.19.0` 或 `>=24.0.0`
- 方案或普通委派任务使用外部 coding Agent 时，需要对应的兼容 Provider Bundle

插件与全部 DSH 包应保持在同一条受支持的版本线上。

## 使用文档

- [入门指南](docs/getting-started.zh.md)
- [Agent 方案设计器](docs/agent-planner.zh.md)
- [故障排查](docs/troubleshooting.zh.md)
- [更新记录](CHANGELOG.md)
- [安全说明](SECURITY.md)

## 卸载

```sh
dsh plugin --profile web remove dsh-product-subagent-console
```

卸载后请重启 Web Profile。

## 支持

可在 [GitHub Issues](https://github.com/Jokasa7/dsh-product-subagent-console/issues) 提交可复现的问题和功能建议。安全问题请使用 [SECURITY.md](SECURITY.md) 中说明的私密渠道。

## 许可证

[MIT](LICENSE)。第三方许可信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
