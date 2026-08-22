# 入门指南

[English](getting-started.md) · [简体中文](getting-started.zh.md)

本指南用于把 DSH 产品子代理控制台安装到 DeepSeek Harness Web Profile，并在新对话中启用子代理活动。

## 准备工作

你需要：

- DeepSeek Harness `0.1.1-rc.2`
- Node.js `^22.19.0` 或 `>=24.0.0`
- 一个可正常运行的 DSH Web Profile

控制台不依赖外部 Provider 也能显示 DSH 原生子会话。只有需要委派给某个外部产品时才安装对应 Provider。

## 安装控制台

从对应的 [GitHub Release](https://github.com/Jokasa7/dsh-product-subagent-console/releases) 下载 `.tgz` 安装包和 `SHA256SUMS.txt`。

安装前校验文件：

```sh
sha256sum --check SHA256SUMS.txt
```

把安装包加入 Web Profile：

```sh
dsh plugin --profile web add ./dsh-product-subagent-console-0.1.0-alpha.2.tgz
dsh --profile web --dump-config
```

配置输出中应包含 `product-subagent-console`。安装后请重启 Web Profile。

在 Windows PowerShell 中，可将下面命令的结果与 `SHA256SUMS.txt` 对照：

```powershell
Get-FileHash .\dsh-product-subagent-console-0.1.0-alpha.2.tgz -Algorithm SHA256
```

## 添加外部 Provider

只安装实际使用的 Provider，并保持与 DSH 位于同一版本线：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-subagent-codex@0.1.1-rc.2
dsh plugin --profile web add @deepseek-ai/dsh-subagent-claude-code@0.1.1-rc.2
```

按 Provider 原有方式完成认证和配置，然后重启 Web Profile。安装本控制台不会同时安装外部 coding Agent，也不会替你完成登录。

## 在预设中启用委派

1. 打开**设置 → Agent 预设**。
2. 复制一个预设，并编辑副本。
3. 为目标 Provider 启用官方 `@deepseek-ai/dsh-tool-subagent` 条目。
4. 保存预设。
5. 使用更新后的预设创建新对话。

已有对话会继续使用创建时的 Preset 版本。

## 使用画布

发起一次委派任务，然后打开“对话”和“轨迹”旁的**子代理**页签。

- 拖动画布空白处进行平移，使用鼠标滚轮缩放。
- 拖动卡片可调整当前布局。
- 使用工具栏适应视图或恢复自动排列。
- 点击卡片打开详情。
- 原生子会话可通过详情操作直接打开。

## 可选插件工具

控制台还提供一个可选的委派工具。只有希望通过本插件发起 Provider 任务时，才把它加入复制后的 Agent Preset：

```yaml
- id: console-codex
  name: dsh-product-subagent-console/tool
  config:
    provider: codex
    toolName: console_codex
    enableRunInBackground: false
```

`provider` 必须与已安装的 Provider 名称一致。Preset 内的每个 `toolName` 必须唯一；保存后请新建对话。

## 更新

下载并校验新版 Release 安装包，停止 Web Profile，使用 `dsh plugin --profile web add` 安装新版，再重新启动 Profile。兼容版本发生变化时，应同时更新控制台和全部 DSH 包。

## 卸载

```sh
dsh plugin --profile web remove dsh-product-subagent-console
```

卸载后请重启 Web Profile。

常见问题见[故障排查](troubleshooting.zh.md)。
