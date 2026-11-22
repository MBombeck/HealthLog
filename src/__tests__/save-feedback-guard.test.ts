/**
 * Every settings change answers once it lands.
 *
 * `docs/contributing/ui-standards.md` regulated how a failed read looks and
 * said nothing about a successful change, and many changes saved without a
 * word: the pregnancy state, the scheduled report, the import folder, its
 * "Fetch now" and its removal. The answer has one home now, the app's
 * mutation cache (`src/lib/api/mutation-feedback.ts`, `MutationSavedToaster`
 * in `src/components/providers.tsx`): a write that declares
 * `meta: CONFIRM_SAVED` gets "Saved" unless its call site already said more.
 *
 * This holds the settings and cycle writers to one of: a toast of their own
 * (through `toastWrittenOutcome` or sonner), a written-outcome line, or the
 * meta. The files below still answer in ways this matcher cannot see (an
 * inline "saved" state, a form that closes into the changed list) or not at
 * all; the list may only shrink. A new silent writer fails here.
 */
import { describe, expect, it } from "vitest";

import { readSourceFolder } from "@/__tests__/helpers/source-files";

const ANSWERS =
  /toast(\.(success|info|message|warning))?\(|toastWrittenOutcome\(|WrittenOutcomeLine|CONFIRM_SAVED|CONFIRMS_INLINE/;

/** Writers that do not answer through a matched path yet. Only shrinks. */
const NOT_YET_MATCHED: readonly string[] = [
  "components/cycle/use-cycle-feed.ts",
  "components/settings/account-section/avatar-section.tsx",
  "components/settings/ai/ai-consent-card.tsx",
  "components/settings/ai/anthropic-provider-form.tsx",
  "components/settings/ai/compat-provider-form.tsx",
  "components/settings/ai/fallback-chain-card.tsx",
  "components/settings/ai/local-provider-form.tsx",
  "components/settings/ai/openai-provider-form.tsx",
  "components/settings/care-calendar-feed-card.tsx",
  "components/settings/environment-travel-suggestions.tsx",
  "components/settings/integrations/fitbit-removal-notice.tsx",
  "components/settings/integrations/garmin-card.tsx",
  "components/settings/integrations/nightscout-card.tsx",
  "components/settings/managed-record-settings-section.tsx",
  "components/settings/notification-status-card.tsx",
  "components/settings/security-section/passkey-upgrade-nudge.tsx",
  "components/settings/security-section/totp-card.tsx",
  "components/settings/security-sessions-card.tsx",
  "components/settings/share-link-create-form.tsx",
  "components/settings/trusted-devices-card.tsx",
];

const writers = readSourceFolder("src/components", {
  floor: 200,
  include: (rel) =>
    /^(settings|cycle)\//.test(rel) &&
    !rel.includes("__tests__/") &&
    !/\.test\.tsx?$/.test(rel),
})
  .filter(([, text]) => text.includes("useMutation("))
  .map(([rel, text]) => ({ path: `components/${rel}`, text }));

describe("settings writes answer", () => {
  it("finds the writers at all", () => {
    expect(writers.length).toBeGreaterThanOrEqual(40);
  });

  it("every new writer confirms its change", () => {
    const silent = writers
      .filter((w) => !ANSWERS.test(w.text))
      .map((w) => w.path)
      .filter((path) => !NOT_YET_MATCHED.includes(path));
    expect(
      silent,
      "confirm the write: meta CONFIRM_SAVED, toastWrittenOutcome, or an inline line (CONFIRMS_INLINE)",
    ).toEqual([]);
  });

  it("the list of unmatched writers only shrinks", () => {
    const nowAnswering = NOT_YET_MATCHED.filter((path) => {
      const writer = writers.find((w) => w.path === path);
      return !writer || ANSWERS.test(writer.text);
    });
    expect(nowAnswering, "remove these from NOT_YET_MATCHED").toEqual([]);
  });

  it("confirms the changes that saved without a word", () => {
    for (const path of [
      "components/cycle/use-cycle.ts",
      "components/settings/report-schedule-card.tsx",
      "components/settings/import-panel/health-connect-remote-card.tsx",
      "components/settings/glucose-reference-card.tsx",
    ]) {
      const writer = writers.find((w) => w.path === path);
      expect(writer?.text, path).toMatch(/CONFIRM_SAVED/);
    }
  });
});
