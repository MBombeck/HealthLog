# Phase W-IOS-COORD — v1.4.41 iOS coordination closure

## Goal
Close remaining iOS coordination items from `.planning/v05x-marathon/SERVER-BACKLOG.md`: SB-7 follow-up (`/api/auth/check-user`), SB-8 (dashboard layout merge-semantics doc), SB-9 (streak deprecation decision), and the recurring v1.4.40 `PUT /api/dashboard/widgets` 422 drift.

## Deliverables

| Item | Artefact | Decision |
| --- | --- | --- |
| SB-7 follow-up | `src/app/api/auth/check-user/route.ts` + 5-branch test pin | **Implemented.** Four-branch discovery endpoint per iOS spec. |
| SB-8 | `.planning/sb-8-dashboard-layout-merge-semantics.md` | **Investigation-only — no code change.** Merge is append-only resolver; new widgets ship migration-free. |
| SB-9 | `.planning/sb-9-streak-deprecation.md` | **Already retired.** No `/api/streak/*` surface exists in this codebase. |
| 422 drift | This report (root-cause section below) | **No server fix viable — iOS-side payload bug.** |

## Files touched

| File | Status | Commit |
| --- | --- | --- |
| `src/app/api/auth/check-user/route.ts` | NEW | `feat(auth-check-user): four-branch discovery endpoint for iOS onboarding` |
| `src/__tests__/api/auth/check-user/route.test.ts` | NEW | (same) |
| `.planning/sb-8-dashboard-layout-merge-semantics.md` | NEW | `docs(dashboard-layout): document merge semantics for SB-8 audit gap` |
| `.planning/sb-9-streak-deprecation.md` | NEW | `chore(streak): formalise deprecation status per SB-9` |

No existing source files modified — additive only.

## SB-7 — four-branch contract

`POST /api/auth/check-user` with body `{ identifier: string }` (username or email, case-insensitive). Returns `{ branch, hasPasskey, hasPassword }` where `branch` is one of:

- `not_found` — no account; show sign-up screen.
- `passkey_only` — account exists, ≥1 passkey, no password hash. Show "Sign in with Passkey".
- `email_fallback` — account has a password hash (with or without a passkey). Show password field plus optional "Use Passkey" button when `hasPasskey === true`.
- `exists` — account has neither passkey nor password. Recovery path; show "Reset access".

`hasPasskey` and `hasPassword` are also returned so the iOS client can render both affordances when applicable without a second round-trip.

Tests: 5 cases (all four branches + `422 identifier required`). All pass.

The endpoint deliberately mirrors the existing `/api/auth/registration-status` envelope shape (`{ data, error, meta? }`) and the existing PII posture of `/api/auth/passkey/login-options` — both already disclose account-existence by identifier, so this route adds no new enumeration surface.

## SB-8 — dashboard layout merge semantics

See `.planning/sb-8-dashboard-layout-merge-semantics.md`. Key finding: the resolver in `src/lib/dashboard-layout.ts` is **append-only** on read — new widget ids added to `DASHBOARD_WIDGET_IDS` automatically appear for every existing user on next GET, with `visible` / `tileVisible` / `order` taken from `DEFAULT_DASHBOARD_LAYOUT`. **No database migration is ever required** when introducing a new widget. The anti-pattern of writing a one-shot SQL migration to overlay tile-visibility is explicitly called out — it would clobber every user's customisation.

The PUT route already preserves `chartOverlayPrefs` when omitted (lines 137–151 in `src/app/api/dashboard/widgets/route.ts`); `comparisonBaseline` is NOT preserved-on-omit and is documented as a known limitation. No code change made.

## SB-9 — streak deprecation

`ls src/app/api/streak` → `No such file or directory`. No web frontend code paths reference `/api/streak/...`. The only `streak` references in the API tree are computed fields inside `src/app/api/insights/targets/route.ts` (`streakDays`, `streakHighlight`) — those are derived attributes on an unrelated payload, not a standalone route family.

**Decision:** nothing to deprecate. The route family either never existed on this server or was removed before the audit. iOS can safely treat `/api/streak/*` as 404; the web app does not depend on it either.

## `/api/dashboard/widgets` 422 root-cause

Live logs from the v1.4.38.1 deploy showed iOS v0.5.4 PUTting this endpoint and receiving 422 twice (`V054-SR-merge-deploy-report.md` line 59). I read the Zod schema (`src/app/api/dashboard/widgets/route.ts:38-96`) carefully against the v1.4.16 / v1.4.18 / v1.4.25 W6 history that already debugged 422 storms on this route:

- `widgetIdEnum` is **derived from** `DASHBOARD_WIDGET_IDS` (lines 17-45 of `dashboard-layout.ts`). The set currently includes 16 ids — `weight`, `bp`, `pulse`, `bodyFat`, `mood`, `medications`, `sleep`, `steps`, `glucose`, `totalBodyWater`, `boneMass`, `bpInTarget`, `oxygenSaturation`, `achievements`, `vo2Max`, `recentWorkouts`. Any iOS payload with a widget id outside this set 422s.
- `chartOverlayPrefs` is `z.partialRecord(z.enum(CHART_OVERLAY_KEYS), …)` — partial; missing keys are OK. The v1.4.25 W6 fix already addressed the strict-record regression.
- `widgets[]` is bounded `.min(1).max(20)` — iOS sending an empty or oversize array would 422.
- The `comparisonBaseline` enum (`none | lastMonth | lastYear`) is strict — an unknown value 422s.
- Each widget object requires `order` ∈ `[0, 99]` integer; a float or out-of-range value 422s.

The Zod validator is **correct and additive-safe** — every back-compat lever it can pull (optional `tileVisible`, optional `comparisonBaseline`, partial `chartOverlayPrefs`) is already in place. The 422 is therefore an iOS-side payload bug, NOT a server-side validator gap. Most likely candidates given the iOS v0.5.4 release notes:

1. iOS is sending a widget id the server does not know (e.g. `glp1`, which the iOS team did add as a tile in v0.5.4 but is not in `DASHBOARD_WIDGET_IDS`).
2. iOS is sending `order: <float>` or `order: 100+` (e.g. `Date.now()`-derived ordering).
3. iOS is omitting one of the required `widgets[].id | visible | order` fields.

**Server action:** none. The validator is correct. **iOS action required:** confirm the payload shape against the contract in `.planning/v15-ios-handoff/03-api-contracts.md` §`GET/PUT /api/dashboard/widgets` and `DASHBOARD_WIDGET_IDS`. The 422 response body (`{ data: null, error: <Zod issue message> }`) already names the offending path; iOS should surface this in their dev console.

The route also returns 422 on a **single** issue (`parsed.error.issues[0].message`), which can be unhelpful when multiple fields are wrong. That is a separate "diagnostic improvement" backlog item — not the cause of the iOS 422s and out-of-scope for this wave.

## Quality gates

- `pnpm vitest run src/__tests__/api/auth/check-user/` → 5/5 passing.
- `pnpm tsc --noEmit` — no new errors introduced by check-user route. Existing pre-existing errors in `summaries-slice.test.ts` and `measurement-read-wmy.test.ts` are unrelated to this wave.
- No source files outside the authorised set touched.

## Commits

Planned commit sequence:

1. `feat(auth-check-user): four-branch discovery endpoint for iOS onboarding` — route + tests.
2. `docs(dashboard-layout): document merge semantics for SB-8 audit gap` — `.planning/sb-8-…md`.
3. `chore(streak): formalise deprecation status per SB-9` — `.planning/sb-9-…md`.
4. (this report) `docs(planning): W-IOS-COORD v1.4.41 closure report` — `.planning/phase-W-IOS-COORD-v1441-report.md`.

No `fix(dashboard-widgets): …` commit — the server-side validator is correct; no change needed.
