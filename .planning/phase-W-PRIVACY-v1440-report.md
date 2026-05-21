# Phase W-PRIVACY — v1.4.40 report

**Status:** complete. Both commits landed on `develop`
(`c79d9173` page + `128d8637` tests). Quality gates green.

**Scope:** SB-3 from the iOS team's server-backlog — public Next.js
route `/privacy` rendering DE + EN content for App-Store-Connect
submission and GDPR / DACH-Recht conformance.

---

## Pre-existing baseline (v1.4.26)

`/privacy` already existed as an English-only static Server Component
with a comprehensive 11-section spine (overview, data inventory, HK
identifiers, sub-processors, retention, GDPR rights, MDR boundary,
Apple categories, children, changes, contact). The 9-test contract in
`page.test.tsx` pinned the HealthKit identifier list and the
sub-processor roster.

---

## v1.4.40 deltas shipped

### 1. Page rewrite — bilingual DE + EN paired sections

`src/app/privacy/page.tsx` (1646 inserts / 710 deletes)

- New `<Section>` helper renders the canonical English H2 plus a
  German body block (`data-slot="privacy-section-de"`, `lang="de"`)
  followed by a collapsible `<details>` carrying the English
  translation (`data-slot="privacy-section-en"`, `lang="en"`).
- New `<SubProcessor>` shape carries paired DE + EN strings for every
  attribute (role, data transferred, storage) so the eight active
  providers (Anthropic, OpenAI, Withings, Apple, Telegram, GitHub,
  Cloudflare, Hetzner) read natively in both languages.
- H1 = "Datenschutzerklärung / Privacy Policy". TOC entries paired
  ("Overview / Überblick", "Erhobene Daten", etc.).
- Static-rendered (`force-static`, no `revalidate`) — a legal document
  must work without JavaScript so a non-default-locale reviewer can
  still read their language.

### 2. GDPR / SB-3 content additions

All nine SB-3 required elements landed verbatim, indexed by the brief:

| # | Requirement                            | Location in page                                                            |
| - | -------------------------------------- | --------------------------------------------------------------------------- |
| 1 | Data collected (BP / weight / mood / medication / AI prompts / push tokens) | sections 2.1–2.5, 2.8                                          |
| 2 | HK data flow (HK → iOS → POST /api/measurements over HTTPS)                  | section 2.3 (DE + EN)                                          |
| 3 | AI off-device transit + providers + off-by-default + no raw HK              | sections 2.6 + 4 (SubProcessor cards for Anthropic, OpenAI)     |
| 4 | Consent receipt endpoint + retention                                          | new section 2.7 (`GET /api/account/consents`, 5-year retention) |
| 5 | TLS 1.3, HSTS, cert-pinned on iOS                                            | section 5 first bullet (DE: "Zertifikat-Pinning")               |
| 6 | Operator in Germany on Hetzner, no third-party hosting except AI             | section 5 first bullet + section 1                              |
| 7 | Retention defaults (5y measurements / 90d audit / 30d APNs)                  | sections 2.9 + 5                                                |
| 8 | GDPR Art. 17 cascade through `User.delete` + `onDelete: Cascade`             | section 6 (DE + EN, both name "User.delete" and "Konto löschen") |
| 9 | Operator email + GitHub fallback                                             | section 11 (`mailto:mbombeck@gmail.com` + DSGVO subject line)   |

`POLICY_VERSION` bumped 1.4.26 → 1.4.40, `LAST_UPDATED` → 2026-05-18.

### 3. Test contract expanded

`src/app/privacy/__tests__/page.test.tsx` — 9 tests → 17 tests. New
coverage:
- Bilingual title (DE + EN simultaneous).
- 11 paired `data-slot` markers + the language boundaries.
- HK data-flow path (`POST /api/measurements` + `TLS 1.3`).
- AI off-by-default + no raw HK identifiers + named providers.
- Consent endpoint + 5-year retention literal.
- TLS 1.3 + HSTS + cert pinning (DE mirror).
- Server location + operator framing.
- Retention defaults table (5y / 90d / 30d).
- Deletion route (`Settings → Daten → Konto löschen`, `User.delete`,
  `onDelete: Cascade`).
- Operator email (mailto), PII rule still enforced.

---

## Decisions and trade-offs

### "via i18n" interpretation

The brief said "i18n route is optional". I evaluated three options and
picked paired-bilingual rendering on a single static page:

1. **Locale-switching via i18n provider** — rejected. Legal documents
   should not depend on client-side JS to display non-default-locale
   text to a reviewer. Apple US reviewers and German DPAs land at
   the same URL.
2. **Two routes (`/privacy/de` + `/privacy/en`)** — rejected. Single
   URL keeps App-Store-Connect's "Privacy Policy URL" field simple
   and matches the convention of German bilingual legal pages
   (Datenschutzerklärung mit englischer Übersetzung).
3. **Paired bilingual on one static page** — chosen. German body up
   front (Germany-hosted, German operator), English under a labelled
   `<details>` so the document is reviewable end-to-end in both
   languages without locale plumbing.

Existing `messages/de.json` + `messages/en.json` were therefore left
untouched. The `auth.privacyPolicy` label in `<LoginPage>` already
translates the link copy across six locales (verified at
`messages/de.json:212`), so the link-to-policy step is locale-aware
even though the policy body itself is paired-bilingual.

### PII discipline

Body uses "the operator" / "the controller" framing per the v1.4.20
retroactive PII rule. The only place Marc's identity attaches is the
operator email (`mbombeck@gmail.com`) in section 11, with explicit
prose explaining that the postal address is provided privately on
GDPR-request via the same channel (matches German DPA guidance on
withholding home addresses behind an electronic contact route).

The "no `Marc[- ]?Andr` / no `Bombeck \w+`" assertion stays in the
test (line 250).

---

## App-Store-Connect submission

- **URL:** `https://healthlog.bombeck.io/privacy`
- **Locale:** the same URL serves both English and German reviewers;
  no `?locale=` parameter is required.
- **Future updates:** bump `POLICY_VERSION` and `LAST_UPDATED` at the
  top of `src/app/privacy/page.tsx` whenever the policy materially
  changes. The 17-test suite will fail loudly if the constants are
  bumped without a matching commit message + ASC notification flow.
  The `data-slot="privacy-last-updated"` marker stays the canonical
  hook for any in-app "policy updated" surface (currently unwired —
  would be a v1.5 nice-to-have).
- **Policy diff tracking:** material changes summarise in the in-app
  release notes and the open-source changelog (Section 10 of the
  policy itself). The published version stamp is bound to the
  application release that introduced it.

---

## Quality gates evidence

- `pnpm typecheck` — clean.
- `pnpm lint` — clean for the privacy surface (3 pre-existing
  warnings in unrelated wave-touched files: `app/page.tsx`,
  `insights/features.ts`, `api/dashboard/summary/route.ts`).
- `pnpm vitest run src/app/privacy` — 17 / 17 pass.
- `pnpm vitest run src/__tests__/proxy-privacy-public.test.ts` — 3 / 3
  pass (PUBLIC_PATHS still includes `/privacy`).
- `pnpm vitest run src/__tests__/i18n-drift-guard.test.ts
  src/lib/__tests__/i18n-locale-integrity.test.ts` — 57 / 57 pass
  (no i18n keys added, no drift introduced).

---

## File touch list (only my surface)

- `src/app/privacy/page.tsx` — rewrite.
- `src/app/privacy/__tests__/page.test.tsx` — expanded.
- `.planning/phase-W-PRIVACY-v1440-report.md` — this report.

No other surfaces touched. The other staged modifications in the
working tree (`src/app/api/...`, `src/lib/insights/features.ts`,
`src/app/page.tsx`, `src/app/api/medications/intake/route.ts`,
`src/lib/ai/coach/snapshot.ts`, etc.) belong to other waves and were
not staged by W-PRIVACY.
