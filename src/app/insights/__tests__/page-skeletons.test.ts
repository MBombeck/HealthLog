import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * v1.4.43 W11 — insights mother-page dynamic-skeleton guards.
 *
 * The three `next/dynamic` loading placeholders for
 * `DailyBriefing` / `CorrelationRow` / `TrendsRow` used to reserve
 * heights (`h-48` / `h-32` / `h-64`) noticeably shorter than the
 * loaded content (~24 rem / ~20 rem each), which CLS-shifted the
 * page on slow networks. They also lacked `motion-reduce:animate-none`,
 * so motion-sensitive users saw a continuous pulse.
 *
 * This textual guard pins both the larger reserved heights and the
 * motion-reduce class. The check is intentionally simple — render-
 * mounting the page would haul in TanStack-Query / Auth / I18n
 * scaffolding for a property a substring search already proves.
 */
describe("insights mother-page dynamic-skeleton heights + motion-reduce", () => {
  const src = readFileSync(
    join(process.cwd(), "src/app/insights/page.tsx"),
    "utf8",
  );

  it("DailyBriefing skeleton reserves h-[24rem]", () => {
    expect(src).toMatch(
      /DailyBriefing[\s\S]*?h-\[24rem\][^"]*motion-reduce:animate-none/,
    );
  });

  it("CorrelationRow skeleton reserves h-[20rem]", () => {
    expect(src).toMatch(
      /CorrelationRow[\s\S]*?h-\[20rem\][^"]*motion-reduce:animate-none/,
    );
  });

  it("TrendsRow skeleton reserves h-[20rem]", () => {
    expect(src).toMatch(
      /TrendsRow[\s\S]*?h-\[20rem\][^"]*motion-reduce:animate-none/,
    );
  });

  it("no insights-page skeleton falls back to the legacy h-48/h-32/h-64 trio", () => {
    // The legacy classes shouldn't be reintroduced on the mother
    // page's three loading placeholders.
    const dynamicBlock = src.match(/const DailyBriefing[\s\S]*?const TrendsRow[\s\S]*?\);\n/);
    expect(dynamicBlock).not.toBeNull();
    const block = dynamicBlock?.[0] ?? "";
    expect(block).not.toMatch(/"[^"]*\bh-48\b[^"]*"/);
    expect(block).not.toMatch(/"[^"]*\bh-32\b[^"]*"/);
    expect(block).not.toMatch(/"[^"]*\bh-64\b[^"]*"/);
  });
});
