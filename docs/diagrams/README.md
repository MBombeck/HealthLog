# Diagrams

Six SVG diagrams that anchor the architecture story. Hand-drawn-style,
Dracula palette, no external dependencies. Embed in README and doc-site
pages as `<img>` tags. Mirrored into `healthlog-docs/src/assets/diagrams/`
and `healthlog-landing/public/diagrams/` so each surface ships its own
copy.

| File                           | Story it tells                                                                                                                                                                                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-data-flow.svg`             | Sources (Withings, Apple Health export.zip, iPhone HealthKit, manual, Nightscout) → ingest endpoints → Measurement + MeasurementRollup → reads (rollup probe / live SQL fallback / cache) → surfaces (dashboard, insights, Coach, doctor PDF).                                                                             |
| `02-coach-pipeline.svg`        | User question → snapshot builder → prompt assembler → provider chain (ChatGPT OAuth / OpenAI / Anthropic / local / admin-shared) → response parser → cited reply with mini-charts.                                                                                                                                         |
| `03-self-hosting-topology.svg` | Internet → reverse proxy (TLS) → Next.js app (port 3000) ↔ pg-boss worker ↔ Postgres 18, plus GHCR image pull, optional Coolify autodeploy, optional S3 off-host backup.                                                                                                                                                   |
| `04-source-priority.svg`       | Three sources for the same metric on the same day → resolver picks one canonical row per (cumulative vs point) ladder. Losing rows stay in the audit trail.                                                                                                                                                                |
| `05-security-model.svg`        | Three concentric layers — auth perimeter (passkey + password fallback), session perimeter (HttpOnly cookie + Postgres sessions), encrypted core (AES-256-GCM versioned keys). Side rails: rate limiter, audit log, HMAC tokens, CSP/HSTS, SSRF guard.                                                                      |
| `10-push-relay.svg`            | Your server seals each push with HPKE (RFC 9180, auth mode, X25519, ChaCha20-Poly1305) for one iPhone; the push relay and Apple APNs carry the sealed envelope; the Notification Service Extension opens it with a CryptoKit key kept in the keychain. Device-signed Ed25519 binding, direct revoke, signed relay answers. |

The docs site carries four further diagrams that live only there and are not
mirrored here or to the landing: `06-tls-trust-flow.svg`,
`07-apns-push-flow.svg`, `08-health-record-export.svg` and
`09-sync-delta-feed.svg`. Numbers are shared across all three repos, so a new
diagram takes the next number after the highest one in any of them.

## Editing

Open in any text editor. Each file is hand-authored SVG ≤ 12 KB; the
viewport, the `defs` block of arrow markers, and the labelled groups are
all readable inline. Keep the Dracula palette (`#282a36` background,
`#f8f8f2` text, accents `#8be9fd / #ffb86c / #50fa7b / #bd93f9 /
#ff79c6 / #ff5555`) and the `viewBox="0 0 1200 620"` constraint so the
diagrams stay consistent across the three sites.

After editing, copy the file to the sister repos so all three surfaces
ship the updated version.
