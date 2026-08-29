# Data and Privacy

[简体中文](data-and-privacy.zh.md)

## What is stored

Foundry storage is enabled by default. The Host keeps a bounded append-only journal under the DSH home directory:

```text
plugins/dsh-product-subagent-console/foundry-v1/events.jsonl
```

The journal contains complete schema-validated plan revisions, execution snapshots, lifecycle and control events, and verifier receipts. Conformance findings are recomputed from those facts. Complete plan revisions include the objective, success criteria, role responsibilities and boundaries, task briefs, expected outputs, completion criteria, resource claims, Provider/tool choices, verifier contracts, and budgets entered by the user.

The plugin does not collect the raw conversation transcript, complete model output, native stdout/stderr, environment variables, or hidden reasoning from DSH runtime streams. However, any credential, private text, repository path, or other sensitive value typed into a plan field is part of that plan and is stored verbatim. Do not place secrets or unnecessary private content in plans.

The contiguous hash chain detects accidental corruption. It is not encryption and is not a cryptographic defense against a local user who can rewrite both records and hashes. Anyone who can read the DSH home may be able to read plan content.

## Limits and degraded mode

In-memory collections and the journal have explicit record and byte limits. An execution must have enough Event and Receipt capacity reserved before its Workflow starts. If disk writes fail or the journal reaches its disk limit, storage becomes `degraded` and the current Host may continue with bounded memory facts; the UI displays the current durability and storage status.

On restart, the Host validates the record sequence and hash chain. A corrupt journal is quarantined and a new journal is created. Nonterminal recovered executions are closed as `unknown`, never as success. Incomplete control chains are closed as restarted or interrupted.

## Disable future persistence

Set the plugin option:

```yaml
foundryStorage: false
```

This prevents future disk persistence for that configuration. It does not delete a journal created earlier.

`foundryStorageDirectory` may be set to an explicit absolute directory when the DSH profile needs a different local location. Do not place credentials in this value or point multiple active Hosts at one directory; the plugin enforces a cooperative single-writer lock.

## Exports

- Run Capsules use an allowlisted public projection, pseudonymized identifiers, bounded evidence closure, and a manifest digest.
- Objectives and task briefs are excluded by default and are sanitized when explicitly included.
- A Recipe ZIP contains the typed plan template—including its reusable plan text—plus `SKILL.md` and checksums, but not raw conversation transcripts or model outputs. Export rejects recognizable credentials and absolute paths; inspect the archive before sharing.
- OTLP JSON is an offline preview and is disabled by default. No network exporter is created, and run, attempt, and task identities are exported only as digests.

Exports are files chosen by the user and may contain task titles or optional text the user asked to include. Inspect them before sharing.

To verify a Capsule manifest after transport, use the package's public verifier:

```js
import { verifyRunCapsuleManifest } from 'dsh-product-subagent-console/capsule'

const valid = verifyRunCapsuleManifest(manifest)
```

## Remove local Foundry data

1. Stop DSH Desktop or the affected Web profile so no Host holds the writer lock.
2. Resolve the DSH home used by that profile.
3. Back up the plugin directory if the history may still be useful.
4. Remove only `plugins/dsh-product-subagent-console/foundry-v1` from that DSH home.
5. Start the profile and verify that Foundry reports a new empty journal.

Uninstalling the plugin does not automatically remove this data.
