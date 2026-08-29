# Contributing

English | [简体中文](CONTRIBUTING.zh.md)

Thank you for improving Product Subagent Console. Keep contributions focused on observable user outcomes and facts available from supported DeepSeek Harness contracts.

## Before you start

- Use Node.js `^22.19.0` or `>=24.0.0`, pnpm `11.7.0`, and DSH `0.1.1-rc.2`.
- Search existing Issues before opening a new bug or feature request.
- For larger changes, open an Issue first so compatibility and product boundaries can be agreed before implementation.
- Never include credentials, authentication configuration, private prompts, model output, local paths, environment values, native stderr, or real user task data.

## Product boundaries

- Runtime state must come from authoritative DSH Session, lifecycle, or plugin-owned execution records.
- Do not invent progress, success, queue state, retries, child Sessions, or Provider capabilities.
- Canvas interaction may change presentation, but it must not silently reparent or mutate running work.
- Keep the repository directly installable as a DSH Bundle and avoid unpublished or patched Harness APIs.

## Local workflow

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
pnpm run pack:check
pnpm run publint
pnpm run smoke:web
```

Use synthetic or deliberately controlled test data. UI changes should include a sanitized screenshot or a short description of the verified browser journey.

## Pull requests

- Keep each PR narrow and explain the user-visible outcome.
- Add or update tests for lifecycle, persistence, recovery, and privacy behavior touched by the change.
- Update `README.md` and `README.zh.md` together when their shared content changes.
- Update `CHANGELOG.md` for user-visible behavior.
- Confirm `pnpm run verify:public` before submitting. It prevents internal instructions, temporary artifacts, private paths, credentials, logs, and unreviewed file types from entering the public tree.

Security vulnerabilities must be reported privately through [GitHub Security Advisories](https://github.com/Jokasa7/dsh-product-subagent-console/security/advisories/new), not through a public Issue.
