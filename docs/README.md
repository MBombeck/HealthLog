# `docs/` — internal reference + operator playbooks

The user-facing documentation lives at **<https://docs.healthlog.dev>** —
that's the canonical surface for self-hosting guides, integration
walkthroughs, AI-provider setup, and the doctor-report workflow.

The files in this directory are the internal operator playbooks, audit
notes, and machine-readable specs that ship alongside the source:

- [`api/`](./api/) — the OpenAPI 3.1 spec for the native-client subset
  (iOS DTO codegen target). See [`api/README.md`](./api/README.md) for
  the preview commands.
- [`ops/`](./ops/) — backup / restore + encryption-key-rotation
  playbooks. These are the runbooks an operator reaches for during an
  incident.
- [`self-hosting/`](./self-hosting/) — horizontal-scaling notes
  (`HEALTHLOG_PROCESS_TYPE=web|worker|all`) and the deploy-pipeline
  recipe. Routine install steps stay on `docs.healthlog.dev`.
- [`migration/`](./migration/) — release-by-release migration notes.
  Read the entry for the version you're upgrading from.
- [`audit/`](./audit/) — per-release audit summaries archived for
  forensic traceability.
- [`apple-store-connect-checklist.md`](./apple-store-connect-checklist.md)
  — the iOS submission gate.
- [`doctor-report.md`](./doctor-report.md) — PDF generator design
  notes.
- [`codex-protocol-spec.md`](./codex-protocol-spec.md) — Codex / ChatGPT
  OAuth protocol reverse-engineering notes.
- [`ui-guidelines.md`](./ui-guidelines.md) — UI / a11y house style.

If you're a self-hoster looking to spin up an instance, start at
<https://docs.healthlog.dev> or jump to the [Quick Start in the project
README](../README.md#quick-start).
