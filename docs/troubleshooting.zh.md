# 故障排查

[English](troubleshooting.md) · 简体中文

## 没有“子代理”页签

- 确认插件安装在 Web Profile 中。
- 运行 `dsh --profile web --dump-config`，查找 `product-subagent-console`。
- 将 DSH、插件和 Provider Bundle 对齐到受支持的版本线。
- 重启 Web Profile，然后刷新页面。

## “运行”模式为空

- 确认当前 Agent 预设启用了兼容的委派工具。
- 修改预设后创建一个新对话。
- 在该对话中发起委派任务。

## Agent 方案设计器不可用

- 将 `dsh-product-subagent-console/plan-tool` 添加到当前 Agent 预设。
- `design_subagent_plan` 与 `execute_subagent_plan` 必须使用不同且不重复的工具名。
- 保存预设，然后创建新对话。

完整配置见 [Agent 方案设计器](agent-planner.zh.md#启用方案设计器)。

## “生成方案”没有创建草案

- 在“对话”和“轨迹”中检查可见的方案设计请求及其工具调用。
- 确认当前模型能够调用工具，并且本对话已启用方案工具。
- 使用更具体的目标重试，写明期望结果与约束。

## 预检阻止批准

在“方案”模式中选择每项问题，并修正对应角色或任务。常见原因包括：

- 循环依赖或不存在的任务依赖；
- 传输 Provider、模型路由、Agent 预设或工具不可用；
- 一个可执行 Workflow 方案使用了多个传输 Provider；
- 选择 Agent Teams 作为执行后端；
- 并发、预算或资源冲突。

批准前需要阅读并接受警告。编辑草案后，需要重新保存并运行预检。

## 已批准方案无法执行

- 确认“对照”中选择的是已批准的精确修订。
- 如果批准后修改过 DSH Profile、Provider、工具或预设，请重新运行预检。
- 确认所选 Provider 已安装、已认证且当前可用。
- 在“对话”“轨迹”和 Provider 日志中查看具体错误。

## 外部 Agent 无法启动

- 确认对应 Provider Bundle 安装在同一个 Profile。
- 完成 Provider 的正常认证和配置。
- 保持 Provider、DSH 与本插件版本兼容。
- 在“轨迹”和 Provider 日志中查看具体错误。

## 运行长时间保持活动状态

打开“轨迹”，检查 Provider 进程或日志。若 Provider 已无响应，请通过它原有的控制方式停止任务；只有生命周期仍未恢复时才重启 Web Profile。

## 取消长时间处于等待状态

取消操作会向当前 Workflow 和 Provider 发出请求。只有 DSH 报告全部任务已结束后，执行状态才会停止。状态没有变化时，请检查“轨迹”和 Provider 日志。

## 页面断开连接

恢复或重启 Web Profile，然后刷新页面。若插件没有重新连接，请再次运行 `dsh --profile web --dump-config` 检查配置。

## 出现版本或 peer dependency 错误

把插件、Provider Bundle 与全部 DSH 包对齐到同一条受支持的精确版本线。不要把当前版本与更晚的移动预发布标签混装。

## 方案、执行记录或卡片位置消失

方案与执行记录只在当前 Host 运行期间临时保留。手动调整的卡片位置只属于当前页面，页面重启后不会恢复。

若问题仍可稳定复现，请提交 [GitHub Issue](https://github.com/Jokasa7/dsh-product-subagent-console/issues)，注明 DSH 版本、插件版本、Provider 名称、浏览器和可见错误。发布前请移除凭据与私人任务内容。
