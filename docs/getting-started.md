# Getting Started

[English](getting-started.md) · [简体中文](getting-started.zh.md)

This guide installs DSH Product Subagent Console into a DeepSeek Harness Web profile and enables subagent activity for a new conversation.

## Before you begin

You need:

- DeepSeek Harness `0.1.1-rc.2`
- Node.js `^22.19.0` or `>=24.0.0`
- A working DSH Web profile

The console can display native DSH child sessions without an external Provider. Install a Provider only when you want to delegate to that product.

## Install the console

Download the `.tgz` archive and `SHA256SUMS.txt` from the matching [GitHub Release](https://github.com/Jokasa7/dsh-product-subagent-console/releases).

Verify the archive before installation:

```sh
sha256sum --check SHA256SUMS.txt
```

Install the archive into the Web profile:

```sh
dsh plugin --profile web add ./dsh-product-subagent-console-0.1.0-alpha.2.tgz
dsh --profile web --dump-config
```

The configuration output should contain `product-subagent-console`. Restart the Web profile after installation.

On Windows PowerShell, you can compare the archive hash with the value in `SHA256SUMS.txt`:

```powershell
Get-FileHash .\dsh-product-subagent-console-0.1.0-alpha.2.tgz -Algorithm SHA256
```

## Add an external Provider

Install only the Provider you use, keeping it on the same DSH version family:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-subagent-codex@0.1.1-rc.2
dsh plugin --profile web add @deepseek-ai/dsh-subagent-claude-code@0.1.1-rc.2
```

Complete the Provider's normal authentication and configuration, then restart the Web profile. Installing this console does not install or authenticate an external coding Agent.

## Enable delegation in a preset

1. Open **Settings → Agent Presets**.
2. Copy a preset and edit the copy.
3. Enable the official `@deepseek-ai/dsh-tool-subagent` entry for the selected Provider.
4. Save the preset.
5. Create a new conversation with the updated preset.

Existing conversations keep the preset generation with which they were created.

## Use the canvas

Start a delegated task, then open the **Subagents** tab beside Chat and Trajectory.

- Drag empty space to pan and use the mouse wheel to zoom.
- Drag a card to adjust the current layout.
- Use the toolbar to fit the view or restore automatic layout.
- Click a card to open its details.
- For native child sessions, use the details action to open the child conversation.

## Optional plugin-owned tool

The console also provides an optional delegation tool. Add it to a copied Agent Preset only when you want to initiate Provider tasks through this plugin:

```yaml
- id: console-codex
  name: dsh-product-subagent-console/tool
  config:
    provider: codex
    toolName: console_codex
    enableRunInBackground: false
```

`provider` must match an installed Provider name. Keep every `toolName` unique within the preset, then create a new conversation after saving it.

## Update

Download and verify the new Release archive, stop the Web profile, install the new archive with `dsh plugin --profile web add`, and restart the profile. Update the console and DSH packages together whenever the compatibility version changes.

## Uninstall

```sh
dsh plugin --profile web remove dsh-product-subagent-console
```

Restart the Web profile after removal.

For common setup problems, see [Troubleshooting](troubleshooting.md).
