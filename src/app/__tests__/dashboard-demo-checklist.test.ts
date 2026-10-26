import { describe, it, expect } from "vitest";
import { dashboardSource } from "@/__tests__/helpers/dashboard-source";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The setup checklist on a demo instance.
 *
 * The demo is one shared, read-only account carrying onboarding answers, so
 * `isStillInSetup` keeps the checklist on screen for every visitor although
 * none of its rows can be done there. The shell already leaves out the tour
 * under `DEMO_MODE`; the dashboard leaves out the checklist the same way.
 * Pinned here: every render path of the page threads the flag, and the
 * client mounts the checklist only without it.
 */
const PAGE_PATH = join(process.cwd(), "src/app/page.tsx");

describe("dashboard setup checklist on a demo instance", () => {
  it("threads DEMO_MODE into every render of the dashboard client", () => {
    const src = readFileSync(PAGE_PATH, "utf8");
    expect(src).toContain('process.env.DEMO_MODE === "true"');
    const renders = src.match(/<DashboardPageClient\b[^>]*>/g) ?? [];
    expect(renders.length).toBeGreaterThan(0);
    for (const render of renders) {
      expect(render).toContain("demoMode={demoMode}");
    }
  });

  it("mounts the checklist only outside demo mode", () => {
    const src = dashboardSource();
    const mounts = src.match(/<GettingStartedChecklist\b[^>]*\/>/g) ?? [];
    expect(mounts).toHaveLength(1);
    expect(src).toContain("{demoMode ? null : <GettingStartedChecklist />}");
  });
});
