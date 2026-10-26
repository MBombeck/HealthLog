/**
 * Structural guard on the "stale Today hero / dashboard after a write" class.
 *
 * The daily reads — `dailyDigest()` (Today hero) and `dashboardSnapshot()`
 * (dashboard) — run with `refetchOnMount: false` and a 120 s poll. A mutation
 * that invalidates one of the daily-reads-bearing bundles
 * (`medicationDependentKeys` / `measurementDependentKeys` / `moodDependentKeys`)
 * with the DEFAULT `refetchType: "active"` only refetches MOUNTED queries — so a
 * write made from a surface where the daily reads are UNMOUNTED (the medications
 * page, a detail page, the mood/measurement forms) marks them stale but never
 * refetches them. Returning to `/` then serves the pre-write cache until the
 * poll ticks or the tab is hard-reloaded.
 *
 * The blessed contract is `refetchInactiveDailyReads(queryClient)` (or its
 * wrapper `invalidateMedicationReads`), which forces the two inactive reads to
 * refetch. This class has recurred THREE times (v1.16.11 snapshot, v1.29.1
 * digest, v1.32.19 "Take all due") because the bundle cannot express
 * `refetchType`, so every new call site re-decides it by hand. This guard makes
 * a fourth recurrence fail CI.
 *
 * Like the Bearer-scope guard, this is a tripwire, not a proof. It cannot show
 * an allowlisted exception is correct — only that no NEW site invalidates a
 * daily bundle without the paired refetch, and no PAIRED site loses its refetch,
 * without someone editing this file.
 *
 * Both matcher families were proven live by breaking a real fix and watching
 * the guard go red: removing the `refetchInactiveDailyReads` pairing from the
 * illness invalidator (`components/illness/use-illness.ts`) failed the bundle
 * assertion, and reverting the score-config save
 * (`components/settings/score-section.tsx`) to its former bare
 * snapshot/digest `invalidateQueries` pair failed the direct-invalidation
 * assertion. Both fixes were then restored and the guard re-ran green.
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";

import { readSourceText, walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** The factory itself DEFINES the bundles + helpers; it is never a call site. */
const FACTORY = "lib/query-keys/index.ts";

/**
 * A direct-bundle invalidation call site: `invalidateKeys(<qc>, <bundle>)` or
 * `invalidateKeys(<qc>, [...<bundle>, <localKey>])`. Captures every form the
 * codebase actually uses (bare bundle, or spread into an array with an extra
 * per-surface key). Sites routed through `invalidateMedicationReads` do NOT
 * match — the wrapper carries the refetch internally, so they are compliant by
 * construction and correctly invisible here.
 *
 * The cycle / encounter / vaccination / illness families joined the matcher
 * alongside the original three: the encounter and illness bundles now carry a
 * daily-read key directly, the vaccination bundle's reminder root feeds the
 * Today rail, and cycle rides along so a future daily-read key added to its
 * bundle cannot ship an unpaired site silently (its current sites are
 * allowlisted below with the reason).
 */
const INVALIDATION =
  /invalidateKeys\(\s*[^,]+,\s*\[?\s*(?:\.\.\.)?\s*(?:medicationDependentKeys|measurementDependentKeys|moodDependentKeys|cycleDependentKeys|encounterDependentKeys|vaccinationDependentKeys|illnessDependentKeys)\b/g;
// Match the CALL form only (open paren), never the bare import specifier —
// otherwise the `import { refetchInactiveDailyReads }` line would inflate the
// count and let a file drop one paired call while still "passing".
// `invalidateReminderReads` counts as a paired refetch: it carries
// `refetchInactiveDailyReads` internally (see `hooks/use-measurement-reminders`),
// and the encounter / vaccination mutation sites pair through it.
const REFETCH = /(?:refetchInactiveDailyReads|invalidateReminderReads)\(/g;

/**
 * Second matcher family — a DIRECT `invalidateQueries` on a daily-read key.
 * Captures `<qc>.invalidateQueries({ queryKey: queryKeys.dashboardSnapshot() })`
 * / `dailyDigest()` in every observed shape (single line, prettier-broken,
 * with or without a `refetchType`). Group 1 carries the `refetchType` value
 * when present: `"inactive"` and `"all"` both force the unmounted daily reads
 * to refetch and are compliant; a bare call (or `"active"`) marks the
 * typically-unmounted daily reads stale without refetching them — exactly the
 * v1.16.11/v1.29.1/v1.32.19 class, one call site at a time instead of via a
 * bundle. Known limit (mirrors the bundle matcher): a call spelling the key
 * through a local alias rather than `queryKeys.<key>()` would slip past.
 */
const DIRECT_DAILY_INVALIDATION =
  /\.invalidateQueries\(\s*\{\s*queryKey:\s*queryKeys\.(?:dashboardSnapshot|dailyDigest)\(\)\s*,?\s*(?:refetchType:\s*"(\w+)"\s*,?\s*)?\}\s*,?\s*\)/g;

function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

function read(rel: string): string {
  return readSourceText(join(SRC, rel));
}

function count(s: string, re: RegExp): number {
  return (s.match(re) ?? []).length;
}

/**
 * Files that invalidate a daily bundle WITHOUT pairing the inactive refetch,
 * deliberately. Frozen: a new entry is a conscious decision that must land in a
 * reviewed diff, exactly like the Bearer-scope mint allowlist. Each entry is a
 * surface where the missing refetch is intentional, grouped by reason.
 */
const NO_REFETCH_ALLOWLIST = [
  // Injection-site metadata saved AFTER an already-recorded (and already
  // refetched) take — it does not change any dose's due/taken state.
  "components/medications/glp1-medication-card.tsx",
  "components/medications/medication-card.tsx",
  // Pull-to-refresh: a current-surface read gesture on the medications page,
  // not a hero-affecting write (audit B, B-5).
  "app/medications/page-client.tsx",
  // Medication configuration / metadata surfaces — rename, dose, schedule
  // times, phase config, push preferences, API tokens, the create wizard.
  // None records an intake; a schedule edit's next-due shift converges via the
  // standard poll from a deep-config surface. Tighten in a later pass if a
  // config surface is shown to strand the rail.
  "components/medications/scheduling/schedule-times-editor.tsx",
  "components/medications/sections/api-tokens-row.tsx",
  "components/medications/sections/notifications-section.tsx",
  "components/medications/sections/phase-config-sheet.tsx",
  "components/medications/sections/settings-section.tsx",
  "components/medications/wizard/medication-wizard-dialog.tsx",
  // Background integration-sync completion on the Settings surface — the user
  // is configuring an integration, not acting on the hero; convergence via the
  // daily reads' own poll/focus refetch is the intended behaviour.
  "components/settings/integrations/google-health-card.tsx",
  "components/settings/integrations/integration-actions.tsx",
  "components/settings/integrations/nightscout-card.tsx",
  "components/settings/integrations/oauth-integration-card.tsx",
  // Cycle writes: `cycleDependentKeys` carries no daily-read key and neither
  // the dashboard snapshot nor the Today digest reads cycle rows today, so
  // the forced refetch would be a no-op round-trip. The bundle is in the
  // matcher so the day a daily-read key joins it, these sites surface here
  // and must take the pairing.
  "components/cycle/use-cycle.ts",
].sort();

/**
 * Files allowed a DIRECT daily-read `invalidateQueries` without an inactive
 * refetch, deliberately. Frozen like the bundle allowlist above.
 */
const DIRECT_NO_REFETCH_ALLOWLIST = [
  // Background sync completion on the Settings surface — same reason as the
  // integration cards in the bundle allowlist: the user is configuring, not
  // acting on the hero; poll/focus convergence is intended.
  "components/settings/integrations/google-health-card.tsx",
  // The check-in card and the priority-item dismissal both render INSIDE the
  // Today digest, so the digest query is mounted and the default
  // `refetchType: "active"` refetches it immediately — the inactive arm has
  // nothing to cover.
  "hooks/use-coach-checkin.ts",
  "hooks/use-priority-item-dismiss.ts",
].sort();

describe("daily-reads refetch guard", () => {
  // A sweep that finds nothing agrees with every allowlist, so the size of
  // the tree being read is asserted before anything is concluded from it.
  // Pinned below the real source-file count with headroom, not at one.
  it("reads the tree it claims to sweep", () => {
    expect(sourceFiles().length).toBeGreaterThan(1500);
  });

  it("the blessed helper pairs the bundle invalidation with the inactive refetch", () => {
    const src = read(FACTORY);
    // The one canonical entry point every intake surface routes through.
    expect(src).toMatch(/export async function invalidateMedicationReads\(/);
    // It must do BOTH — invalidate the bundle AND force the inactive refetch.
    const body = src.slice(
      src.indexOf("export async function invalidateMedicationReads("),
    );
    expect(body).toMatch(
      /invalidateKeys\(\s*queryClient,\s*medicationDependentKeys\s*\)/,
    );
    expect(body).toMatch(/refetchInactiveDailyReads\(queryClient\)/);
  });

  it("every bundle-invalidation site pairs a refetch, except the frozen allowlist", () => {
    // For each file that invalidates a daily bundle, the count of paired
    // refetches must be at least the count of invalidations. A count rule (not
    // a line-proximity heuristic) catches BOTH a new unpaired file AND a new
    // unpaired call site slipped into an already-compliant file (its refetch
    // count would then fall below its invalidation count).
    const nonCompliant: string[] = [];
    for (const rel of sourceFiles()) {
      if (rel === FACTORY) continue;
      const s = read(rel);
      const invalidations = count(s, INVALIDATION);
      if (invalidations === 0) continue;
      const refetches = count(s, REFETCH);
      if (refetches < invalidations) nonCompliant.push(rel);
    }

    // The set of deliberately-unpaired sites must be EXACTLY the allowlist:
    // a new intake mutation that forgets the refetch appears here but not in
    // the allowlist → fail; a paired site that loses its refetch drops into
    // this set → fail; a deliberate new exception must be added above.
    expect(nonCompliant.sort()).toEqual(NO_REFETCH_ALLOWLIST);
  });

  it("every direct daily-read invalidation forces a refetch, except the frozen allowlist", () => {
    // A direct `invalidateQueries(dashboardSnapshot|dailyDigest)` is the
    // single-key form of the same class the bundle matcher pins. Compliant
    // forms: `refetchType: "inactive"` / `"all"` on the call itself, or a
    // paired `refetchInactiveDailyReads` elsewhere in the file (then the
    // direct call is the mounted-arm half of an explicit pair).
    const nonCompliant: string[] = [];
    let totalMatches = 0;
    for (const rel of sourceFiles()) {
      if (rel === FACTORY) continue;
      const s = read(rel);
      let bare = 0;
      for (const m of s.matchAll(DIRECT_DAILY_INVALIDATION)) {
        totalMatches++;
        const refetchType = m[1];
        if (refetchType !== "inactive" && refetchType !== "all") bare++;
      }
      if (bare > 0 && count(s, REFETCH) === 0) nonCompliant.push(rel);
    }
    // The matcher must be alive: the tree has known compliant call sites
    // (the dashboard-layout section's `refetchType: "all"` pair among them).
    // Zero matches would mean the regex rotted, not that the class is gone —
    // the lesson of the 2026-08-01 bearer-guard blind spot.
    expect(totalMatches).toBeGreaterThan(3);
    expect(nonCompliant.sort()).toEqual(DIRECT_NO_REFETCH_ALLOWLIST);
  });

  it("the fixed intake surfaces route through the blessed helper or pair the refetch", () => {
    // Positive pin: the v1.32.19 seed sites must carry the fix, so a revert to
    // a bare `invalidateKeys(medicationDependentKeys)` is caught here as well
    // as by the count assertion above.
    const routedThroughHelper = [
      "components/medications/take-all-due.ts",
      "components/medications/intake-edit-dialog.tsx",
      "components/medications/intake-history-editable.tsx",
      "components/medications/intake-import-dialog.tsx",
      "components/medications/sections/destructive-zone-section.tsx",
      "components/medications/use-medication-intake.ts",
    ];
    for (const rel of routedThroughHelper) {
      expect(read(rel)).toMatch(/invalidateMedicationReads\(/);
    }
    const pairInPlace = [
      "components/medications/dose-history/use-dose-history-ledger.ts",
      "components/medications/dose-history-add-dialog.tsx",
    ];
    for (const rel of pairInPlace) {
      expect(read(rel)).toMatch(REFETCH);
    }
  });
});
