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
 * (through `toastWrittenOutcome` or sonner), a written-outcome line, the
 * meta, or `meta: CONFIRMS_INLINE` where the change answers in place (a saved
 * line, a link or code that appears, a row that leaves the list). An inline
 * marker carries a comment on the line above saying what the answer is, so a
 * reviewer can check the claim against the render code. There are no
 * exemptions: a new silent writer fails here.
 */
import { describe, expect, it } from "vitest";

import { readSourceFolder } from "@/__tests__/helpers/source-files";

const ANSWERS =
  /toast(\.(success|info|message|warning))?\(|toastWrittenOutcome\(|WrittenOutcomeLine|CONFIRM_SAVED|CONFIRMS_INLINE/;

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
      .map((w) => w.path);
    expect(
      silent,
      "confirm the write: meta CONFIRM_SAVED, toastWrittenOutcome, or an inline line (CONFIRMS_INLINE)",
    ).toEqual([]);
  });

  it("says what every inline confirmation is", () => {
    const unexplained = writers.flatMap((w) => {
      const lines = w.text.split("\n");
      return lines.flatMap((line, i) =>
        /meta:\s*CONFIRMS_INLINE/.test(line) &&
        !/^\s*\/\//.test(lines[i - 1] ?? "")
          ? [`${w.path}:${i + 1}`]
          : [],
      );
    });
    expect(
      unexplained,
      "put a one-line comment above meta: CONFIRMS_INLINE naming the answer",
    ).toEqual([]);
  });

  it("confirms the changes that saved without a word", () => {
    for (const path of [
      "components/cycle/use-cycle.ts",
      "components/settings/report-schedule-card.tsx",
      "components/settings/import-panel/health-connect-remote-card.tsx",
      "components/settings/glucose-reference-card.tsx",
      "components/cycle/use-cycle-feed.ts",
      "components/settings/care-calendar-feed-card.tsx",
      "components/settings/managed-record-settings-section.tsx",
      "components/settings/ai/ai-consent-card.tsx",
    ]) {
      const writer = writers.find((w) => w.path === path);
      expect(writer?.text, path).toMatch(/CONFIRM_SAVED/);
    }
  });
});
