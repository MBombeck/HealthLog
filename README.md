<p align="center">
  <img src="public/logo-readme.svg" alt="HealthLog logo" width="120" height="120" />
</p>

<h1 align="center">HealthLog</h1>

<p align="center">
  <strong>Self-hosted, privacy-first health tracking. Your vitals, your devices, your server.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-PolyForm--Noncommercial--1.0.0-blue.svg" alt="License: PolyForm Noncommercial 1.0.0" /></a>
  <a href="https://github.com/MBombeck/HealthLog/releases"><img src="https://img.shields.io/github/v/release/MBombeck/HealthLog?sort=semver&color=success&cacheSeconds=60" alt="Latest release" /></a>
  <a href="https://github.com/MBombeck/HealthLog/actions/workflows/integration.yml"><img src="https://img.shields.io/github/actions/workflow/status/MBombeck/HealthLog/integration.yml?branch=main&label=CI" alt="CI status" /></a>
  <a href="https://testflight.apple.com/join/bucuTBpa"><img src="https://img.shields.io/badge/iOS-TestFlight-007AFF?logo=apple&logoColor=white" alt="iOS app on TestFlight" /></a>
</p>

<p align="center">
  <a href="https://healthlog.dev">Website</a> &middot;
  <a href="https://demo.healthlog.dev">Live Demo</a> &middot;
  <a href="https://docs.healthlog.dev">Documentation</a> &middot;
  <a href="https://testflight.apple.com/join/bucuTBpa">iOS TestFlight</a>
</p>

<img width="2434" height="1247" alt="HealthLog dashboard: health metric tiles with 7-day trends, blood-pressure and weight charts, dark theme" src="docs/assets/dashboard-hero.jpeg" />

## Why HealthLog

HealthLog is a self-hosted health tracking app (PWA + native iOS client) that runs from a single `docker compose up` on a NAS, homelab, or small VPS. It brings weight, blood pressure, pulse, blood glucose, body composition, sleep, mood, menstrual cycle, and medications onto one timeline — synced from the devices you already own — and keeps everything encrypted at rest on hardware you control. No vendor cloud, no subscription, no telemetry.

HealthLog is a personal health record-keeping and wellness tool. It is not a medical device and does not diagnose, treat, cure, or prevent any disease — it helps you log, visualise, and export your own data, and leaves clinical judgement to a clinician.

Try the [live demo](https://demo.healthlog.dev) to see a working install — sign in with `demo` / `demo123demo123`.

## Highlights

- **Every vital on one timeline.** Weight, blood pressure, pulse, glucose, body composition, sleep, SpO₂, respiratory rate, mood, and cycle tracking — charted with trends, moving averages, and clinical reference ranges (ESH 2023, ADA 2024), overridable with the targets your clinician set.
- **Clinical signals, opt-in and additive.** Validated self-checks for mental wellbeing and sleep (WHO-5, PHQ-9, GAD-7, Sleep Condition Indicator — official questionnaire wording, calm crisis-resource handling), grip strength, a 0–10 pain score, waist and body measurements, and a longevity lab panel — each added through one signal registry, so a new signal wires into charts, correlations, the coach, the FHIR map, and the API at once.
- **Records, structured.** Allergies and family history as encrypted structured records that flow into the doctor report, plus lab values you key in or scan from a printed report — OCR extracts the stated values, units, and dates for you to review and confirm before anything is saved. HealthLog transcribes what a report says; it never interprets or diagnoses from it. A vaccination record keeps a lifetime immunization log, doses grouped under the disease they protect against, and prints in the doctor report.
- **A document vault for the paper trail.** An opt-in module stores every letter, report, and scan encrypted at rest — PDFs and photos preview inline, Office and text files stay download-only, and nothing user-uploaded can ever execute in the app. One searchable timeline with type, condition, and year filters, drag-and-drop and paste-to-upload, bulk filing, undo-able delete with a 30-day grace, and per-file/per-account limits the operator tunes.
- **Context that explains the numbers.** An opt-in environmental module folds weather, daylight, and temperature in as influence signals (winter darkness against mood, heat against blood pressure) using a home location you set, so a pattern has somewhere to point.
- **Your devices, one server.** Withings, WHOOP, Oura and Polar sync over OAuth2, Google Health connects Fitbit and Pixel Watch through your own Google Cloud client, Nightscout streams CGM glucose, an Apple Health `export.zip` folds your full history in, and the native iOS app streams HealthKit live. A per-metric source priority decides which reading is canonical when wearables overlap.
- **Medication tracking that tells the truth.** Flexible schedules (weekly injections, weekday-only, intervals, PRN, cyclic), a configurable intake window per dose, and a traceable dose history where every slot reads taken, late, skipped, or missed — the same ledger the compliance rate is computed from, so the percentage can never disagree with the timeline.
- **AI insights you own.** Daily briefing, health scores, correlations, and a conversational coach grounded in your own measurements and interpreted against cited guideline reference bands — where a value sits and what that means in plain words, never a diagnosis. The coach proposes concrete if-then plans you accept or decline, and suppresses proactive check-ins when there's nothing genuine to say. Bring your own OpenAI or Anthropic key, or point at a local endpoint (Ollama, LM Studio, vLLM) so nothing leaves your network.
- **Clinician-ready output.** A doctor-report PDF generated client-side, a read-only HL7 FHIR R4 API, and scoped, time-limited share links you revoke after the visit.
- **Private by construction.** AES-256-GCM encryption at rest with zero-downtime key rotation, passkey login, server-side sessions, strict CSP — and no third-party tracking anywhere.
- **Built to be lived in.** Installable PWA with offline support, medication reminders over APNs, Telegram, ntfy, and Web Push, a sub-second dashboard on years of imported history — in English, German, Spanish, French, Italian, Polish, and Korean end to end.

The full feature tour, integration guides, and API reference live at [docs.healthlog.dev](https://docs.healthlog.dev).

## Quick start (Docker Compose)

```bash
git clone https://github.com/MBombeck/HealthLog.git && cd HealthLog
cp .env.example .env

# Generate the three secrets (each a 64-char hex string = 32 bytes):
echo "POSTGRES_PASSWORD=$(openssl rand -hex 32)" >> .env
echo "ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env
echo "API_TOKEN_HMAC_KEY=$(openssl rand -hex 32)" >> .env

# LAN / plain-HTTP host (NAS, homelab, Tailscale) — required, or login fails:
echo "SESSION_COOKIE_SECURE=false" >> .env

docker compose up -d
```

Open **http://localhost:3000** (or `http://<host>:3000`) — the first registered user becomes admin. The compose file pulls a pre-built multi-arch image (`amd64` + `arm64`) from [GHCR](https://github.com/MBombeck/HealthLog/pkgs/container/healthlog); no build step required.

Verify the running version:

```bash
curl -s http://localhost:3000/api/version   # returns version + buildSha + builtAt
```

`SESSION_COOKIE_SECURE=false` is the one setting plain-HTTP self-hosts must set: without it the session cookie carries the `Secure` flag, the browser drops it over HTTP, and login silently fails. Leave it unset (or `true`) only when a TLS reverse proxy serves HTTPS — and then set `NEXT_PUBLIC_APP_URL` and `APP_URL` to the public URL first (see the [self-hosting guide](https://docs.healthlog.dev/self-hosting/)).

Persistent state lives in exactly one named volume (`pgdata`, the Postgres data dir); the app container is stateless, so backing up the database backs up everything.

NAS and homelab users have ready-made paths: [Unraid Community Applications](docs/self-hosting/unraid.md) and [Portainer app templates](docs/self-hosting/portainer/README.md).

## Self-hosting

One container hosts both the web server and the job worker by default; split them via `HEALTHLOG_PROCESS_TYPE=web|worker` for horizontal scale. Encrypted daily backups to any S3-compatible bucket are opt-in via the admin panel, new users join by invite link or QR code, and the stack works out of the box behind Caddy, Traefik, Nginx, or [Coolify](https://coolify.io/).

HealthLog ships releases roughly weekly. Pin a tag, back up before upgrades, and skim the [CHANGELOG](CHANGELOG.md) before pulling `latest`. The operator manual — reverse proxy, migrations, encryption-key rotation, backup and restore — lives at [docs.healthlog.dev](https://docs.healthlog.dev).

## Native iOS app

A SwiftUI companion in public beta via [TestFlight](https://testflight.apple.com/join/bucuTBpa), built on the same API as the web client: live HealthKit two-way sync, medication reminders with action buttons that work without opening the app, and an on-device coach on Apple-Intelligence-capable iPhones. Code lives in [MBombeck/healthlog-iOS](https://github.com/MBombeck/healthlog-iOS).

## Tech stack

Next.js 16 (App Router, React Server Components), TypeScript strict, PostgreSQL 16 with Prisma, pg-boss for jobs, Tailwind CSS 4 + shadcn/ui, Recharts, WebAuthn passkeys, Vitest + Playwright, multi-stage Alpine Docker image. The OpenAPI 3.1 contract for native clients is generated from the Zod schemas at [`docs/api/openapi.yaml`](docs/api/openapi.yaml).

## Documentation

|                        |                                                  |
| ---------------------- | ------------------------------------------------ |
| User and operator docs | [docs.healthlog.dev](https://docs.healthlog.dev) |
| Release history        | [CHANGELOG.md](CHANGELOG.md)                     |
| API contract           | [`docs/api/openapi.yaml`](docs/api/openapi.yaml) |
| Security policy        | [SECURITY.md](SECURITY.md)                       |
| Contributing           | [CONTRIBUTING.md](CONTRIBUTING.md)               |

## Status

Actively developed — new releases roughly weekly, issue reports and PRs welcome. Behaviour and schema can change between versions; migrations are forward-only.

## Thanks

HealthLog is built in the open and people keep making it better. Alongside
bug reports, setup questions and the ideas that turned into features, these
people have sent code that shipped:

<a href="https://github.com/MBombeck/HealthLog/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=MBombeck/HealthLog" alt="Contributors to HealthLog" />
</a>

Every merged pull request keeps its author's name on the commit, so the
[contributor graph](https://github.com/MBombeck/HealthLog/graphs/contributors)
is the full list. Release notes name the people whose work is in that release,
including anyone who found the defect without sending the fix.

## License

HealthLog is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE): free to use, self-host, and modify for noncommercial purposes. Commercial use requires a separate agreement — open an issue or reach out via [healthlog.dev](https://healthlog.dev). Releases up to and including v1.15.18 were published under AGPL-3.0 and remain available under that license.

---

<p align="center">
  <a href="https://healthlog.dev">healthlog.dev</a> &middot;
  <a href="https://demo.healthlog.dev">Live Demo</a> &middot;
  <a href="https://docs.healthlog.dev">Docs</a> &middot;
  <a href="https://testflight.apple.com/join/bucuTBpa">iOS TestFlight</a> &middot;
  <a href="https://buymeacoffee.com/mbombeck">Buy Me a Coffee</a>
</p>
