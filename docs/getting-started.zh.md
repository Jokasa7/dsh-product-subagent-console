# 入门指南

[English](getting-started.md)

## 使用条件

- DeepSeek Harness Web 或 Desktop Profile `0.1.1-rc.2`
- Node.js `^22.19.0` 或 `>=24.0.0`
- 已配置的兼容子代理 Provider
- 使用 Codex、Claude Code 或其他外部 coding Agent 时，需要匹配的 Provider Bundle

## 安装 Release 包

从同一个 GitHub Release 下载 `dsh-product-subagent-console-0.9.0.tgz` 与 `SHA256SUMS.txt`。

```sh
sha256sum --check SHA256SUMS.txt

# DSH Desktop：使用 Open DSH Terminal
dsh plugin add ./dsh-product-subagent-console-0.9.0.tgz

# Web Profile
dsh plugin --profile web add ./dsh-product-subagent-console-0.9.0.tgz
```

Windows PowerShell 也可以这样校验压缩包：

```powershell
Get-FileHash .\dsh-product-subagent-console-0.9.0.tgz -Algorithm SHA256
```

`dsh` 通常只在 **Open DSH Terminal** 中直接可用。若从源码仓库在普通 PowerShell 测试，请调用仓库内 CLI，并显式指定 Profile：

```powershell
pnpm exec dsh plugin --profile desktop add --save-exact --ignore-scripts `
  ".\release\dsh-product-subagent-console-0.9.0.tgz"
```

安装后重启对应 Profile。插件应出现在启动插件列表中，并在每个对话中添加**子代理**标签页。

## 启用方案工具

复制一个 Agent 预设，添加下面的 Bundle 配置，保存后使用该预设新建对话：

```yaml
- id: agent-planner
  name: dsh-product-subagent-console/plan-tool
  config:
    toolName: design_subagent_plan
    executeToolName: execute_subagent_plan
```

已经存在的对话会继续使用创建时的预设修订。

## 第一次安全测试

在一次性测试工作区中发送：

> 创建一个只读的三任务方案。任务 A 只读取 README.md 第一段；任务 B 只读取 package.json 的 `name` 和 `version`；A 与 B 并行。任务 C 只根据两者结果输出三行摘要。只创建草稿，不要执行。

依次确认：

1. **方案**中有两个并行任务，并共同连接到一个汇总任务。
2. 预检会显示当前真实 Provider、工具与能力支持情况。
3. 保存会创建带编号的草稿修订；批准只针对这个精确修订。
4. **请求执行**先进入检查步骤，再向当前对话发送一次可见执行请求。
5. **实时**只显示 DSH 或兼容 Provider 生命周期真正发布的子会话关系。
6. 运行结束后，**偏差**会显示精确的方案—attempt 绑定与 Evidence Passport。
7. 拖动时间轴后会暂停历史查看；点击**返回实时**恢复最新游标。
8. **恢复**会显示影响预演；已结束运行不能取消。

批准前，先为最终汇总任务添加一个必需的 lifecycle verifier。每次执行完全结束后，再次运行同一个已批准修订，直到获得三次成功结束、一致性已确认且具备权威通过回执的运行。选择这三次运行并点击**检查历史运行**，应显示真实权限状态；输入新目标后，只会创建新草稿并执行当前预检。重新生成一份略有不同的方案不会被当成同一个 Recipe 合同。

## 继续阅读

- 按[完整功能演示](product-tour.zh.md)逐步体验。
- 在 [Agent 方案设计器](agent-planner.zh.md)了解字段与安全门禁。
- 在 [Agent Foundry](agent-foundry.zh.md)了解证据、恢复、Capsule 与 Recipe。
- 在[数据与隐私](data-and-privacy.zh.md)了解本地持久化与导出。
- 标签页、Provider、预检或事实流不可用时，查看[故障排查](troubleshooting.zh.md)。
