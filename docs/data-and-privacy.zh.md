# 数据与隐私

[English](data-and-privacy.md)

## 会保存什么

Foundry 存储默认启用。Host 会在 DSH home 下维护一个有界的 append-only journal：

```text
plugins/dsh-product-subagent-console/foundry-v1/events.jsonl
```

Journal 包含完整的 Schema 校验方案修订、执行快照、生命周期与控制事件，以及验证器回执；一致性发现会根据这些事实重新计算。完整方案修订包括用户填写的目标、成功标准、角色职责与边界、任务说明、预期输出、完成标准、资源声明、Provider/工具选择、验证合同和预算。

插件不会从 DSH 运行流采集原始对话全文、模型完整输出、原生 stdout/stderr、环境变量或隐藏推理。但是，用户主动填进方案字段的凭据、私人文本、仓库路径或其他敏感值本来就是方案内容，会被原样保存。不要把秘密或不必要的私人内容写入方案。

连续 hash chain 只能检测意外损坏；它不是加密，也不能防御有能力同时重写记录与摘要的本机用户。能够读取 DSH home 的用户也可能读取方案内容。

## 容量与 degraded 状态

内存集合和 Journal 都有明确的记录数与字节上限。Workflow 启动前，执行必须预留足够的 Event 与 Receipt 容量。如果磁盘写入失败或 Journal 达到磁盘上限，存储会进入 `degraded`，当前 Host 可以继续保存有界内存事实；UI 会显示实际 durability 与 storage status。

重启时，Host 会校验记录序号和 hash chain。损坏的 Journal 会被隔离并新建文件。恢复出的未结束执行会标记为 `unknown`，不会被虚构为成功；未闭合的控制链会标记为重启中断或执行中断。

## 关闭后续磁盘持久化

设置插件选项：

```yaml
foundryStorage: false
```

这只会阻止该配置后续写入磁盘，不会删除之前创建的 Journal。

需要使用其他本地位置时，可以把 `foundryStorageDirectory` 设置为明确的绝对目录。不要在路径中写入凭据，也不要让多个活动 Host 指向同一目录；插件会使用协作式单写锁。

## 导出文件

- Run Capsule 使用白名单公开投影、假名化标识、有界证据闭包和 Manifest 摘要。
- 默认排除目标与任务 brief；显式包含时仍会执行清理。
- Recipe ZIP 包含 typed 方案模板（包括其中可复用的方案文本）、`SKILL.md` 与校验摘要，但不包含原始对话全文或模型输出。导出会拒绝可识别的凭据和绝对路径，分享前仍应检查压缩包。
- OTLP JSON 是默认关闭的离线预览，不会创建网络 exporter；运行、尝试和任务标识只以摘要形式导出。

导出文件由用户主动生成，仍可能包含用户选择加入的任务标题或可选文本。分享前请自行检查。

Capsule 经传输或解包后，可使用包公开的校验器验证 Manifest：

```js
import { verifyRunCapsuleManifest } from 'dsh-product-subagent-console/capsule'

const valid = verifyRunCapsuleManifest(manifest)
```

## 删除本地 Foundry 数据

1. 停止 DSH Desktop 或对应 Web Profile，确保没有 Host 持有写锁。
2. 确认该 Profile 实际使用的 DSH home。
3. 如果历史仍可能有用，先备份插件目录。
4. 只删除该 DSH home 下的 `plugins/dsh-product-subagent-console/foundry-v1`。
5. 重新启动 Profile，确认 Foundry 显示新的空 Journal。

卸载插件不会自动删除这些数据。
