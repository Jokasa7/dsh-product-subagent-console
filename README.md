# DSH Product Subagent Console

English · [简体中文](README.zh.md)

[![CI](https://github.com/Jokasa7/dsh-product-subagent-console/actions/workflows/ci.yml/badge.svg)](https://github.com/Jokasa7/dsh-product-subagent-console/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Jokasa7/dsh-product-subagent-console?include_prereleases)](https://github.com/Jokasa7/dsh-product-subagent-console/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A draggable task canvas for viewing subagent activity inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) conversations.

> Requires DSH `0.1.1-rc.2`. This is an independent community plugin.

![DSH Product Subagent Console](docs/assets/subagent-canvas-live.jpg)

## Features

- Adds a **Subagents** tab beside Chat and Trajectory.
- Displays native child sessions and compatible Provider runs as branches.
- Shows each task, Agent, status, and duration.
- Supports pan, zoom, minimap, auto-layout, and draggable cards.
- Opens task details with one click.
- Opens native DSH child conversations directly from the details panel.
- Includes English and Simplified Chinese interfaces.

## Requirements

- DeepSeek Harness Web profile on `0.1.1-rc.2`
- Node.js `^22.19.0` or `>=24.0.0`
- An optional compatible Provider Bundle when delegating to an external coding Agent

Keep the plugin and all DSH packages on the same supported version family.

## Install

1. Download the `.tgz` file and `SHA256SUMS.txt` from the matching [GitHub Release](https://github.com/Jokasa7/dsh-product-subagent-console/releases).
2. Verify the archive:

   ```sh
   sha256sum --check SHA256SUMS.txt
   ```

3. Install it into the Web profile and confirm the configuration:

   ```sh
   dsh plugin --profile web add ./dsh-product-subagent-console-0.1.0-alpha.2.tgz
   dsh --profile web --dump-config
   ```

4. Restart the Web profile.

See the [Getting Started guide](docs/getting-started.md) for Provider setup, Agent Presets, updates, and the optional plugin tool.

## Quick start

1. Open **Settings → Agent Presets** and copy a preset.
2. Enable the official delegation tool for the Provider you want to use.
3. Create a new conversation with that preset.
4. Start a delegated task, then open the **Subagents** tab.

Preset changes apply to new conversations only.

## Canvas controls

- Drag empty space to pan and use the mouse wheel to zoom.
- Drag a card to adjust its position for the current page.
- Use the toolbar to zoom, fit the view, or restore automatic layout.
- Click a card to view its task and lifecycle details.

## Documentation

- [Getting Started](docs/getting-started.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Changelog](CHANGELOG.md)
- [Security](SECURITY.md)

## Uninstall

```sh
dsh plugin --profile web remove dsh-product-subagent-console
```

Restart the Web profile after removal.

## Support

Use [GitHub Issues](https://github.com/Jokasa7/dsh-product-subagent-console/issues) for reproducible bugs and feature requests. Please use the private channel described in [SECURITY.md](SECURITY.md) for security reports.

## License

[MIT](LICENSE). Third-party notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
