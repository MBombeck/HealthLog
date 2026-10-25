# `docs/` — internal reference + operator playbooks

The user-facing documentation lives at **<https://docs.healthlog.dev>** —
that's the canonical surface for self-hosting guides, integration
walkthroughs, AI-provider setup, and the doctor-report workflow.

The files in this directory are the internal operator playbooks, audit
notes, and machine-readable specs that ship alongside the source:

- [`api/`](./api/) — the OpenAPI 3.1 spec for the native-client subset
  (iOS DTO codegen target). See [`api/README.md`](./api/README.md) for
  the preview commands. Also home to the MCP-server contract:
  [`api/mcp-capabilities.md`](./api/mcp-capabilities.md) (tools,
  resources, prompts, write model) and
  [`api/mcp-skills.md`](./api/mcp-skills.md) (building a connector / skill).
- [`ops/`](./ops/) — operator runbooks: deploy, backup / restore,
  encryption-key rotation, password reset and account recovery, env
  checks, TLS pinning, data repair. These are what an operator reaches
  for during an incident.
- [`self-hosting/`](./self-hosting/) — operator notes next to the code:
  [`getting-started.md`](./self-hosting/getting-started.md) (install and
  updates, the page the boot log points at), the TrueNAS, Unraid and
  Portainer installs with their catalog templates, Tailscale, the reverse
  proxy, horizontal scaling (`HEALTHLOG_PROCESS_TYPE=web|worker|all`),
  notification channels, the environment module, document sources and
  reproductive-health data. Includes
  [`self-hosting/mcp.md`](./self-hosting/mcp.md) — enabling the
  off-by-default MCP connector and pointing Claude.ai / ChatGPT /
  Claude Desktop at it, and [`self-hosting/sso.md`](./self-hosting/sso.md)
  — OIDC SSO login: IdP setup, the identity-pinning security model,
  `OIDC_ONLY` consequences, and the break-glass runbook. Also
  [`self-hosting/geolite2.md`](./self-hosting/geolite2.md) — bringing your
  own offline GeoLite2 databases via `GEOLITE2_DIR` instead of sending
  login IPs to a third-party lookup. And
  [`self-hosting/account-sharing.md`](./self-hosting/account-sharing.md) —
  letting one account on the instance open another's health record: the
  three access levels, the eight sections a grant can be narrowed to,
  managed profiles for somebody with no login and the guardians who look
  after them, what revocation does and does not undo, and which trust
  properties of the instance are unchanged by any of it. And
  [`self-hosting/support.md`](./self-hosting/support.md) — reporting a
  problem: error ids, the support info every account can copy, the
  operator's redacted support report, and finding an error in the admin log.
- [`using/`](./using/) — notes on using the app that sit close to the
  code. [`using/search.md`](./using/search.md) covers the command palette's
  record search: opening it, what it finds, how matching works, and its
  limits on very large and shared records.
- [`migration/`](./migration/) — migration notes. Currently only
  v1.3 to v1.4; later releases are covered by `CHANGELOG.md` and
  <https://docs.healthlog.dev>.
- [`integrations/`](./integrations/) — per-integration reference:
  Withings, WHOOP, Fitbit, Google Health, Strava, Nightscout, Dawarich and
  the Garmin route; the Apple Health, Health Connect, document and data
  imports; AI providers; and Home Assistant with its blueprint. Oura and
  Polar are covered on the docs site only.
- [`adr/`](./adr/) — architecture decision records.
- [`security/`](./security/) — threat-model notes.
- [`diagrams/`](./diagrams/) — architecture diagrams rendered through
  docs.healthlog.dev.
- [`releases/`](./releases/) — release imagery.
- [`apple-store-connect-checklist.md`](./apple-store-connect-checklist.md)
  — the iOS submission gate.
- [`codex-protocol-spec.md`](./codex-protocol-spec.md) — Codex / ChatGPT
  OAuth protocol reverse-engineering notes.
- [`contributing/ui-standards.md`](./contributing/ui-standards.md) — the
  binding UI standards: card anatomy, spacing, text colour, tokens and
  which primitive to use where. Read before touching any surface.
- [`contributing/benchmarks.md`](./contributing/benchmarks.md) — the
  large-account benchmark (latency and statements per request) and the
  statement budgets on the hot routes.
- [`contributing/testing.md`](./contributing/testing.md) — which suite a
  test belongs in, the route test kit, the integration database, sharding,
  property and mutation tests, and the flaky-test quarantine.
- [`ui-guidelines.md`](./ui-guidelines.md) — UI / a11y house style; where
  it disagrees with the UI standards, the standards win.

If you're a self-hoster looking to spin up an instance, start at
<https://docs.healthlog.dev> or jump to the [Quick Start in the project
README](../README.md#quick-start-docker-compose).
