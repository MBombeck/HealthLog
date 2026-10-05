/**
 * Structural guard for two Coach streaming-lifecycle invariants.
 *
 * These are STRUCTURAL assertions over the source text, not behavioural ones.
 * The repo ships no `@testing-library/react` / `renderHook`, so an unmount
 * cleanup and a tray-switch callback cannot be driven behaviourally here. A
 * structural guard is weaker than a behavioural test — it proves the code is
 * present, not that it works — but both defects were *deletions of a call*,
 * which is exactly what a structural guard does catch. Matches the existing
 * `*-guard.test.ts` precedent in this directory.
 *
 * Invariant 1 — `useSendCoachMessage` aborts its in-flight reader on unmount.
 * Without it, the full-page `/coach` surface (which passes no `registerReset`,
 * so the reset effect early-returns) left the SSE reader loop alive on a
 * route change: the provider kept generating and billing, and trailing
 * setState fired on an unmounted component. The drawer worked around this via
 * `handleOpenChange`; route-change unmount had no exit at all.
 *
 * Invariant 2 — switching conversations resets the send state. Without it the
 * previous thread's last assistant/error bubble rendered appended to the newly
 * selected thread until the next send, because `streamingActive` stays true
 * while that messageId is absent from the new thread's messages.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

describe("Coach streaming lifecycle", () => {
  it("useSendCoachMessage registers an unmount cleanup that aborts the reader", () => {
    const source = read("components/insights/coach-panel/use-coach.ts");

    // An effect with an empty dependency array whose cleanup aborts.
    const hasUnmountAbort =
      /useEffect\([\s\S]*?return\s*\(\)\s*=>\s*\{[^}]*abortRef\.current\?\.abort\(\)/.test(
        source,
      );
    expect(
      hasUnmountAbort,
      "use-coach.ts must abort abortRef in an unmount cleanup effect",
    ).toBe(true);

    // And it must be mount-scoped — a dependency-carrying effect would abort
    // mid-stream on an unrelated re-render.
    const effectWithDeps =
      /return\s*\(\)\s*=>\s*\{\s*abortRef\.current\?\.abort\(\);\s*\};\s*\},\s*\[\]\s*\)/.test(
        source,
      );
    expect(
      effectWithDeps,
      "the unmount abort effect must have an empty dependency array",
    ).toBe(true);
  });

  it("the conversation-switch handler resets the send state", () => {
    const source = read(
      "components/insights/coach-panel/coach-conversation.tsx",
    );

    // One switch handler, shared by the drawer's history tray and the page's
    // conversations panel, so neither surface can skip the reset.
    const match = source.match(
      /function selectConversation\(id: string\) \{[\s\S]*?\n {2}\}/,
    );
    expect(match, "selectConversation handler not found").not.toBeNull();
    expect(
      match![0].includes("send.reset()"),
      "selecting another conversation must call send.reset() so the previous " +
        "thread's trailing stream state does not bleed into the new thread",
    ).toBe(true);

    const selectSites = source.match(/onSelect=\{([^}]*)\}/g) ?? [];
    expect(selectSites.length).toBeGreaterThanOrEqual(2);
    for (const site of selectSites) {
      expect(
        site,
        "every conversation picker routes through selectConversation",
      ).toBe("onSelect={selectConversation}");
    }
  });

  it("the unmount cleanup records the interrupted conversation before the abort (#781)", () => {
    const source = read("components/insights/coach-panel/use-coach.ts");

    // A cleanup that writes the resume value under the storage key. Without
    // it the unmount abort is silent again: the user returns to a blank new
    // chat with no route back to the interrupted thread.
    const recordsInterruption =
      /return\s*\(\)\s*=>\s*\{[\s\S]*?interruptedResumeValue\(\s*active\s*\)[\s\S]*?sessionStorage\.setItem\(\s*COACH_INTERRUPTED_STORAGE_KEY/.test(
        source,
      );
    expect(
      recordsInterruption,
      "use-coach.ts must record the interrupted conversation " +
        "(COACH_INTERRUPTED_STORAGE_KEY) in an unmount cleanup",
    ).toBe(true);

    // And the recording effect must be defined BEFORE the abort effect so
    // the flag is written while the send is still marked in flight.
    const recordIndex = source.indexOf("COACH_INTERRUPTED_STORAGE_KEY,\n");
    const abortIndex = source.indexOf("abortRef.current?.abort();\n    };");
    expect(recordIndex).toBeGreaterThan(-1);
    expect(abortIndex).toBeGreaterThan(-1);
    expect(
      recordIndex < abortIndex,
      "the interruption-recording cleanup must be defined before the " +
        "mount-scoped abort cleanup",
    ).toBe(true);
  });

  it("handleNewChat still resets too — the two paths must not diverge again", () => {
    const source = read(
      "components/insights/coach-panel/coach-conversation.tsx",
    );
    expect(source).toContain("send.reset()");
    // Both call sites present: new-chat and conversation-switch.
    const resetCalls = source.match(/send\.reset\(\)/g) ?? [];
    expect(resetCalls.length).toBeGreaterThanOrEqual(2);
  });
});
