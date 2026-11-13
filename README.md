<p align="center">
  <img src="public/logo-readme.svg" alt="HealthLog logo" width="120" height="120" />
</p>

<h1 align="center">HealthLog</h1>

<p align="center">
  <strong>Self-hosted health tracking that syncs your devices and keeps the data on your own server.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-PolyForm--Noncommercial--1.0.0-blue.svg" alt="License: PolyForm Noncommercial 1.0.0" /></a>
  <a href="https://github.com/MBombeck/HealthLog/releases"><img src="https://img.shields.io/github/v/release/MBombeck/HealthLog?sort=semver&color=success&cacheSeconds=60" alt="Latest release" /></a>
  <a href="https://github.com/MBombeck/HealthLog/actions/workflows/integration.yml"><img src="https://img.shields.io/github/actions/workflow/status/MBombeck/HealthLog/integration.yml?branch=main&label=CI" alt="CI status" /></a>
  <a href="https://apps.apple.com/app/id6769501341"><img src="https://img.shields.io/badge/iOS-App%20Store-0D96F6?logo=apple&logoColor=white" alt="HealthLog Companion App on the App Store" /></a>
  <a href="https://testflight.apple.com/join/bucuTBpa"><img src="https://img.shields.io/badge/iOS-TestFlight-007AFF?logo=apple&logoColor=white" alt="iOS app on TestFlight" /></a>
</p>

<p align="center">
  <a href="https://healthlog.dev">Website</a> |
  <a href="https://demo.healthlog.dev">Live Demo</a> |
  <a href="https://docs.healthlog.dev">Documentation</a> |
  <a href="https://apps.apple.com/app/id6769501341">iOS App Store</a> |
  <a href="https://testflight.apple.com/join/bucuTBpa">iOS TestFlight</a>
</p>

<img width="2400" height="1500" alt="HealthLog dashboard in dark theme: a lead sentence on the latest vitals, today's medications, sleep and cycle, the health score ring, worth-a-look cards, and metric tiles with 7-day trends" src="docs/assets/dashboard.jpeg" />
<p align="center">
  <img src="docs/assets/timeline.jpeg" alt="Timeline: life events, conditions, medications, vaccinations, labs and cycles on one time axis, above blood pressure, weight and resting heart rate" width="32%">
  <img src="docs/assets/day-panel.jpeg" alt="Blood pressure insights with the day panel open: what was running that day, its values and scores" width="32%">
  <img src="docs/assets/resting-heart-rate.jpeg" alt="Resting heart rate insights: summary, usual range and the full history chart" width="32%">
</p>
<p align="center">
  <img src="docs/assets/medications.jpeg" alt="Medications with next and last intake, adherence and streaks" width="32%">
  <img src="docs/assets/labs.jpeg" alt="Lab results with reference ranges and trend sparklines" width="32%">
  <img src="docs/assets/coach.jpeg" alt="Coach: a conversation about the week's recovery, grounded in the recorded data" width="32%">
</p>

## What HealthLog is

HealthLog is a self-hosted health tracking app (PWA + native iOS client) that runs from a single `docker compose up` on a NAS, homelab, or small VPS. It brings weight, blood pressure, pulse, blood glucose, body composition, sleep, mood, menstrual cycle, and medications onto one timeline, synced from the devices you already own, and keeps it in a Postgres database on hardware you control. It needs no vendor cloud or subscription and sends no usage telemetry. The few requests the server makes on its own (an update check, a password breach check, an IP geolocation lookup for logins) can each be switched off.

HealthLog is a personal health record-keeping and wellness tool. It is not a medical device and does not diagnose, treat, cure, or prevent any disease. It helps you log, visualise, and export your own data, and leaves clinical judgement to a clinician.

Try the [live demo](https://demo.healthlog.dev) to see a working install. Sign in with `demo` / `demo123demo123`.

## Features

- **Vitals and trends.** Weight, blood pressure, pulse, glucose, body composition, sleep, SpO₂, respiratory rate, mood, and cycle tracking, charted with trends, moving averages, and clinical reference ranges (ESH 2023, ADA 2024) that you can override with the targets your clinician set. Health scores and correlations between your metrics are computed on your server without an AI model.
- **Questionnaires and self-checks.** Optional validated self-checks for mental wellbeing and sleep (WHO-5, PHQ-9, GAD-7 and the Sleep Condition Indicator, in their official wording, with crisis resources when an answer calls for them), grip strength, a pain score from 0 to 10, waist and body measurements, and a longevity lab panel. Each comes from one signal registry, so a new signal reaches charts, correlations, the coach, the FHIR map, and the API together.
- **Allergies, family history, labs and vaccinations.** Allergies and family history are structured records that flow into the doctor report (reactions and notes are encrypted, the substance and condition names are not). Lab values are keyed in or scanned from a printed report: OCR reads the stated values, units, and dates for you to review and confirm before anything is saved. HealthLog transcribes what a report says; it never interprets or diagnoses from it. A vaccination record keeps a lifetime immunization log, doses grouped under the disease they protect against, and prints in the doctor report.
- **Documents.** An opt-in module stores letters, reports, and scans encrypted at rest. PDFs and photos preview inline, Office and text files stay download-only, and nothing a user uploads can execute in the app. One searchable timeline with type, condition, and year filters, drag-and-drop and paste-to-upload, bulk filing, a delete you can undo within 30 days, and per-file and per-account limits the operator sets.
- **Weather and environment.** An environmental module adds weather, daylight, temperature, air quality, and pollen as possible influences (winter darkness and mood, heat and blood pressure), based on a home location you set. It is on by default, and nothing leaves the host until someone sets that location.
- **Devices and integrations.** Withings, WHOOP, Oura, Polar and Strava sync over OAuth2, Garmin through a Personal API key, Google Health connects Fitbit and Pixel Watch through your own Google Cloud client, Nightscout streams CGM glucose, an Apple Health `export.zip` or a Health Connect export folds your full history in, and the native iOS app streams HealthKit live. A per-metric source priority decides which reading is canonical when wearables overlap.
- **Medications.** Flexible schedules (weekly injections, weekday-only, intervals, PRN, cyclic), a configurable intake window per dose, and a dose history where every slot reads taken, late, skipped, or missed. The compliance rate is computed from the same ledger, so the percentage always matches the timeline.
- **AI features (optional).** A daily briefing and a conversational coach grounded in your own measurements and read against cited guideline reference bands: where a value sits and what that means, never a diagnosis. The coach proposes concrete if-then plans you accept or decline, and skips a proactive check-in when there is nothing new to say. Bring your own OpenAI or Anthropic key, or point at a local endpoint (Ollama, LM Studio, vLLM) so AI requests stay on your network.
- **Doctor report and FHIR.** A doctor-report PDF rendered on your server, a read-only HL7 FHIR R4 API, and scoped, time-limited share links you revoke after the visit.
- **Encryption and privacy.** AES-256-GCM encryption at rest for notes and other free text, documents, questionnaire answers, AI-written text and credentials, with zero-downtime key rotation. Measurement values, lab values, medication names and mood scores are stored unencrypted in the database, so the database volume and its backups need the same protection as the host. Passkey login, server-side sessions, strict CSP, and no third-party tracking anywhere.
- **PWA, reminders and languages.** Installable PWA that keeps the open page readable when the connection drops, reminders over APNs, Telegram, ntfy, Web Push, email and a webhook, and a dashboard that stays fast on years of imported history. The app is available in English, German, Spanish, French, Italian, Polish, Korean, Dutch, Brazilian Portuguese and Russian.

The full feature tour, integration guides, and API reference live at [docs.healthlog.dev](https://docs.healthlog.dev).

## Quick start (Docker Compose)

```bash
git clone https://github.com/MBombeck/HealthLog.git && cd HealthLog
cp .env.example .env

# Generate the three secrets (each a 64-char hex string = 32 bytes):
echo "POSTGRES_PASSWORD=$(openssl rand -hex 32)" >> .env
echo "ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env
echo "API_TOKEN_HMAC_KEY=$(openssl rand -hex 32)" >> .env

# Required on a LAN or plain-HTTP host (NAS, homelab, Tailscale), or login fails:
echo "SESSION_COOKIE_SECURE=false" >> .env

docker compose up -d
```

Open **http://localhost:3000** (or `http://<host>:3000`). The first registered user becomes admin. The compose file pulls a pre-built multi-arch image (`amd64` + `arm64`) from [GHCR](https://github.com/MBombeck/HealthLog/pkgs/container/healthlog); no build step required.

Verify the running version:

```bash
curl -s http://localhost:3000/api/version   # returns version + buildSha + builtAt
```

`SESSION_COOKIE_SECURE=false` is the one setting plain-HTTP self-hosts must set: without it the session cookie carries the `Secure` flag, the browser drops it over HTTP, and login silently fails. Leave it unset (or `true`) only when a TLS reverse proxy serves HTTPS, and in that case set `NEXT_PUBLIC_APP_URL` and `APP_URL` to the public URL first (see the [self-hosting guide](https://docs.healthlog.dev/getting-started/self-host-in-10-minutes/)).

Persistent state lives in the database volume (`postgres-data`) and in `backups`, which holds the nightly database dumps; the app container is stateless. An install from v1.45 or earlier moves its Postgres 16 database from `pgdata` into the new volume on the first start ([details](docs/ops/postgres-major-upgrade.md)); recovering a lost server is in [disaster-recovery.md](docs/ops/disaster-recovery.md).

NAS and homelab users have ready-made paths: [Unraid Community Applications](docs/self-hosting/unraid.md), [Portainer app templates](docs/self-hosting/portainer/README.md) and [TrueNAS](docs/self-hosting/truenas.md) (the Community train app is pending catalog review).

## Self-hosting

One container hosts both the web server and the job worker by default; split them via `HEALTHLOG_PROCESS_TYPE=web|worker` for horizontal scale. Encrypted nightly backups to any S3-compatible bucket are opt-in through five `BACKUP_*` environment variables (the admin panel shows their status), new users join by invite link or QR code, and the stack works out of the box behind Caddy, Traefik, Nginx, or [Coolify](https://coolify.io/).

HealthLog ships often. Pin a tag, back up before upgrades, and read the [release notes](https://github.com/MBombeck/HealthLog/releases) before pulling `latest`. The operator manual (reverse proxy, migrations, encryption-key rotation, backup and restore) lives at [docs.healthlog.dev](https://docs.healthlog.dev).

## Native iOS app

A SwiftUI companion on the [App Store](https://apps.apple.com/app/id6769501341), built on the same API as the web client: live HealthKit two-way sync, medication reminders with action buttons that work without opening the app, and an on-device coach on Apple-Intelligence-capable iPhones. Code lives in [MBombeck/healthlog-iOS](https://github.com/MBombeck/healthlog-iOS).

The App Store listing carries a small price, which exists to cover Apple's yearly developer fee rather than to earn anything; write to marc@healthlog.dev for a free code if that price is in your way. [TestFlight](https://testflight.apple.com/join/bucuTBpa) stays free and carries the newest builds, and the source builds on your own machine.

## Tech stack

Next.js 16 (App Router, React Server Components), TypeScript strict, PostgreSQL 18 with Prisma, pg-boss for jobs, Tailwind CSS 4 + shadcn/ui, Recharts, WebAuthn passkeys, Vitest + Playwright, multi-stage Docker image on the official Node 22 Debian slim base. The OpenAPI 3.1 contract for native clients is generated from the Zod schemas at [`docs/api/openapi.yaml`](docs/api/openapi.yaml).

## Documentation

|                        |                                                                 |
| ---------------------- | --------------------------------------------------------------- |
| User and operator docs | [docs.healthlog.dev](https://docs.healthlog.dev)                |
| Release history        | [Release notes](https://github.com/MBombeck/HealthLog/releases) |
| API contract           | [`docs/api/openapi.yaml`](docs/api/openapi.yaml)                |
| Security policy        | [SECURITY.md](SECURITY.md)                                      |
| Contributing           | [CONTRIBUTING.md](CONTRIBUTING.md)                              |
| Translating            | [CONTRIBUTING.md#translations](CONTRIBUTING.md#translations)    |

## Status

Actively developed, with frequent releases. Issue reports and pull requests are welcome. Behaviour and schema can change between versions; migrations are forward-only.

## Thanks

HealthLog started as something I built for myself. That it has turned into a project other people use, care about and help shape still surprises me, and I am grateful for every part of it.

Thank you to everyone who sent code that shipped: [@TimonBed](https://github.com/TimonBed), [@Antiheld86](https://github.com/Antiheld86), [@BernhardBuckel](https://github.com/BernhardBuckel), [@balajiv113](https://github.com/balajiv113), [@aucun6352](https://github.com/aucun6352), [@mathewcsims](https://github.com/mathewcsims) and [@muhdusama](https://github.com/muhdusama).

Thank you to everyone who opened an issue, asked a question in the discussions or wrote me an email, and especially to [@lutzkind](https://github.com/lutzkind), [@HercoGC](https://github.com/HercoGC), [@mills1975](https://github.com/mills1975), [@sreeramachandramurthy](https://github.com/sreeramachandramurthy), [@CritLoren](https://github.com/CritLoren), [@mbreitkreuz](https://github.com/mbreitkreuz), [@k-nacion](https://github.com/k-nacion), [@NebuPookins](https://github.com/NebuPookins), [@Nazza01](https://github.com/Nazza01), [@Cnote43](https://github.com/Cnote43) and [@juliaanvaneijndt](https://github.com/juliaanvaneijndt), whose reports shaped HealthLog again and again. Most of what got better in the last months started with someone describing what went wrong for them, often with a log, a screenshot and a second try when the first fix was not enough.

And thank you to everyone who supported the project with a coffee or by buying the iPhone app. I don't name anyone here, but I read every message that comes with it. It pays for the servers and the Apple developer account, and it tells me that HealthLog is worth the evenings.

<a href="https://github.com/MBombeck/HealthLog/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=MBombeck/HealthLog" alt="Contributors to HealthLog" />
</a>

Every merged pull request keeps its author's name on the commit, so the
[contributor graph](https://github.com/MBombeck/HealthLog/graphs/contributors)
is the full list. Release notes name the people whose work is in that release,
including anyone who found the defect without sending the fix.

## License

HealthLog is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE): free to use, self-host, and modify for noncommercial purposes. Commercial use requires a separate agreement; open an issue or reach out via [healthlog.dev](https://healthlog.dev). Releases up to and including v1.15.18 were published under AGPL-3.0 and remain available under that license.

---

<p align="center">
  <a href="https://healthlog.dev">healthlog.dev</a> |
  <a href="https://demo.healthlog.dev">Live Demo</a> |
  <a href="https://docs.healthlog.dev">Docs</a> |
  <a href="https://apps.apple.com/app/id6769501341">iOS App Store</a> |
  <a href="https://testflight.apple.com/join/bucuTBpa">iOS TestFlight</a> |
  <a href="https://github.com/sponsors/MBombeck">GitHub Sponsors</a> |
  <a href="https://buymeacoffee.com/mbombeck">Buy Me a Coffee</a>
</p>
