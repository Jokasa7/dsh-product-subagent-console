# Troubleshooting

English · [简体中文](troubleshooting.zh.md)

## The Subagents tab is missing

- Confirm that the plugin is installed in the Web profile.
- Run `dsh --profile web --dump-config` and look for `product-subagent-console`.
- Align DSH, the plugin, and Provider Bundles to the supported version family.
- Restart the Web profile and refresh the page.

## Live is empty

- Confirm that the selected Agent Preset enables a compatible delegation tool.
- Create a new conversation after changing a preset.
- Start a delegated task in that conversation.

## Agent Planner is unavailable

- Add `dsh-product-subagent-console/plan-tool` to the selected Agent Preset.
- Keep `design_subagent_plan` and `execute_subagent_plan` as different, unique tool names.
- Save the preset and create a new conversation.

See [Agent Planner](agent-planner.md#enable-the-planner) for the complete entry.

## Generate plan does not create a draft

- Check Chat and Trajectory for the visible plan-design request and its tool call.
- Confirm that the current model can call tools and that the planner tool is enabled in this conversation.
- Retry with a concrete objective that names the desired result and constraints.

## Preflight blocks approval

Select each reported issue in the Plan view and correct the referenced role or task. Common causes include:

- a cycle or missing task dependency;
- an unavailable transport Provider, model route, Agent Preset, or tool;
- multiple transport Providers in one executable Workflow plan;
- Agent Teams selected as the execution backend;
- unsupported task approval points, task budgets, or role tool allowlists;
- concurrency or resource conflicts.

Warnings must be reviewed and accepted before approval. Editing the draft requires a new save and preflight.

## An approved plan does not execute

- Confirm that the exact approved revision is selected in Plan.
- Select **Review execution request**, then confirm the separate warning. One click intentionally does not start work.
- If the DSH profile, Provider, tools, or presets changed after approval, create a new revision, save it, rerun preflight, and approve it.
- Check Chat and Trajectory for the visible execution request and execution-tool call.
- Confirm that the execution tool is still enabled in the current Agent Preset; create a new conversation after changing the preset.
- Confirm that the selected Provider is installed, authenticated, and available.
- Check Chat, Trajectory, and Provider logs for the reported error.

## An external Agent does not start

- Confirm that its Provider Bundle is installed in the same profile.
- Complete the Provider's normal authentication and configuration.
- Keep the Provider, DSH, and this plugin on compatible versions.
- Check Trajectory and Provider logs for the reported error.

## A run stays active longer than expected

Open Trajectory and check the Provider process or logs. If the Provider is no longer responsive, stop it through its normal control path. Restart the Web profile only if the lifecycle does not recover.

## Cancellation is rejected or stays pending

- Cancellation works only from **Recovery** at the current live cursor and requires two clicks.
- A newer event, expired grant, Host restart, terminal execution, or mismatched Session safely invalidates the request. Return to live, refresh the preview, and review the impact again.
- A successfully requested cancellation remains active until DSH and the Provider report that every task has settled. Check Trajectory and Provider logs if the state does not change.

## Deviation is stale or historical

Select **Return live** above the timeline. Capsule, telemetry, and live control are intentionally disabled while the cursor is paused. If the page still reports stale facts, select **Retry**; do not treat the visible graph as current until the status returns to ready.

## Recipe cannot be created

A candidate requires at least three distinct executions that share the same canonical plan contract, capability digest, and verifier suite. Every selected run must have succeeded, contain the required authoritative verifier receipts, and have no open blocking finding. Permission enforcement is still rechecked when the candidate creates a new draft.

## Foundry storage is degraded

The page shows `disk/degraded` or `host-only/degraded` when the bounded journal cannot accept more durable facts or a disk write fails. Stop starting new executions, inspect available disk space and the Host log, then restart only after the storage problem is fixed. Existing facts remain bounded; the plugin never labels an interrupted run as successful.

See [Data and Privacy](data-and-privacy.md) before disabling persistence or removing local Foundry data.

## The page disconnects

Restore or restart the Web profile, then refresh the page. Run `dsh --profile web --dump-config` again if the plugin does not reconnect.

## Version or peer dependency errors appear

Align the plugin, Provider Bundles, and all DSH packages to the exact supported version family. Do not mix the release with a later moving prerelease tag.

## Plans, execution history, or card positions disappear

Foundry plan and execution facts persist by default, but manually adjusted card positions belong only to the current browser page. If facts disappear, check the storage status and confirm that the profile is using the same DSH home directory as before.

If a problem remains reproducible, open a [GitHub Issue](https://github.com/Jokasa7/dsh-product-subagent-console/issues) with the DSH version, plugin version, Provider name, browser, and visible error. Remove credentials and private task content before posting.
