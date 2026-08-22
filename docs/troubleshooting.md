# Troubleshooting

[English](troubleshooting.md) · [简体中文](troubleshooting.zh.md)

## The Subagents tab is missing

- Confirm that the plugin is installed in the Web profile, not only another profile.
- Run `dsh --profile web --dump-config` and look for `product-subagent-console`.
- Confirm that DSH and the plugin use the supported version family.
- Restart the Web profile and refresh the page.

## The tab is visible but the canvas is empty

- Confirm that the selected Agent Preset enables a delegation tool.
- Create a new conversation after changing a preset.
- Start a delegated task in that new conversation.

## An external Agent does not start

- Confirm that its Provider Bundle is installed in the same profile.
- Complete the Provider's authentication and configuration.
- Keep the Provider, DSH, and this plugin on compatible versions.
- Check Trajectory and the Provider logs for the reported error.

## The optional plugin tool is missing

- Confirm that `provider` matches the installed Provider name.
- Give the tool a unique `toolName` within the Agent Preset.
- Save the preset and create a new conversation.

## A task remains “Running” longer than expected

Open Trajectory and check the Provider process or Provider logs. The card remains active while DSH reports that run as active. If the Provider is no longer responsive, stop it through its normal control path, then restart the Web profile if the lifecycle does not recover.

## The Host is unavailable or the page disconnects

Restore or restart the Web profile, then refresh the page. Re-run `dsh --profile web --dump-config` if the plugin does not reconnect.

## “Background jobs unavailable” appears

Set `enableRunInBackground: false` in the optional tool configuration, or install the compatible DSH Jobs runtime before enabling background execution.

## “Queue full” appears

Wait for an active task to finish before starting another one. If this is a regular workload, review the console limits in the DSH plugin configuration.

## Version or peer dependency errors appear

Align the plugin, Provider Bundles, and all DSH packages to the exact supported version family. Do not mix this release with a later moving prerelease tag.

## History or card positions disappear after restart

This release does not persist completed task history or manually adjusted card positions across Host or page restarts.

If the problem remains reproducible, open a [GitHub Issue](https://github.com/Jokasa7/dsh-product-subagent-console/issues) with the DSH version, plugin version, Provider name, browser, and the visible error. Remove credentials and private task content before posting.
