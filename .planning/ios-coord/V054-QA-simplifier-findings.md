# V0.5.4 PR #190 — Simplifier QA Findings (READ-ONLY)

Scope: commit `4049c6c7` + version bump `c4f2e0bc` on `main`.
Files in scope: `apns.ts` (+test), `notifications/types.ts`, `mood-reminder.ts` (+test), `reminder-worker.ts` (MOOD_REMINDER block only).

No code modified. All findings below are candidates for a future simplification pass.

---

## Safe simplifications (low risk, behaviour-preserving)

### S1 — Drop redundant `moodReminderEnabled` round-trip in `runMoodReminderTick`
**File**: `src/lib/jobs/mood-reminder.ts:141-159`
The Prisma `findMany` already filters with `where: { moodReminderEnabled: true }`, then `select`s `moodReminderEnabled: true` only to pass it back into `evaluateMoodReminderWindow`, which short-circuits when it's `false` — an impossible branch at this call site.
Proposed shape: drop `moodReminderEnabled` from the `select`, and drop the `moodReminderEnabled` arg from the helper invocation. (The helper itself stays — `evaluateMoodReminderWindow` is also called directly by tests with `moodReminderEnabled: false` to assert the opt-out behaviour.)

### S2 — `evaluateMoodReminderWindow` `localHour: -1` sentinel never observed
**File**: `src/lib/jobs/mood-reminder.ts:79-82`
The opted-out branch returns `localHour: -1` purely to satisfy the return shape. No production caller reads `localHour` (only three test asserts touch it, none from the opted-out branch). Could return `localHour: 0` or just drop `localHour` from that branch's payload — but `0` is the simplest in-place tweak.

### S3 — `MoodReminderCandidate` interface is over-specified for its only use
**File**: `src/lib/jobs/mood-reminder.ts:44-49`
The interface is `Pick<>`-ed exactly once and never used as a whole-type. After applying S1, the `id` + `moodReminderEnabled` fields are dead — the helper only needs `timezone`. The interface can be deleted and the helper can take `{ timezone: string }` inline. The `MoodReminderSummary` interface is fine (it's the orchestrator's return type).

### S4 — `if (!decision.fire || !decision.localDate)` second clause exists only for TS narrowing
**File**: `src/lib/jobs/mood-reminder.ts:161`
Logically `decision.localDate` is non-null iff `decision.fire === true`. The redundant second clause is load-bearing for TypeScript's flow analysis after the `continue`. **Leave as-is** — narrowing without it would force `!` on every later `decision.localDate` read. Listed for completeness.

### S5 — `padStart` chain in `evaluateMoodReminderWindow` re-formats data Intl already 2-digited
**File**: `src/lib/jobs/mood-reminder.ts:85-87`
`getLocalDateParts` parses the values back to `Number` (`year/month/day`), so the helper has to re-pad. A `.toString().padStart(2, "0")` per field is fine, but the whole literal could collapse to a single template-literal helper or use `String(parts.month).padStart(...)`. Cosmetic only.

### S6 — JSDoc on `getProvider` neighbour comment block can drop "Provider lifecycle" prose
**File**: `src/lib/notifications/senders/apns.ts:1-23` (file-header)
Out-of-scope per directive (pre-existing comment, not a new line in this PR). **Skip.**

### S7 — `void jobs;` + try/catch + `recordError()` + rethrow is the established shape
**File**: `src/lib/jobs/reminder-worker.ts:632-660` (new `handleMoodReminderCheck`)
Matches every other handler in the file 1:1. **No simplification — keep.** Noted to confirm pattern consistency.

---

## Worth-considering (judgement call, may regress clarity)

### W1 — `resolveLocale` silently downgrades fr/es/it/pl to default
**File**: `src/lib/jobs/mood-reminder.ts:60-62`
`return locale === "en" || locale === "de" ? locale : defaultLocale;`
The PR added `moodReminders.dailyTitle/dailyBody` to all six locales (`fr.json:2991`, `es.json:2991`, `it.json:2991`, `pl.json:2991`), but this helper only ever resolves to `en` or `de`. fr/es/it/pl translations are dead at runtime. **Borderline behaviour change** — fixing it expands the supported-locale set. Probably the correct fix is `locales.includes(locale as Locale) ? locale as Locale : defaultLocale` to honour the JSON files that already exist. Surfaces because the v1.4.38 i18n wave (commits `d95820ab`/`9bd67564`/`7f490af7`) shipped those strings on purpose. **Flag for Marc — choose: (a) tighten resolver to accept all 6 locales, or (b) delete the unused 4-locale strings to remove the mismatch.**

### W2 — Test setup duplication across 6 `runMoodReminderTick` cases
**File**: `src/lib/jobs/__tests__/mood-reminder.test.ts:186-381`
Every test rebuilds the same `FakePrismaState` shape with one `u-1` candidate, empty `moodEntries`/`dispatches`/`raceUserIds`, plus the `dispatch = vi.fn<DispatchFn>(async () => {})` line. A `beforeEach` returning `{ state, prisma, dispatch }` would cut ~12 lines × 6 tests = ~70 LOC. Trade-off: each test currently reads top-to-bottom without scrolling back to setup, which is the project's preferred style. **Marginal win — defer unless adding more cases.**

### W3 — `MoodReminderCandidate` + `MoodReminderSummary` exports are internal-only
**File**: `src/lib/jobs/mood-reminder.ts:44, 51`
Both interfaces are `export`ed but consumed exclusively inside `mood-reminder.ts` (`MoodReminderSummary` for the orchestrator's return type, used by `reminder-worker.ts`'s `handleMoodReminderCheck`). After S3, `MoodReminderCandidate` is dead and can be deleted. `MoodReminderSummary` stays exported because `reminder-worker.ts` reads its fields (`summary.candidatesScanned` etc.) into the wide-event payload — but the file currently doesn't import the type. Re-checking: `handleMoodReminderCheck` infers the type from the function return, so the export is unused in practice. Could drop `export`, but the cost of leaving it is zero.

### W4 — APNs `category` cast comment is 13 lines for a one-line cast
**File**: `src/lib/notifications/senders/apns.ts:251-266`
The cast `(note as unknown as { category: string }).category = ...` is annotated with a 13-line comment explaining why. Could compress to 2-3 lines ("node-apn 8.1 d.ts omits the public `category` setter; runtime writes through to `aps.category` unchanged"). The detail is valuable when a future engineer upgrades node-apn — keep or trim is a taste call. **Recommend keeping** given Marc's prose-over-brevity preference in the codebase.

### W5 — `category` is set from `payload.eventType` in `sendViaApns`, then `threadId` from the same value
**File**: `src/lib/notifications/senders/apns.ts:398-404`
Three fields (`threadId`, `category`, `collapseId`) all receive `payload.eventType`. Could extract `const eventTypeId = payload.eventType;` to make the "same identifier doubles as three keys" pattern explicit. **Cosmetic.**

### W6 — `[winH, winM] = schedule.windowStart.split(":").map(Number)` lacks NaN guard
**File**: `src/lib/jobs/reminder-worker.ts:584-587`
If `windowStart` is malformed, `scheduledAtIso` becomes `"Invalid Date".toISOString()` → throws. The validation happens upstream on schedule write so it's safe in practice, but a defensive `Number.isFinite(winH * winM)` would prevent a corrupt-row crash. **Out-of-scope for simplification — this is a hardening item, not a simplification.**

---

## Out-of-scope (touched in PR but not the new code)

- `handleWithingsSleepSync` signature was reflowed by Prettier (apns.ts diff `@@ -717`). Not a logic change.
- `handlePrDetection` payload destructure was reflowed by Prettier (`@@ -1248`). Not a logic change.
- `workerLog("error", "Failed to reconcile orphan ImportJob rows", err)` collapsed to one line (`@@ -1573`). Not a logic change.

---

## Count summary

- Safe simplifications: **3 actionable** (S1, S2, S3) + 1 cosmetic (S5) + 2 noted/skip (S4, S6, S7).
- Worth-considering: **5** (W1 = behaviour question, W2-W5 = taste, W6 = hardening not simplification).
- Out-of-scope formatting churn: 3 spots, no action.

Total real candidates: **8** (3 safe + 5 worth-considering).
