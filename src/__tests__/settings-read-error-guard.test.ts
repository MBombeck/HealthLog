/**
 * A settings or admin card that reads something shows a failed read as one:
 * the inset read-failure row with Retry (`QueryErrorRow inset`, or
 * `CardQueryBody` around the card's content), never an empty-looking card or
 * a default presented as the stored value (UI standards §6 and §13).
 *
 * 1.49.0 shipped import cards and a snooze setting that did neither. This
 * holds the rule for every file under `src/components/settings` and
 * `src/components/admin` that calls `useQuery(` itself. The files listed in
 * `KNOWN_GAPS` predate the rule (several are hooks whose callers handle the
 * error); the list may only shrink: a new file cannot join it, and a file
 * that gains its error state has to leave it.
 */
import { describe, expect, it } from "vitest";

import { readSourceFolder } from "./helpers/source-files";

// `query={statusQuery}` hands an import source's status read to
// `ImportSource`, which says a failure on the row and opens the sheet on the
// query-error row with Retry.
const HANDLES_ERROR =
  /isError|QueryErrorRow|QueryErrorCard|ChartErrorState|CardQueryBody|\bquery=\{statusQuery\}/;

const KNOWN_GAPS = new Set([
  "components/admin/_shared.tsx",
  "components/admin/ai-server-key-section.tsx",
  "components/admin/ai-usage-section.tsx",
  "components/admin/api-token-overview-section.tsx",
  "components/admin/app-log-preview-section.tsx",
  "components/admin/assistant-section.tsx",
  "components/admin/backups/use-backup-restores.ts",
  "components/admin/central-codex-section.tsx",
  "components/admin/login-overview-section.tsx",
  "components/admin/module-availability-section.tsx",
  "components/admin/support-report-card.tsx",
  "components/admin/use-push-relay.ts",
  "components/admin/use-recovery-kit.ts",
  "components/admin/use-recovery-readiness.ts",
  "components/admin/version-tile-section.tsx",
  "components/settings/about-section.tsx",
  "components/settings/apple-health-mirror-token.tsx",
  "components/settings/coach-nudge-card.tsx",
  "components/settings/dashboard-layout/use-dashboard-layout-draft.ts",
  "components/settings/email-card.tsx",
  "components/settings/environment-section.tsx",
  "components/settings/environment-travel-suggestions.tsx",
  "components/settings/injection-sites-card.tsx",
  "components/settings/integrations/notification-channels-panel.tsx",
  "components/settings/integrations/shared.tsx",
  "components/settings/low-stock-card.tsx",
  "components/settings/medications-section.tsx",
  "components/settings/mood-reminder-card.tsx",
  "components/settings/notification-content-card.tsx",
  "components/settings/notification-status-card.tsx",
  "components/settings/ntfy-card.tsx",
  "components/settings/nutrient-intake-card.tsx",
  "components/settings/security-section/index.tsx",
  "components/settings/security-section/passkey-list-section.tsx",
  "components/settings/sources-section.tsx",
  "components/settings/telegram-card.tsx",
  "components/settings/thresholds-editor-section.tsx",
  "components/settings/webhook-card.tsx",
]);

describe("settings and admin reads render their failure", () => {
  const readers: Array<readonly [string, string]> = [
    "components/settings",
    "components/admin",
  ].flatMap((dir) =>
    readSourceFolder(`src/${dir}`, {
      floor: 50,
      include: (rel) => !rel.includes("__tests__"),
    })
      .filter(([, text]) => text.includes("useQuery("))
      .map(([rel, text]) => [`${dir}/${rel}`, text] as const),
  );
  const gaps = readers
    .filter(([, text]) => !HANDLES_ERROR.test(text))
    .map(([file]) => file)
    .sort();

  it("finds the readers (the matcher is not blind)", () => {
    expect(readers.length).toBeGreaterThan(40);
  });

  it("adds no new card without an error state", () => {
    expect(gaps.filter((f) => !KNOWN_GAPS.has(f))).toEqual([]);
  });

  it("drops a file from the known gaps once it handles the error", () => {
    expect([...KNOWN_GAPS].filter((f) => !gaps.includes(f))).toEqual([]);
  });

  it("covers the 1.49.0 import and snooze cards", () => {
    for (const file of [
      "components/settings/import-panel/health-connect-remote-card.tsx",
      "components/settings/import-panel/record-file-import-card.tsx",
      "components/settings/dose-snooze-card.tsx",
    ]) {
      expect(KNOWN_GAPS.has(file), file).toBe(false);
    }
  });
});
