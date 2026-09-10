/**
 * G3 — the success affordance is owned by the outcome module, everywhere.
 *
 * #640 established the rule inside the import panel: a write that wrote
 * nothing must not read as a success. #650 widened it to the medication
 * intake import. This widens it to the whole component tree, because the same
 * defect had been sitting in seven more surfaces the whole time — six
 * integration cards and the lab-OCR dialog reported "success" off `res.ok`,
 * so a sync that imported nothing because every reading was refused rendered
 * a green tick and a count.
 *
 * What this asserts:
 *   1. Every `CheckCircle2` / `text-success` / `toast.success` occurrence
 *      under `src/components` is either inside the shared presentation module
 *      (`src/components/outcome/`) or pinned in `PINNED_AFFORDANCES` with an
 *      exact per-file count. A name-only allowlist would let a listed file add
 *      a SECOND, dishonest tick without anyone noticing, which is why the
 *      counts are pinned rather than the filenames.
 *   2. No pinned entry has gone stale — a file that no longer carries the
 *      marker, or no longer exists, fails here rather than rotting silently.
 *      This is the guard-of-the-guard: if the scanner ever stopped matching,
 *      every entry would go stale at once and this is what would say so.
 *   3. Every surface that reports a write routes its result line through the
 *      shared outcome module.
 *
 * HOW WEAK THIS GUARD IS, stated plainly: this is the weakest guard in the
 * release and it is not complete. It matches three literal tokens. It is
 * evadable by synonym — `text-emerald-500`, a raw checkmark glyph, an
 * `<svg>` copy of the icon, `toast(...)` with a success-looking variant, or a
 * component that wraps any of them. Nothing here proves a surface is honest;
 * it proves a surface did not reach for these three specific affordances
 * without being listed. It also says nothing about `src/app`, which is out of
 * scope by construction (the counted noise floor was measured over
 * `src/components`). Treat a green run as "the known evasions are closed",
 * not as "no surface can lie".
 *
 * Its forced failures, each watched fail before this was committed and then
 * reverted:
 *   - append `toast.success("probe")` to `src/components/ui/alert-dialog.tsx`
 *     (no entry) -> red on the first case, naming the file;
 *   - append a second `CheckCircle2` reference to
 *     `src/components/onboarding/done-screen.tsx` -> red on the second case:
 *     "CheckCircle2 pinned at 2, found 3";
 *   - append a second `text-success` literal to
 *     `src/components/settings/test-connection-button.tsx`, which is pinned at
 *     exactly 1 -> red: "text-success pinned at 1, found 2".
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..");
const COMPONENT_ROOT = join(REPO_ROOT, "src", "components");

/** The tick component, the success colour token, the success toast. */
const SUCCESS_MARKERS = [
  "CheckCircle2",
  "text-success",
  "toast.success",
] as const;

type SuccessMarker = (typeof SUCCESS_MARKERS)[number];

/**
 * The one module allowed to reach for the affordance. `WrittenOutcomeLine`
 * and `toastWrittenOutcome` bind it to the `success` key of the outcome table
 * and nothing else can get at it.
 */
const PRESENTATION_DIR = "src/components/outcome/";

/**
 * Every OTHER file under `src/components` that mentions a marker, with the
 * exact number of times it does. Seeded from the tree as it stands; an entry
 * is not an endorsement, it is a record. Reducing one of these to zero is
 * always welcome — delete the entry in the same commit.
 */
const PINNED_AFFORDANCES: Record<
  string,
  Partial<Record<SuccessMarker, number>>
> = {
  // The third `text-success` is the success arm of StatusItem's tone table:
  // the two status grids used to spell the tint at every call site and now
  // name a tone instead, so the marker lives here once.
  "src/components/admin/_shared.tsx": { "text-success": 3, "toast.success": 1 },
  "src/components/admin/ai-server-key-section.tsx": { "toast.success": 1 },
  "src/components/admin/api-token-overview-section.tsx": { "text-success": 1 },
  "src/components/admin/app-log-preview-section.tsx": {
    CheckCircle2: 2,
    "text-success": 1,
  },
  "src/components/admin/assistant-section.tsx": { "toast.success": 1 },
  "src/components/admin/backups-section.tsx": { "toast.success": 4 },
  "src/components/admin/central-codex-section.tsx": { "toast.success": 2 },
  "src/components/admin/danger-zone-section.tsx": { "text-success": 1 },
  "src/components/admin/encryption-section.tsx": {
    "text-success": 1,
    "toast.success": 1,
  },
  "src/components/admin/glitchtip-section.tsx": { "toast.success": 1 },
  "src/components/admin/invite-tokens-section.tsx": {
    "text-success": 2,
    "toast.success": 3,
  },
  "src/components/admin/login-overview-section.tsx": {
    CheckCircle2: 2,
    "text-success": 2,
    "toast.success": 1,
  },
  "src/components/admin/module-availability-section.tsx": {
    "toast.success": 1,
  },
  "src/components/admin/recent-audit-preview.tsx": {
    CheckCircle2: 2,
    "text-success": 1,
  },
  "src/components/admin/reminders-section.tsx": {
    CheckCircle2: 2,
    "text-success": 4,
    "toast.success": 2,
  },
  "src/components/admin/umami-section.tsx": { "toast.success": 1 },
  "src/components/admin/user-management-section.tsx": {
    "text-success": 2,
    "toast.success": 2,
  },
  "src/components/admin/version-tile-section.tsx": {
    CheckCircle2: 2,
    "text-success": 1,
  },
  "src/components/admin/web-push-vapid-section.tsx": { "toast.success": 1 },
  "src/components/charts/medication-compliance-chart.tsx": {
    "text-success": 1,
  },
  "src/components/custom-metrics/custom-metric-detail.tsx": {
    "toast.success": 1,
  },
  "src/components/custom-metrics/custom-metric-entry-form.tsx": {
    "toast.success": 1,
  },
  "src/components/custom-metrics/custom-metric-form.tsx": {
    "toast.success": 1,
  },
  "src/components/custom-metrics/custom-metric-history-list.tsx": {
    // v1.37.20 (A3-11) — the third success is the restore confirmation
    // behind the delete toast's Undo action.
    "toast.success": 3,
  },
  "src/components/cycle/cycle-phase-crosstab.tsx": { "text-success": 1 },
  // v1.36.x — two call sites, one decision: the intake toast routes through
  // `intakeToastOptions()`, which returns `undefined` in the caller's own
  // record, and sonner's one-argument form is what the unit tests assert. So
  // the if/else that `runLogIntake` already uses landed here too.
  "src/components/dashboard/medication-intake-quick-add.tsx": {
    "toast.success": 2,
  },
  "src/components/dashboard/range-display.tsx": { "text-success": 2 },
  "src/components/documents/document-card.tsx": { "text-success": 1 },
  "src/components/documents/document-detail-sheet.tsx": { "toast.success": 2 },
  "src/components/documents/documents-view.tsx": { "toast.success": 3 },
  "src/components/error-details.tsx": { CheckCircle2: 2, "text-success": 1 },
  "src/components/illness/episode-menu.tsx": {
    CheckCircle2: 2,
    "toast.success": 1,
  },
  "src/components/insights/coach-panel/chat-bubble.tsx": { "text-success": 4 },
  "src/components/insights/coach-panel/history-rail.tsx": {
    "toast.success": 1,
  },
  "src/components/insights/coach-panel/plan-proposal-card.tsx": {
    "text-success": 1,
  },
  "src/components/insights/coach-panel/reminder-suggestion-card.tsx": {
    "text-success": 1,
  },
  "src/components/insights/coach-panel/self-context-adopt-offer.tsx": {
    "text-success": 1,
  },
  "src/components/insights/coach-panel/suggested-action-card.tsx": {
    "text-success": 1,
  },
  "src/components/insights/confidence-badge.ts": { "text-success": 1 },
  "src/components/insights/daily-briefing.tsx": { "text-success": 1 },
  "src/components/insights/derived/band-tokens.ts": { "text-success": 1 },
  // The green `+N` chip beside the Health Score label. It reports a week that
  // went up, not an action that succeeded, and it wears the same band token
  // the score's own number does — there is no outcome here to route through
  // the outcome module.
  "src/components/insights/health-score-card.tsx": { "text-success": 1 },
  "src/components/insights/insights-edit-mode.tsx": { "toast.success": 2 },
  "src/components/insights/insights-tab-strip.tsx": { "toast.success": 1 },
  "src/components/insights/mood/mood-better-days.tsx": { "text-success": 1 },
  "src/components/insights/mood/mood-factor-metric-crosstab.tsx": {
    "text-success": 1,
  },
  "src/components/insights/mood/mood-tag-influence.tsx": { "text-success": 1 },
  "src/components/insights/mood/mood-tag-metric-crosstab.tsx": {
    "text-success": 1,
  },
  "src/components/insights/personal-record-badge.tsx": { "text-success": 1 },
  "src/components/labs/biomarker-form.tsx": { "toast.success": 1 },
  "src/components/labs/biomarker-manager.tsx": { "toast.success": 2 },
  "src/components/labs/lab-biomarker-detail.tsx": { "toast.success": 1 },
  "src/components/labs/lab-form.tsx": { "toast.success": 1 },
  "src/components/labs/lab-history-list.tsx": { "toast.success": 3 },
  "src/components/measurement-reminders/vorsorge-dashboard-card.tsx": {
    CheckCircle2: 2,
  },
  "src/components/measurement-reminders/vorsorge-section.tsx": {
    CheckCircle2: 2,
    "text-success": 1,
  },
  "src/components/measurements/measurement-form.tsx": { "toast.success": 1 },
  "src/components/measurements/measurement-list.tsx": { "toast.success": 3 },
  "src/components/medications/card-parts/medication-status-pill.tsx": {
    "text-success": 1,
  },
  // Same pair, same reason as the dashboard quick-add above.
  "src/components/medications/dose-history-add-dialog.tsx": {
    "toast.success": 2,
  },
  "src/components/medications/dose-history-ledger.tsx": {
    "text-success": 2,
    "toast.success": 4,
  },
  "src/components/medications/intake-edit-dialog.tsx": { "toast.success": 1 },
  "src/components/medications/intake-history-editable.tsx": {
    "toast.success": 2,
  },
  "src/components/medications/intake-history-list-v2.tsx": {
    "text-success": 2,
  },
  "src/components/medications/scheduling/schedule-history-timeline.tsx": {
    "toast.success": 2,
  },
  "src/components/medications/scheduling/schedule-times-editor.tsx": {
    "toast.success": 1,
  },
  "src/components/medications/sections/api-tokens-row.tsx": {
    "toast.success": 1,
  },
  "src/components/medications/sections/destructive-zone-section.tsx": {
    "toast.success": 4,
  },
  "src/components/medications/sections/inventory-dialogs.tsx": {
    "toast.success": 3,
  },
  "src/components/medications/sections/inventory-section.tsx": {
    "toast.success": 1,
  },
  "src/components/medications/sections/notifications-section.tsx": {
    "toast.success": 1,
  },
  "src/components/medications/sections/phase-config-sheet.tsx": {
    "toast.success": 1,
  },
  "src/components/medications/sections/settings-section.tsx": {
    "toast.success": 2,
  },
  // Same pair again: the batch summary names the record it landed in.
  "src/components/medications/take-all-due.ts": { "toast.success": 2 },
  // v1.36.x — one fewer: the log-intake path's three-armed toast collapsed
  // into the shared `intakeToastOptions` decision plus a single call pair.
  "src/components/medications/use-medication-intake.ts": { "toast.success": 4 },
  "src/components/medications/wizard/medication-wizard-dialog.tsx": {
    "toast.success": 1,
  },
  "src/components/mood/manage/archived-tags-card.tsx": { "toast.success": 2 },
  "src/components/mood/manage/tag-editor-sheet.tsx": { "toast.success": 2 },
  "src/components/mood/manage/tag-groups-card.tsx": { "toast.success": 4 },
  "src/components/mood/manage/tag-manager-card.tsx": { "toast.success": 2 },
  "src/components/mood/mood-form.tsx": { "toast.success": 1 },
  "src/components/mood/mood-list.tsx": { "toast.success": 3 },
  "src/components/onboarding/done-screen.tsx": { CheckCircle2: 2 },
  "src/components/onboarding/source-card-grid.tsx": { CheckCircle2: 2 },
  "src/components/records/allergy-form.tsx": { "toast.success": 1 },
  "src/components/records/allergy-manager.tsx": { "toast.success": 1 },
  "src/components/records/conditions-manager.tsx": { "toast.success": 1 },
  "src/components/records/family-history-form.tsx": { "toast.success": 1 },
  "src/components/records/family-history-manager.tsx": { "toast.success": 1 },
  "src/components/settings/_info-tile.tsx": { "text-success": 1 },
  "src/components/records/about-me-note-manager.tsx": { "toast.success": 1 },
  "src/components/records/allergy-free-text-note.tsx": { "toast.success": 1 },
  "src/components/settings/account-section/avatar-section.tsx": {
    "text-success": 1,
  },
  "src/components/settings/account-section/index.tsx": { "text-success": 1 },
  "src/components/settings/advanced-section.tsx": { "text-success": 2 },
  "src/components/settings/ai/ai-insights-card.tsx": { "text-success": 1 },
  "src/components/settings/ai/anthropic-provider-form.tsx": {
    "text-success": 1,
  },
  "src/components/settings/ai/codex-provider-form.tsx": { "text-success": 2 },
  "src/components/settings/ai/compat-provider-form.tsx": { "text-success": 1 },
  "src/components/settings/ai/fallback-chain-card.tsx": { "text-success": 1 },
  "src/components/settings/ai/local-provider-form.tsx": { "text-success": 1 },
  "src/components/settings/ai/openai-provider-form.tsx": { "text-success": 1 },
  "src/components/settings/ai/response-timeout-card.tsx": { "text-success": 1 },
  "src/components/settings/ai/runtime-actions-row.tsx": { "text-success": 2 },
  // The two added by the measurement-ingest mint card are the one-shot
  // token panel and its copy tick, both rendered only once a token actually
  // exists; the toast fires only after the clipboard write resolves. Same
  // shape as the MCP connector card two files over.
  "src/components/settings/api-section.tsx": {
    "text-success": 5,
    "toast.success": 1,
  },
  "src/components/settings/coach-memory-section.tsx": { "toast.success": 2 },
  "src/components/settings/coach-prefs-section.tsx": { "toast.success": 1 },
  "src/components/settings/dashboard-layout-section.tsx": {
    "toast.success": 2,
  },
  "src/components/settings/email-card.tsx": { "text-success": 1 },
  "src/components/settings/environment-section.tsx": { "toast.success": 4 },
  "src/components/settings/insights-pill-order-section.tsx": {
    "toast.success": 1,
  },
  "src/components/settings/integration-status-pill.tsx": {
    CheckCircle2: 2,
    "text-success": 1,
  },
  "src/components/settings/integrations/connections-panel.tsx": {
    "toast.success": 2,
  },
  "src/components/settings/integrations/fitbit-card.tsx": { "text-success": 2 },
  "src/components/settings/integrations/google-health-card.tsx": {
    "text-success": 2,
  },
  "src/components/settings/integrations/nightscout-card.tsx": {
    "text-success": 1,
  },
  "src/components/settings/integrations/oauth-provider-card.tsx": {
    "text-success": 1,
  },
  "src/components/settings/integrations/whoop-card.tsx": { "text-success": 2 },
  "src/components/settings/integrations/withings-card.tsx": {
    "text-success": 2,
  },
  "src/components/settings/mcp-section.tsx": {
    "text-success": 5,
    "toast.success": 2,
  },
  "src/components/settings/modules-section.tsx": { "toast.success": 1 },
  "src/components/settings/notification-status-card.tsx": {
    CheckCircle2: 2,
    "text-success": 1,
  },
  "src/components/settings/ntfy-card.tsx": { "text-success": 1 },
  // The one that used to sit inside `account-section/index.tsx` — the card
  // moved to Settings → Security, the line moved with it.
  "src/components/settings/password-card.tsx": { "text-success": 1 },
  "src/components/settings/security-sessions-card.tsx": { "text-success": 1 },
  "src/components/settings/share-link-create-form.tsx": { "text-success": 3 },
  "src/components/settings/sharing-section.tsx": { "text-success": 1 },
  "src/components/settings/sources-section.tsx": { "toast.success": 2 },
  "src/components/settings/telegram-card.tsx": { "text-success": 1 },
  "src/components/settings/test-connection-button.tsx": {
    CheckCircle2: 2,
    "text-success": 1,
  },
  "src/components/settings/thresholds-editor-section.tsx": {
    "toast.success": 2,
  },
  "src/components/settings/trusted-devices-card.tsx": { "text-success": 1 },
  "src/components/settings/web-push-card.tsx": { "text-success": 1 },
  "src/components/settings/webhook-card.tsx": { "text-success": 1 },
  "src/components/targets/target-edit-sheet.tsx": { "toast.success": 2 },
  "src/components/ui/password-strength.tsx": { "text-success": 2 },
};

/**
 * Every surface that reports the result of a write, and the shared module it
 * must render that result through. `forbidsMarkers` is set where the surface
 * carries no legitimate success affordance of its own, so any marker in the
 * file is by definition a hand-rolled verdict.
 */
const RESULT_SURFACES: ReadonlyArray<{
  path: string;
  through: RegExp;
  forbidsMarkers: boolean;
}> = [
  // The import panel (#640) and the medication intake import (#650).
  {
    path: "src/components/settings/import-panel/csv-import-card.tsx",
    through: /CsvImportResultView|WrittenOutcomeLine/,
    forbidsMarkers: true,
  },
  {
    path: "src/components/settings/import-panel/json-import-card.tsx",
    through: /CsvImportResultView|WrittenOutcomeLine/,
    forbidsMarkers: true,
  },
  {
    path: "src/components/settings/import-panel/apple-health-import-card.tsx",
    through: /CsvImportResultView|WrittenOutcomeLine/,
    forbidsMarkers: true,
  },
  {
    path: "src/components/settings/import-panel/import-result-view.tsx",
    through: /WrittenOutcomeLine/,
    forbidsMarkers: true,
  },
  {
    path: "src/components/medications/intake-import-result.tsx",
    through: /WrittenOutcomeLine/,
    forbidsMarkers: true,
  },
  {
    path: "src/components/medications/intake-import-dialog.tsx",
    through: /IntakeImportResultView/,
    forbidsMarkers: true,
  },
  {
    path: "src/components/settings/import-panel/dose-history-import-card.tsx",
    through: /IntakeImportResultView/,
    forbidsMarkers: true,
  },
  {
    path: "src/components/settings/import-panel/dose-history-verdict.tsx",
    through: /IntakeImportSkipGroups/,
    forbidsMarkers: true,
  },
  // The seven surfaces that were still gated on the transport.
  {
    path: "src/components/settings/integrations/fitbit-card.tsx",
    through: /WrittenOutcomeLine/,
    forbidsMarkers: false,
  },
  {
    path: "src/components/settings/integrations/google-health-card.tsx",
    through: /WrittenOutcomeLine/,
    forbidsMarkers: false,
  },
  {
    path: "src/components/settings/integrations/nightscout-card.tsx",
    through: /WrittenOutcomeLine/,
    forbidsMarkers: false,
  },
  {
    path: "src/components/settings/integrations/whoop-card.tsx",
    through: /WrittenOutcomeLine/,
    forbidsMarkers: false,
  },
  {
    path: "src/components/settings/integrations/withings-card.tsx",
    through: /WrittenOutcomeLine/,
    forbidsMarkers: false,
  },
  {
    path: "src/components/settings/integrations/oauth-provider-card.tsx",
    through: /WrittenOutcomeLine/,
    forbidsMarkers: false,
  },
  {
    path: "src/components/labs/ocr-review-dialog.tsx",
    through: /toastWrittenOutcome/,
    forbidsMarkers: true,
  },
  {
    path: "src/components/records/ai-profile-inclusion-manager.tsx",
    through: /toastWrittenOutcome/,
    forbidsMarkers: true,
  },
  {
    path: "src/components/records/health-profile-facts-manager.tsx",
    through: /toastWrittenOutcome/,
    forbidsMarkers: true,
  },
];

/** Code only — a comment naming a marker is prose, not an affordance. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function readCode(relativePath: string): string {
  return stripComments(readFileSync(join(REPO_ROOT, relativePath), "utf8"));
}

/** Every non-test component source file, as a repo-relative posix path. */
function componentSourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "__tests__") continue;
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
      found.push(relative(REPO_ROOT, full).split(sep).join(posix.sep));
    }
  };
  walk(COMPONENT_ROOT);
  return found.sort();
}

function markerCounts(
  relativePath: string,
): Partial<Record<SuccessMarker, number>> {
  const source = readCode(relativePath);
  const counts: Partial<Record<SuccessMarker, number>> = {};
  for (const marker of SUCCESS_MARKERS) {
    const uses = source.split(marker).length - 1;
    if (uses > 0) counts[marker] = uses;
  }
  return counts;
}

describe("success affordance — owned by the outcome module, pinned everywhere else", () => {
  // A sweep that finds nothing agrees with every allowlist, so the size of
  // the tree being read is asserted before anything is concluded from it.
  // Pinned below the real component-file count with headroom, not at one.
  it("reads the tree it claims to sweep", () => {
    expect(componentSourceFiles().length).toBeGreaterThan(400);
  });

  it("lets no unlisted component reach for the success affordance", () => {
    const unlisted = componentSourceFiles()
      .filter((path) => !path.startsWith(PRESENTATION_DIR))
      .filter((path) => !(path in PINNED_AFFORDANCES))
      .filter((path) => Object.keys(markerCounts(path)).length > 0);
    expect(
      unlisted,
      unlisted.length > 0
        ? `File(s) hand-rolling a success affordance. Render the result through ` +
            `WrittenOutcomeLine / toastWrittenOutcome, or add a pinned entry ` +
            `here with a reason in the commit message: ${unlisted.join(", ")}`
        : undefined,
    ).toEqual([]);
  });

  it("holds every listed file to the exact count it was pinned at", () => {
    const drifted: string[] = [];
    for (const [path, pinned] of Object.entries(PINNED_AFFORDANCES)) {
      if (!existsSync(join(REPO_ROOT, path))) continue;
      const actual = markerCounts(path);
      for (const marker of SUCCESS_MARKERS) {
        const was = pinned[marker] ?? 0;
        const now = actual[marker] ?? 0;
        if (was !== now) {
          drifted.push(`${path}: ${marker} pinned at ${was}, found ${now}`);
        }
      }
    }
    expect(
      drifted,
      drifted.length > 0
        ? `A pinned file changed how often it reaches for the success ` +
            `affordance. An ADDED one is the defect this guard exists for; a ` +
            `REMOVED one is good news, update the count.\n${drifted.join("\n")}`
        : undefined,
    ).toEqual([]);
  });

  it("carries no stale entry — the guard-of-the-guard", () => {
    const stale = Object.keys(PINNED_AFFORDANCES).filter((path) => {
      if (!existsSync(join(REPO_ROOT, path))) return true;
      return Object.keys(markerCounts(path)).length === 0;
    });
    expect(
      stale,
      stale.length > 0
        ? `Pinned entr(ies) that no longer carry any marker (or no longer ` +
            `exist). Delete them. If EVERY entry is listed here, the scanner ` +
            `stopped matching and the guard is inert: ${stale.join(", ")}`
        : undefined,
    ).toEqual([]);
  });

  it("routes every write-reporting surface through the shared outcome module", () => {
    for (const surface of RESULT_SURFACES) {
      expect(
        readCode(surface.path),
        `${surface.path} must render its outcome through the shared module`,
      ).toMatch(surface.through);
    }
  });

  it("keeps the affordance out of the surfaces that own none of it", () => {
    const offenders = RESULT_SURFACES.filter(
      (surface) =>
        surface.forbidsMarkers &&
        Object.keys(markerCounts(surface.path)).length > 0,
    ).map((surface) => surface.path);
    expect(
      offenders,
      offenders.length > 0
        ? `Surface(s) hand-rolling the success affordance instead of ` +
            `classifying what was written: ${offenders.join(", ")}`
        : undefined,
    ).toEqual([]);
  });
});
