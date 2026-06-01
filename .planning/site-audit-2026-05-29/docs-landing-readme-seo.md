# Public-surface audit — docs, landing, README, SEO (2026-05-29)

Worklist for a follow-up engineer. Research only; nothing here was edited.
Scope: `healthlog-docs` (Astro Starlight, branch `docs/apns-pinning-selfhost`),
`healthlog-landing` (Next.js, main), `HealthLog/README.md`.

Ground truth used: `CLAUDE.md` "What HealthLog is" + `CHANGELOG.md` through v1.5.6.
Current app line: **v1.5.6**. Native iOS client: **v0.8.x** public beta via TestFlight.

Voice/content rules enforced below: English, factual maintainer voice, no
AI/agent/marathon vocabulary, no personal names / health figures, every claim
verifiable.

---

## CROSS-CUTTING: the single biggest gap

**The native iOS client + Apple HealthKit live two-way sync is the app's headline
strength and it is almost invisible on the two marketing surfaces.**

- README covers it well (full "Native iOS client" section, TestFlight badge).
- **Landing page (`page.tsx`): zero iOS section, zero TestFlight link, zero iOS
  screenshots.** The hero says "offline-capable, open source" and never mentions
  the phone. This is the #1 fix.
- **Docs: no dedicated iOS page.** iOS is mentioned in passing inside
  `api/native-clients`, `apple-health`, `notifications`, but a self-hoster
  cannot find a "Install the iOS app / what it does / HealthKit sync" page.

Treat the three P1 iOS items below as the top of the worklist.

---

## SCREENSHOT INVENTORY (`.planning/screenshots-2026-05-29/`)

Map of the 11 PNGs to where each belongs. Two are duplicates; one is NOT usable.

| File | Content | Use |
|---|---|---|
| `dashboard.png` | Dashboard top: metric tiles (Weight/BP/pulse/mood) + Weight & BMI charts | **Replace** `landing/public/screenshots/desktop-dashboard-opt.webp`. Cleanest of the dashboard set (no browser chrome). |
| `Bildschirmfoto…22.04.12 (2).png` | Same dashboard top, slightly different crop | Backup of `dashboard.png`; pick one. |
| `1.png` | Dashboard lower charts: Medications heatline + Sleep + Steps | New landing showcase tab "Trends", or docs `features/health-metrics` hero. Has full browser chrome — crop it. |
| `Bildschirmfoto…22.04.06.png` | Same lower charts, no chrome | Preferred version of `1.png` — use this, drop `1.png`. |
| `Bildschirmfoto…22.04.12.png` | Measurements list table (clean, no chrome) | **Replace** `desktop-measurements-opt.webp`. |
| `Bildschirmfoto…22.04.25.png` | Same measurements list, full browser chrome | Duplicate of above; skip. |
| `Bildschirmfoto…22.04.37.png` | Medications page: 4 compliance cards (7-day / 30-day rings, next-intake) | **Replace** `desktop-medications-opt.webp`. Strong shot — shows compliance + GLP-1. |
| `Bildschirmfoto…22.04.56.png` | Achievements / gamification grid | New docs image for `features/gamification` + `features/achievements-hidden`. Optional landing "59 achievements" proof shot. |
| `Bildschirmfoto…22.05.19.png` | Admin console / Administration overview | Docs `configuration/admin-settings` + `admin/backups` hero. NOT for landing (too operator-facing). |
| `Bildschirmfoto…22.03.55 (2).png` | **A developer terminal (typecheck/lint/git output) — NOT app UI** | **DO NOT publish anywhere.** Contains local paths + commit subject lines referencing internal terms. Exclude. |

Action: optimise the chosen PNGs to `.webp` (the showcase already serves webp;
landing `next.config.ts` sets `images.unoptimized: true` because of static export,
so pre-compress them). Strip browser chrome from any with a visible URL bar — the
demo URL `demo.healthlog.dev` shows in several; the showcase frame already renders
its own fake `health.myserver.com` chrome, so feed it chrome-less captures.

---

## REPO 1 — LANDING (`/Users/marc/Projects/healthlog-landing`)

### P1 — Add a native-iOS / HealthKit section
- **File:** `src/app/page.tsx`
- **Wrong:** No iOS presence at all. The phone + live HealthKit sync is the
  differentiator vs. "yet another self-hosted tracker"; the page never says it.
- **Change:** Add a new `<section id="ios">` between AI Coach and Features.
  Headline e.g. "Your iPhone writes straight to your server." Body (verifiable
  against README + CHANGELOG): live two-way Apple Health sync (HealthKit), local
  medication reminders with action buttons, passkey/Face ID sign-in, on-device AI
  Coach on iOS 26+, doctor-report export. Add a real CTA to
  `https://testflight.apple.com/join/bucuTBpa` and a link to the iOS repo. Pull
  the four iOS screenshots that already ship in the main repo at
  `HealthLog/docs/ios/ios-*.png` (dashboard, insights, medication-detail,
  mood-entry) into a phone-frame strip. Do NOT mention "Stanford Spezi" framework
  internals on the marketing page — keep that in the README/docs.

### P1 — Refresh the AppShowcase screenshots
- **File:** `src/components/AppShowcase.tsx` (+ `public/screenshots/`)
- **Wrong:** Three webp screenshots, undated; the new captures are sharper and
  current (v1.5.x dashboard tiles + medication compliance rings + measurements
  source badges).
- **Change:** Replace the three webp files with the mapped captures above. Add a
  fourth tab "Medications" is present, but consider adding "Trends" (the
  Sleep/Steps/Medication-heatline shot, `22.04.06`). Update `alt` text to mention
  Withings + Apple Health source badges (visible in the new measurements shot) for
  SEO. Keep `object-cover object-top` framing.

### P1 — Fix stale structured-data version
- **File:** `src/app/layout.tsx` line ~162
- **Wrong:** `softwareVersion: "1.4.32"` — app is on **1.5.6**.
- **Change:** Bump to `1.5.6`. Add a code comment that this tracks the server
  release and must bump on each release (it already has a comment; keep it).

### P1 — Hero + meta does not surface iOS / Apple Health
- **Files:** `src/app/page.tsx` (hero `<p>`), `src/app/layout.tsx` (title,
  description, keywords, OG, JSON-LD featureList).
- **Wrong:** Hero subhead lists "Weight, blood pressure, medications, mood …
  Offline-capable. Open source." — omits the two strongest SEO/marketing hooks:
  **native iOS app** and **Apple Health sync**. Meta `description` and `keywords`
  omit "Apple Health", "HealthKit", "iOS app", "blood glucose", "AI Coach".
- **Change:**
  - Hero subhead: add a clause "Syncs live with Apple Health on iOS, or Withings
    on any device."
  - `metadata.description`: rewrite to e.g. "Self-hosted, open-source health
    tracker. Native iOS app with live Apple Health (HealthKit) sync, Withings
    device sync, multi-provider AI insights, and a client-side doctor-report PDF.
    AES-256-GCM encrypted. Docker deploy in minutes."
  - `metadata.keywords`: add `apple health sync`, `healthkit self-hosted`,
    `ios health app open source`, `blood glucose tracker`, `ai health insights`,
    `withings self-hosted`, `doctor report pdf`.
  - JSON-LD `featureList`: add "Native SwiftUI iOS app with live Apple Health
    (HealthKit) two-way sync" as the first entry.

### P2 — `sitemap.xml` is stale and incomplete
- **File:** `public/sitemap.xml`
- **Wrong:** Only lists `/` with `lastmod 2026-03-08`; omits `/privacy` and
  `/support` which are indexable (`robots: index` set on both). Date is 11 weeks old.
- **Change:** Add `/privacy` and `/support` entries; bump `lastmod` on `/` to the
  deploy date. Static export, so either hand-edit or generate at build.

### P2 — Comparison table omits the iOS/Withings/Apple-Health strengths
- **File:** `src/app/page.tsx` (Comparison section)
- **Wrong:** Rows don't include the differentiators the README table has
  ("Apple Health import", "Withings device sync", "Doctor-report PDF", "native
  client"). The landing table compares only generic axes.
- **Change:** Add rows: "Native iOS app" (HealthLog: Yes — public beta), "Apple
  Health sync" (HealthLog: Two-way / others: their own silo), "Withings sync",
  "Doctor-report PDF". Mirror the README comparison so the two surfaces agree.

### P2 — JSON-LD: add `SoftwareApplication` iOS + breadcrumb/FAQ richness
- **File:** `src/app/layout.tsx`
- **Change:** Consider a second `SoftwareApplication` node (or `operatingSystem:
  "iOS, Web, Docker"`) so the iOS app is eligible for rich results. Optionally add
  a small `FAQPage` JSON-LD with 3–4 real Q&As ("Is HealthLog free?", "Does it
  sync with Apple Health?", "Where is my data stored?") — strong for SEO snippets
  and all answerable truthfully.

### P3 — `og-image.png` likely predates v1.5 UI
- **File:** `public/og-image.png` (referenced by OG + Twitter + JSON-LD screenshot)
- **Change:** Regenerate from the new `dashboard.png` so social cards show current
  UI. Verify it's 1200×630.

### P3 — Tech-stack marquee names a specific AI vendor
- **File:** `src/app/page.tsx` `techItems` lists "OpenAI API".
- **Change:** Fine to keep, but consider "AI: OpenAI / Anthropic / local" to match
  the multi-provider story the AI Coach section tells. Minor.

---

## REPO 2 — DOCS (`/Users/marc/Projects/healthlog-docs`)

Note: branch `docs/apns-pinning-selfhost` adds TLS-certs, cert-pinning, APNs push
pages — legitimate, leave them.

### P1 — No `@astrojs/sitemap`; no sitemap.xml shipped
- **Files:** `astro.config.mjs`, `package.json`
- **Wrong:** Starlight does not emit a sitemap without the integration. A docs site
  this size (60+ pages) with no sitemap is a real SEO loss.
- **Change:** `pnpm add @astrojs/sitemap`, import and add to `integrations` in
  `astro.config.mjs` (it auto-uses the configured `site`). Confirm `robots.txt`
  (add one under `public/` pointing at `/sitemap-index.xml`).

### P1 — No dedicated iOS app page in docs
- **Files:** new `src/content/docs/getting-started/ios-app.mdx` (or under a new
  "iOS App" sidebar group), `astro.config.mjs` sidebar.
- **Wrong:** iOS is only referenced obliquely. A self-hoster who connects the
  native app has no install/feature/troubleshooting page.
- **Change:** Add a page covering: TestFlight join link, iOS 18+ requirement (26+
  for on-device Coach), how the app pairs with a self-hosted instance (server URL +
  passkey/refresh-token), HealthKit permission flow, what syncs live, local
  medication reminders, and a pointer to the iOS repo + iOS CHANGELOG. Cite the
  `api/native-clients` page for the wire contract. Add to sidebar.

### P2 — `features/health-metrics.mdx` has zero explanatory external links
- **File:** `src/content/docs/features/health-metrics.mdx`
- **Wrong:** This is the most clinical page (ESH 2023, ADA 2024, NICE NG115, SpO₂,
  body composition) and carries no outbound references. Only 3 docs files use any
  external link.
- **Change:** Add helpful explanatory links the first time each term appears:
  Wikipedia for [blood pressure](https://en.wikipedia.org/wiki/Blood_pressure),
  [body mass index](https://en.wikipedia.org/wiki/Body_mass_index),
  [pulse oximetry](https://en.wikipedia.org/wiki/Pulse_oximetry),
  [blood glucose](https://en.wikipedia.org/wiki/Blood_sugar_level),
  [body composition](https://en.wikipedia.org/wiki/Body_composition); and link the
  actual guideline bodies (ESH, ADA, NICE) to their canonical pages. Keeps the
  page factual and helps SEO entity association. Apply the same lightly to
  `insights/how-it-works` and `features/ai-insights`.

### P2 — Introduction "Key Features" out of date / understated on iOS
- **File:** `src/content/docs/getting-started/introduction.mdx`
- **Wrong:** Feature bullets don't list the **native iOS app** at all; "Native API
  Clients" bullet mentions iOS only as a consumer. Achievements say "59" (verify
  against current count — README says "30+", landing says "59"; pick the true
  number and unify across all three surfaces).
- **Change:** Add an "iOS App" bullet linking the new iOS page. Reconcile the
  achievement count (CHANGELOG/code is the source — confirm before publishing; do
  not ship two different numbers).

### P2 — Add screenshots to feature docs
- **Files:** `features/medications.mdx`, `features/gamification.mdx`,
  `features/health-metrics.mdx`, `configuration/admin-settings.mdx`,
  `admin/backups.mdx`
- **Wrong:** Feature pages are text-heavy with no UI imagery (spot-check shows no
  image embeds in health-metrics).
- **Change:** Drop the mapped captures in: medications card grid → medications doc;
  achievements grid → gamification doc; measurements/dashboard → health-metrics;
  admin overview → admin-settings/backups. Store under `src/assets/` and embed with
  Starlight's image handling for optimisation.

### P3 — No custom OG/Twitter meta per page
- **Files:** `astro.config.mjs` (Starlight `head`), or a custom `Head` override
- **Wrong:** Pages have good `description` frontmatter (all MDX have one — verified)
  but no site-wide OG image / Twitter card. Shared docs links render bare.
- **Change:** Add a `head` entry in the Starlight config injecting a default
  `og:image` (reuse the landing OG image), `og:site_name`, and `twitter:card`.
  Starlight already emits `<title>`/`<meta description>` from frontmatter.

### P3 — Sidebar ordering buries strengths
- **File:** `astro.config.mjs` sidebar
- **Change:** Minor — "Integrations" (Apple Health / Withings / AI) sits below
  "Features"; consider surfacing Apple Health higher. Add the new iOS page near
  Getting Started. Low priority.

---

## REPO 3 — README (`/Users/marc/Projects/HealthLog/README.md`)

The README is strong and current. Findings are targeted.

### P1 — API Reference table drift vs. shipped routes
- **File:** `README.md` lines ~278–418
- **Wrong / unverifiable claims to reconcile against code:**
  - `GET /api/auth/me` description says "Current user profile + **Gravatar URL**" —
    **Gravatar was removed in v1.5.5** (self-hosted avatar at `/api/user/avatar`;
    `src/lib/gravatar.ts` retired). The privacy-positive change (Automattic no
    longer sees the email hash) is a *selling point* that's now mis-stated as the
    opposite. Fix: change to "+ avatarUrl (self-hosted)" and add an Avatar row.
  - Medications table lists `GET /api/medications/:id/compliance` — verify; v1.5.x
    uses `/cadence` and `/intake` routes. Add `POST /api/medications/extract`
    (NL extraction, shipped v1.5.3) and `/api/medications/{id}/intake/bulk-delete`
    (v1.5.5) and `/api/insights/layout` (v1.5.5) which are all live but absent.
  - Confirm `/api/analytics` "7d/30d" still matches (rollup tier changed shapes).
- **Change:** Do a pass diffing the README API tables against `docs/api/openapi.yaml`
  (the source of truth) and fix every drift. The OpenAPI file is CI-gated so it's
  authoritative.

### P2 — Avatar / Gravatar privacy story
- **File:** `README.md` "Security and Privacy" section + API table.
- **Wrong:** Misses a genuine v1.5.5 privacy win.
- **Change:** Add a bullet under Security: "Self-hosted avatars — profile images
  store as BYTEA on your own DB; no third-party (Gravatar) email-hash leak."

### P2 — Achievement count inconsistency
- **File:** `README.md` says "30+ persistent achievements" (line ~99); landing says
  "59 Achievements"; docs say "59".
- **Change:** Pick the verified number and unify across README + landing + docs.

### P2 — Local Development prereq says "Node.js 20+"
- **File:** `README.md` line ~440
- **Wrong:** `CLAUDE.md` pins Node 22 (Alpine) via Dockerfile. 20 may still work but
  the stated floor disagrees with the shipped runtime.
- **Change:** Align to "Node.js 22" to match the build image.

### P2 — pnpm version drift
- **File:** README Tech Stack / Local Dev. `CLAUDE.md` references pnpm 10.31.
  README doesn't pin pnpm; fine, but if it does elsewhere, keep consistent. Low.

### P3 — Repo topics / GitHub "About" (SEO)
- **Not a file** — GitHub repo settings. The repo description + topics drive GitHub
  search and Google.
- **Change (suggest to maintainer):**
  - Description: "Self-hosted, open-source health tracker — native iOS app with live
    Apple Health (HealthKit) sync, Withings, multi-provider AI insights, doctor PDF.
    Docker, AES-256-GCM, PWA."
  - Topics: `self-hosted`, `health-tracking`, `pwa`, `nextjs`, `typescript`,
    `apple-health`, `healthkit`, `withings`, `medication-tracker`,
    `blood-pressure`, `glucose`, `privacy`, `docker`, `ios`, `swiftui`,
    `ai-insights`, `postgresql`, `prisma`, `agpl`.

### P3 — Roadmap "v1.4.x / v1.5 (current)" framing
- **File:** `README.md` Roadmap table.
- **Wrong:** Mildly stale — v1.5 is mid-line (1.5.6 shipped), medication scheduling
  + detail page landed. "current" is fine but the v1.5 row only mentions iOS.
- **Change:** Note medication scheduling (RRULE / rolling / one-shot) + the
  medication detail page as v1.5 web work alongside iOS.

---

## SEO — keyword / topic strategy (concrete)

**Primary entity:** "self-hosted health tracker" (own this; low competition,
high intent). **Secondary high-value, currently under-targeted:**
- "self-hosted Apple Health" / "HealthKit self-hosted" — strong, near-zero
  competition, matches the real differentiator. Target on landing + new docs iOS
  page + Apple Health docs page.
- "open source health app iOS" / "private health app self hosted".
- "Withings self-hosted" / "Withings open source".
- "doctor report PDF self hosted" / "medication compliance tracker self hosted".
- "AI health insights privacy" / "local LLM health" (Ollama angle).

**Per-surface application:**
- Landing meta/title/keywords: add Apple Health, HealthKit, iOS app, blood glucose,
  AI Coach (P1 above).
- Docs: ship a sitemap (P1), add the iOS page (captures the HealthKit query), add
  explanatory external links (entity association), per-page OG.
- README: topics + description (P3) — GitHub ranks well for these terms.

**Cross-surface consistency to fix (search dilution):** achievement count, version
number (landing JSON-LD 1.4.32 → 1.5.6), Gravatar→avatar, Node 20→22. Same facts
must read identically on README, landing, and docs.

---

## Quick priority rollup

- **P1:** landing iOS section; landing screenshot refresh + iOS shots; landing
  JSON-LD version 1.4.32→1.5.6; landing hero/meta add iOS+Apple Health; docs
  sitemap integration; docs iOS page; README API-table drift (Gravatar etc.).
- **P2:** landing sitemap.xml; landing comparison rows; docs external links on
  clinical pages; docs intro iOS bullet + achievement count; docs feature
  screenshots; README avatar privacy bullet; README Node version; achievement-count
  unification.
- **P3:** og-image regen; landing FAQ JSON-LD; docs per-page OG; docs sidebar
  reorder; README topics/description; README roadmap refresh.
- **DO NOT publish:** `Bildschirmfoto…22.03.55 (2).png` (developer terminal).
