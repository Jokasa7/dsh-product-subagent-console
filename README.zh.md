# DSH 产品子代理控制台

[English](README.md) · 简体中文

[![CI](https://github.com/Jokasa7/dsh-product-subagent-console/actions/workflows/ci.yml/badge.svg)](https://github.com/Jokasa7/dsh-product-subagent-console/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Jokasa7/dsh-product-subagent-console)](https://github.com/Jokasa7/dsh-product-subagent-console/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

从可审核方案到有证据的恢复，全程都在同一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 对话中完成。

这是一个独立社区插件，并非 DeepSeek Harness 官方组件。

[安装](#安装) · [60 秒体验](#60-秒体验) · [完整功能演示](docs/product-tour.zh.md) · [反馈问题](https://github.com/Jokasa7/dsh-product-subagent-console/issues)

DSH 产品子代理控制台会在对话的**子代理**标签页中加入可拖动工作台，让你先设计多 Agent 任务，再观察真实子会话、核对实际执行，并准备安全的下一步。

| 模式 | 能做什么 |
| --- | --- |
| **实时** | 按真实父子关系查看原生子会话和兼容 Provider 运行。 |
| **方案** | 把目标转成可编辑的角色、任务、依赖、Provider、工具、检查项和预算，并在批准前预检。 |
| **偏差** | 将已批准任务映射到实际尝试，回放事件时间轴，定位第一个有证据的差异。 |
| **恢复** | 预览哪些任务需要重做、哪些结果可以复用，询问运行事实，导出脱敏运行包，并生成可复用工作流候选。 |

## 一次运行，四种视角

| 设计并批准精确任务图 | 跟随每条真实子代理分支 |
| --- | --- |
| [![方案中的角色、依赖、Provider 与预算](docs/assets/agent-plan-zh.jpg)](docs/assets/agent-plan-zh.jpg) | [![实时父子代理任务树](docs/assets/agent-runtime-zh.jpg)](docs/assets/agent-runtime-zh.jpg) |
| **方案**：编辑角色、依赖、执行方式和限制，对已保存修订运行预检。 | **实时**：在一张画布上查看实际任务、生命周期、耗时和子会话关系。 |
| 将方案与实际运行逐项对应 | 在操作前预演恢复影响 |
| [![已批准方案与真实 Agent 尝试的映射](docs/assets/agent-compare-zh.jpg)](docs/assets/agent-compare-zh.jpg) | [![恢复影响与可复用任务预演](docs/assets/agent-recovery-zh.jpg)](docs/assets/agent-recovery-zh.jpg) |
| **偏差**：回放权威运行事件，查看计划任务、实际尝试和对应证据摘要。 | **恢复**：先区分受影响任务与可复用任务，再生成 Retry 或 Fork 建议。 |

点击任意图片可查看完整尺寸。

### 适合这些场景

- 并行检查代码、文档或仓库，希望职责和依赖始终清楚可见。
- 先分阶段实现，再交给独立角色验证或汇总。
- 排查运行卡住、任务缺失、出现意外分支或证据不足。
- 将多次验证通过的工作流沉淀为可复用起点，同时避免自动执行。

## 60 秒体验

启用下方方案工具后，打开**子代理 → 方案**，输入这个只读示例：

> 请设计一个只读的三 Agent 方案：A 读取 `README.md` 的项目定位；B 读取 `package.json` 的 `name` 和 `version`；C 只使用 A、B 的结果汇总三条事实。不要修改文件。先让我审核方案，确认后再执行。

生成方案后检查角色和边界，运行预检，批准精确修订并确认执行；随后依次打开**实时**、**偏差**和**恢复**，即可从三种实用视角查看同一次运行。

上面的截图来自真实 DSH 浏览器会话。v0.9 构建已完成 4 次成功的只读工作流运行、观察到 15 个真实子会话，并通过 30 个测试文件 / 245 项测试以及打包与安装冒烟检查。更多可照着操作的场景和预期结果见[完整功能演示](docs/product-tour.zh.md)。

## 安装

从匹配的 [GitHub Release](https://github.com/Jokasa7/dsh-product-subagent-console/releases) 下载 `.tgz` 与 `SHA256SUMS.txt`，校验后安装到实际使用的 Profile：

```sh
sha256sum --check SHA256SUMS.txt

# DSH Desktop：在“Open DSH Terminal”中执行
dsh plugin add ./dsh-product-subagent-console-0.9.0.tgz

# 普通 Web Profile
dsh plugin --profile web add ./dsh-product-subagent-console-0.9.0.tgz
```

安装完成后重启 DSH Desktop 或 Web Profile。

方案可能包含用户填写的目标、职责、任务说明、完成标准和资源名称。不要在这些字段中填写凭据或私人内容，详情见[数据与隐私](docs/data-and-privacy.zh.md)。

## 启用方案设计与执行

将方案工具添加到复制后的 **Agent 预设**，保存后使用该预设新建对话：

```yaml
- id: agent-planner
  name: dsh-product-subagent-console/plan-tool
  config:
    toolName: design_subagent_plan
    executeToolName: execute_subagent_plan
```

预设修改只对新对话生效。即使没有启用方案工具，普通兼容委派仍可在**实时**模式中观察。

## 兼容性

- DeepSeek Harness Web 或 Desktop Profile `0.1.1-rc.2`
- Node.js `^22.19.0` 或 `>=24.0.0`
- 方案执行至少需要一个兼容的子代理 Provider
- 外部 coding Agent 需要对应的 Provider Bundle

插件与 DSH 包应保持在上面标明的受支持版本线上。

## 使用文档

- [入门指南](docs/getting-started.zh.md)
- [完整功能演示](docs/product-tour.zh.md)
- [Agent 方案设计器](docs/agent-planner.zh.md)
- [Agent Foundry](docs/agent-foundry.zh.md)
- [数据与隐私](docs/data-and-privacy.zh.md)
- [故障排查](docs/troubleshooting.zh.md)
- [更新记录（英文）](CHANGELOG.md)
- [安全说明（英文）](SECURITY.md)

## 卸载

```sh
dsh plugin remove dsh-product-subagent-console
# 或：dsh plugin --profile web remove dsh-product-subagent-console
```

卸载后重启 Profile。已经存在的本地 Foundry 数据不会自动删除，清理方法见[数据与隐私](docs/data-and-privacy.zh.md#删除本地-foundry-数据)。

## 支持

可在 [GitHub Issues](https://github.com/Jokasa7/dsh-product-subagent-console/issues) 提交可复现的问题和功能建议。安全问题请通过 [SECURITY.md](SECURITY.md) 中的私密渠道报告。

欢迎参与贡献；支持的开发流程和公开数据规则见 [贡献指南](.github/CONTRIBUTING.zh.md)。

## 许可证

[MIT](LICENSE)。第三方许可信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
