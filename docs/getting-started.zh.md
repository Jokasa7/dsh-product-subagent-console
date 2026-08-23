# 入门指南

[English](getting-started.md) · 简体中文

本指南用于安装 DSH 产品子代理控制台，并在 DeepSeek Harness 对话中启用“运行”“方案”和“对照”三种模式。

## 使用要求

- DeepSeek Harness `0.1.1-rc.2`
- Node.js `^22.19.0` 或 `>=24.0.0`
- 一个可正常运行的 DSH Web Profile

如果只查看 DSH 原生子会话，外部 Provider 可以不安装。创建和执行 Agent 方案时，当前至少需要一个已安装并配置完成的兼容子代理 Provider。

## 安装

从对应的 [GitHub Release](https://github.com/Jokasa7/dsh-product-subagent-console/releases) 下载 `.tgz` 安装包和 `SHA256SUMS.txt`。

校验并安装：

```sh
sha256sum --check SHA256SUMS.txt
dsh plugin --profile web add ./dsh-product-subagent-console-0.4.0-alpha.2.tgz
dsh --profile web --dump-config
```

配置输出中应包含 `product-subagent-console`。安装后请重启 Web Profile。

在 Windows PowerShell 中，可将下面命令的结果与 `SHA256SUMS.txt` 对照：

```powershell
Get-FileHash .\dsh-product-subagent-console-0.4.0-alpha.2.tgz -Algorithm SHA256
```

## 添加外部 Provider

全部 Provider 应与 DSH 保持在同一条受支持的版本线上。例如：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-subagent-codex@0.1.1-rc.2
dsh plugin --profile web add @deepseek-ai/dsh-subagent-claude-code@0.1.1-rc.2
```

按该 Provider 的正常流程完成认证和配置，然后重启 Web Profile。安装本控制台不会同时安装外部 coding Agent，也不会替你完成登录。

## 配置 Agent 预设

打开**设置 → Agent 预设**，复制一个预设，并按需添加工具。

### 观察普通委派任务

为目标 Provider 启用官方委派工具。通过兼容 DSH 委派启动的任务会显示在**子代理 → 运行**中。

### 设计并执行方案

添加本插件的方案工具：

```yaml
- id: agent-planner
  name: dsh-product-subagent-console/plan-tool
  config:
    toolName: design_subagent_plan
    executeToolName: execute_subagent_plan
```

保存预设，然后使用它新建对话。已有对话会继续使用创建时的预设版本。

## 使用工作台

**子代理**页签包含三种模式：

- **运行**显示当前和已完成的委派任务。可以平移、缩放和整理卡片，选择卡片查看详情，或打开原生子会话。
- **方案**用于生成或手动创建 Agent 方案。编辑并保存草案，运行预检，确认警告，然后批准需要执行的指定修订版本。
- **对照**会请求当前对话执行已批准方案，并把每项计划任务与实际执行记录并列显示。可以查看状态与耗时，也可在执行仍处于活动状态时请求取消。

方案与执行记录只在当前 DSH Web 进程中临时保留。完整流程见 [Agent 方案设计器](agent-planner.zh.md)。

## 更新

下载并校验新版 Release 安装包，停止 Web Profile，使用 `dsh plugin --profile web add` 安装新版，再重新启动 Profile。兼容版本发生变化时，应同时更新控制台和全部 DSH 包。

## 卸载

```sh
dsh plugin --profile web remove dsh-product-subagent-console
```

卸载后请重启 Web Profile。

常见安装与执行问题见[故障排查](troubleshooting.zh.md)。
