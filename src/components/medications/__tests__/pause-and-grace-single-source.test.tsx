/**
 * Two facts the medication page shows in more than one place, each read from
 * one source.
 *
 * The on-time window. The recurrence engine fell back to the legacy window
 * span or 60 minutes, the compliance cycle walk to 60 and the page (plan row
 * and reminder setting) to 30, so a schedule without its own value was
 * overdue after 60 minutes on the server and "reminded for 30 minutes" on the
 * page. `effectiveGraceMinutes` is the one rule; nothing else may fall back.
 *
 * The pause state. The header menu and the settings switch each kept a copy
 * of `!active` in local state, seeded once at mount, so pausing from one left
 * the other saying the opposite until a reload. The hook now derives the
 * state from the stored `active` and overrides it only while its own write
 * is in flight.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";
import {
  DEFAULT_GRACE_MINUTES,
  effectiveGraceMinutes,
} from "@/lib/medications/scheduling/grace";

import { readSource, readSourceFolder } from "@/__tests__/helpers/source-files";

import { usePauseToggle } from "../sections/destructive-zone-section";

/** Every source file under `src/`, tests and the generated client left out. */
function sourceFiles(): Array<[string, string]> {
  return readSourceFolder("src", {
    floor: 1500,
    include: (rel) =>
      !rel.startsWith("generated/") &&
      !rel.includes("__tests__/") &&
      !/\.test\.tsx?$/.test(rel),
  });
}

describe("the on-time window has one rule", () => {
  it("takes the schedule's own value first", () => {
    expect(
      effectiveGraceMinutes({
        reminderGraceMinutes: 30,
        windowStart: "08:00",
        windowEnd: "10:00",
      }),
    ).toBe(30);
    expect(effectiveGraceMinutes({ reminderGraceMinutes: 0 })).toBe(0);
  });

  it("then the legacy window span, wrapping overnight", () => {
    expect(
      effectiveGraceMinutes({
        reminderGraceMinutes: null,
        windowStart: "08:00",
        windowEnd: "10:00",
      }),
    ).toBe(120);
    expect(
      effectiveGraceMinutes({ windowStart: "23:00", windowEnd: "01:00" }),
    ).toBe(120);
  });

  it("then 60 minutes, the same number the server closes the window with", () => {
    expect(DEFAULT_GRACE_MINUTES).toBe(60);
    expect(effectiveGraceMinutes({})).toBe(60);
    expect(
      effectiveGraceMinutes({ windowStart: "08:00", windowEnd: "08:00" }),
    ).toBe(60);
  });

  it("is the only fallback in the tree", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const [file, text] of sourceFiles()) {
      const rel = `src/${file}`;
      if (rel === "src/lib/medications/scheduling/grace.ts") continue;
      scanned += 1;
      // A numeric default after the stored value, on one line or across two.
      if (/reminderGraceMinutes\s*\)?\s*(\?\?|\|\|)\s*\d/.test(text)) {
        offenders.push(`${rel}: numeric fallback for reminderGraceMinutes`);
      }
      if (/\bfirstGrace\b[\s\S]{0,80}:\s*\d+/.test(text)) {
        offenders.push(`${rel}: hand-written grace default`);
      }
      if (/(const|let)\s+DEFAULT_GRACE_MINUTES\s*=/.test(text)) {
        offenders.push(`${rel}: a second DEFAULT_GRACE_MINUTES`);
      }
    }
    expect(scanned).toBeGreaterThan(500);
    expect(offenders).toEqual([]);
  });

  it("is what the engine, the cycle walk and the page import", () => {
    for (const rel of [
      "src/lib/medications/scheduling/recurrence.ts",
      "src/lib/analytics/compliance/cycle.ts",
      "src/components/medications/detail/overview/plan-card.tsx",
      "src/components/medications/sections/settings-section.tsx",
    ]) {
      // The anchor is the assertion: readSource throws when it is gone.
      expect(readSource(rel, "effectiveGraceMinutes(")).toBeTruthy();
    }
  });
});

describe("the pause state has one source", () => {
  function Probe({ active }: { active: boolean }) {
    const pause = usePauseToggle({ medicationId: "med-1", active });
    return (
      <span data-paused={String(pause.paused)} data-busy={String(pause.busy)} />
    );
  }

  function render(active: boolean): string {
    return renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <QueryClientProvider client={new QueryClient()}>
          <Probe active={active} />
        </QueryClientProvider>
      </I18nProvider>,
    );
  }

  it("reads the stored active flag", () => {
    expect(render(true)).toContain('data-paused="false"');
    expect(render(false)).toContain('data-paused="true"');
    expect(render(false)).toContain('data-busy="false"');
  });

  it("keeps no copy of it seeded at mount", () => {
    const text = readSource(
      "src/components/medications/sections/destructive-zone-section.tsx",
      ["export function usePauseToggle", "return { paused, busy, toggle }"],
    );
    const hook = text.slice(
      text.indexOf("export function usePauseToggle"),
      text.indexOf("return { paused, busy, toggle }"),
    );
    expect(hook.length).toBeGreaterThan(100);
    expect(hook).not.toMatch(/useState\(\s*!?\s*active\s*\)/);
    expect(hook).toMatch(/pending \?\? !active/);
  });
});
