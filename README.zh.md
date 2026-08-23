# DSH 产品子代理控制台

[English](README.md) · 简体中文

[![CI](https://github.com/Jokasa7/dsh-product-subagent-console/actions/workflows/ci.yml/badge.svg)](https://github.com/Jokasa7/dsh-product-subagent-console/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Jokasa7/dsh-product-subagent-console?include_prereleases)](https://github.com/Jokasa7/dsh-product-subagent-console/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

无需离开 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 对话，即可查看、设计和核验多 Agent 任务。

插件会在对话中添加一个**子代理**工作台：通过**运行**观察委派，通过**方案**准备可执行计划，再通过**对照**核验计划与实际运行是否一致。

> 需要 DSH `0.1.1-rc.2`。这是独立社区插件。
>
> Alpha 预览：DSH Web 进程重启后，方案与执行记录会被清除。

## 三种模式，一套完整流程

| 模式 | 适合做什么 | 可以查看什么 |
| --- | --- | --- |
| **运行** | 观察当前与已完成的委派任务 | 父子分支、任务、Provider、状态、耗时和原生子会话入口 |
| **方案** | 在 Agent 启动前设计工作 | 角色、任务、依赖、Provider、执行限制、预检和已批准修订 |
| **对照** | 核验计划与实际执行 | 计划任务、实际尝试、状态、耗时、依赖和子会话 |

## 功能演示

下面使用同一份产品发布简报，连续展示从任务委派到执行核验的完整过程。

### 运行 — 查看每一条委派分支

![运行模式展示子代理分支和选中任务详情](docs/assets/agent-runtime-zh.jpg)

运行模式会把 DSH 原生子会话和兼容 Provider 运行放在同一张可拖动画布中。可以平移、缩放和整理卡片，也可以选择节点查看任务、状态、耗时与 Provider 信息。对于原生节点，还可以直接打开对应的子会话。

### 方案 — 执行前先完成设计

![可编辑的 Agent 角色、任务、依赖与任务设置](docs/assets/agent-plan-zh.jpg)

输入目标即可生成草案，也可以手动新建。子 Agent 启动前，可以继续调整角色、职责、任务、依赖、Provider、资源与执行限制。

保存指定修订后，预检会根据当前 DSH Profile 的可用能力检查依赖和执行条件。处理阻塞问题、确认警告后，再批准需要执行的修订。

### 对照 — 将计划与实际运行逐项对应

![已批准方案与已记录 Agent 尝试的逐项对照](docs/assets/agent-compare-zh.jpg)

对照模式会把已批准方案中的每项任务，与本次执行记录的 attempt 和子会话连接起来。选择任务或实际尝试，可以查看角色、状态、耗时、依赖和预期输出。执行仍处于活动状态时，也可以请求取消。

## 从目标到可核验执行

1. 打开**子代理 → 方案**，输入目标并生成或手动创建草案。
2. 编辑画布和设置，保存修订，然后运行预检。
3. 处理阻塞问题、确认警告，并批准指定修订。
4. 打开**对照**并请求执行；在**运行**中观察实时分支，再回到**对照**查看最终的计划与实际结果。

完整流程与字段说明见 [Agent 方案设计器](docs/agent-planner.zh.md)。

## 安装

从对应的 [GitHub Release](https://github.com/Jokasa7/dsh-product-subagent-console/releases) 下载 `.tgz` 和 `SHA256SUMS.txt`，校验后安装到 Web Profile：

```sh
sha256sum --check SHA256SUMS.txt
dsh plugin --profile web add ./dsh-product-subagent-console-0.4.0-alpha.2.tgz
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

## 兼容性

- DeepSeek Harness Web Profile `0.1.1-rc.2`
- Node.js `^22.19.0` 或 `>=24.0.0`
- 使用“方案”和“对照”时，至少需要一个已配置的兼容子代理 Provider
- 方案或普通委派任务使用外部 coding Agent 时，需要该 Agent 对应的 Provider Bundle

插件与全部 DSH 包应保持在同一条受支持的版本线上。

## 使用文档

- [入门指南](docs/getting-started.zh.md)
- [Agent 方案设计器](docs/agent-planner.zh.md)
- [故障排查](docs/troubleshooting.zh.md)
- [更新记录（英文）](CHANGELOG.md)
- [安全说明（英文）](SECURITY.md)

## 卸载

```sh
dsh plugin --profile web remove dsh-product-subagent-console
```

卸载后请重启 Web Profile。

## 支持

可在 [GitHub Issues](https://github.com/Jokasa7/dsh-product-subagent-console/issues) 提交可复现的问题和功能建议。安全问题请使用 [SECURITY.md](SECURITY.md) 中说明的私密渠道。

## 许可证

[MIT](LICENSE)。第三方许可信息见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
