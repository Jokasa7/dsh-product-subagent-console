# 故障排查

[English](troubleshooting.md) · [简体中文](troubleshooting.zh.md)

## 没有“子代理”页签

- 确认插件安装在 Web Profile，而不是只装在其他 Profile。
- 运行 `dsh --profile web --dump-config`，查找 `product-subagent-console`。
- 确认 DSH 与插件位于受支持的版本线。
- 重启 Web Profile，然后刷新页面。

## 页签存在，但画布为空

- 确认当前 Agent Preset 已启用委派工具。
- 修改 Preset 后创建一个新对话。
- 在新对话中发起委派任务。

## 外部 Agent 无法启动

- 确认对应 Provider Bundle 安装在同一个 Profile。
- 完成 Provider 的认证和配置。
- 保持 Provider、DSH 与本插件版本兼容。
- 在“轨迹”和 Provider 日志中查看具体错误。

## 可选插件工具没有出现

- 确认 `provider` 与已安装的 Provider 名称一致。
- 确认 Agent Preset 中的 `toolName` 唯一。
- 保存 Preset，然后创建新对话。

## 任务长时间显示“运行中”

打开“轨迹”，并检查 Provider 进程或 Provider 日志。只要 DSH 仍把该运行报告为活动状态，卡片就会保持运行中。若 Provider 已无响应，请通过它原有的控制方式停止任务；生命周期仍未恢复时，再重启 Web Profile。

## 显示 Host 不可用或页面断开连接

恢复或重启 Web Profile，然后刷新页面。若插件没有重新连接，请再次运行 `dsh --profile web --dump-config` 检查配置。

## 出现“Background jobs unavailable”

在可选工具配置中设置 `enableRunInBackground: false`；只有安装兼容的 DSH Jobs runtime 后才启用后台执行。

## 出现“Queue full”

等待当前任务结束后再发起新任务。如果经常遇到此情况，可检查 DSH 插件配置中的控制台任务上限。

## 出现版本或 peer dependency 错误

把插件、Provider Bundle 与全部 DSH 包对齐到同一条受支持的精确版本线。不要把当前版本与更晚的移动预发布标签混装。

## 重启后历史或卡片位置消失

当前版本不会跨 Host 重启持久化已完成任务，也不会跨页面重启保存手动调整的卡片位置。

若问题仍可稳定复现，请提交 [GitHub Issue](https://github.com/Jokasa7/dsh-product-subagent-console/issues)，注明 DSH 版本、插件版本、Provider 名称、浏览器和可见错误。发布前请移除凭据与私人任务内容。
