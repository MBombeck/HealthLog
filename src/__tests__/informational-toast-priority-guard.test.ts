/**
 * A background notifier (a component that raises toasts nobody asked for,
 * such as the achievement unlocks) routes every toast through
 * `showInformationalToast`, so it never lands in front of a save's Undo /
 * Edit toast (`src/lib/toast/priority.ts`). Notifiers are named
 * `*-notifier.tsx`; this keeps every one of them, and every future one, on
 * the rule.
 */
import { describe, expect, it } from "vitest";

import { readSourceFolder } from "./helpers/source-files";

const TOAST_CALL = /\btoast(?:\.(?:success|info|message|warning))?\(/g;

describe("background notifiers yield to action toasts", () => {
  const notifiers = new Map(
    readSourceFolder("src", {
      floor: 1,
      include: (rel) =>
        !rel.includes("__tests__") && /-notifier\.tsx?$/.test(rel),
    }).map(([rel, text]) => [`src/${rel}`, text] as const),
  );

  it("finds the notifiers (the matcher is not blind)", () => {
    expect([...notifiers.keys()]).toContain(
      "src/components/gamification/achievement-unlock-notifier.tsx",
    );
  });

  it.each([...notifiers.keys()])(
    "%s raises every toast through the queue",
    (file) => {
      const source = notifiers.get(file) ?? "";
      const toasts = source.match(TOAST_CALL)?.length ?? 0;
      const queued = source.match(/showInformationalToast\(/g)?.length ?? 0;
      expect(queued).toBeGreaterThanOrEqual(toasts);
    },
  );
});
