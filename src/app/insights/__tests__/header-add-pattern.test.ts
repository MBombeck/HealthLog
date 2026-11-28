/**
 * v1.42 — adding from an Insights page is the header plus, one component.
 *
 * The mood page carried two text links under its heading ("Log a mood entry",
 * "Take a mental-wellbeing check-in") where every other Insights page offers
 * a plus in the header, and the workouts page drew its plus by hand. The mood
 * page goes through `SubPageAddButton`; the workouts page is a domain page now
 * and adds through `PageAddButton`. This sweep keeps it that way: no page under
 * `src/app/insights` draws its own plus glyph, and the mood page carries no
 * text link into a capture surface.
 *
 * The matchers assert a non-zero population, so a move that leaves the sweep
 * reading nothing fails instead of passing quietly.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "@/__tests__/helpers/source-files";

const ROOT = process.cwd();
const INSIGHTS = join(ROOT, "src/app/insights");

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === "__tests__") return [];
    if (statSync(full).isDirectory()) return pages(full);
    return /^page(-client)?\.tsx$/.test(name) ? [full] : [];
  });
}

describe("Insights add actions", () => {
  const files = pages(INSIGHTS);

  it("sweeps the Insights pages", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it("no page draws its own plus; the header plus is the shared component", () => {
    const own = files.filter((file) =>
      /import\s*\{[^}]*\bPlus\b[^}]*\}\s*from\s*"lucide-react"/.test(
        readFileSync(file, "utf8"),
      ),
    );
    expect(own.map((file) => relative(ROOT, file))).toEqual([]);
  });

  it("the mood page adds through SubPageAddButton", () => {
    const source = readFileSync(join(INSIGHTS, "mood/page-client.tsx"), "utf8");
    expect(source).toContain("<SubPageAddButton");
    expect(source).toContain("headerAction=");
  });

  it("the workouts page, a domain page, adds through PageAddButton", () => {
    // Domain page template: the filled add on a wide screen, the tab bar's
    // plus on a phone (`captureKindForPath`), beside the one wrench.
    const source = readFileSync(
      join(INSIGHTS, "workouts/page-client.tsx"),
      "utf8",
    );
    expect(source).toContain("<PageAddButton");
    expect(source).toContain("<PageCustomizeButton");
    expect(source).not.toContain("<SubPageAddButton");
  });

  it("the mood page has no text links into logging or the check-in", () => {
    const source = readSource(
      "src/app/insights/mood/page-client.tsx",
      "<SubPageAddButton",
    );
    expect(source).not.toMatch(/<Link\s+href="\/mood"\s+data-slot/);
    expect(source).not.toContain('href="/mental-wellbeing"');
    expect(source).not.toContain("insights.mood.mentalWellbeingLink");
  });
});
