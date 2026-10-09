import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { DAY_SCORE_HREF } from "@/lib/day/contract";

/**
 * v1.42 — `/insights/health-score`: the health score over time, reached from
 * the score panel and from the day view's score tile.
 */

vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/insights/sub-page-shell", () => ({
  SubPageShell: ({
    title,
    backLink,
    children,
  }: {
    title: string;
    backLink: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <div data-slot="shell-probe" data-title={title}>
      {backLink}
      {children}
    </div>
  ),
}));

vi.mock("@/components/ui/back-link", () => ({
  BackLink: ({ href }: { href: string }) => (
    <a data-slot="back-probe" href={href} />
  ),
}));

vi.mock("@/components/insights/derived/score-history", () => ({
  ScoreTrendChartDynamic: ({
    score,
    chartKey,
    label,
  }: {
    score: string;
    chartKey: string;
    label: string;
  }) => (
    <div
      data-slot="trend-probe"
      data-score={score}
      data-chart-key={chartKey}
      data-label={label}
    />
  ),
}));

import HealthScoreHistoryPage from "../page";

describe("/insights/health-score", () => {
  it("charts the health score's history under its own range slot", () => {
    const html = renderToStaticMarkup(<HealthScoreHistoryPage />);
    expect(html).toContain('data-title="insights.scoreHistory.healthTitle"');
    expect(html).toContain(
      'data-slot="trend-probe" data-score="HEALTH_SCORE" data-chart-key="scoreHealth" data-label="insights.healthScore.label"',
    );
    expect(html).toContain('href="/insights"');
  });

  it("is where the day view's health-score tile opens", () => {
    expect(DAY_SCORE_HREF.healthScore).toBe("/insights/health-score");
  });

  it("every score tile in the day view opens a page that exists", () => {
    const app = join(__dirname, "..", "..", "..");
    for (const href of Object.values(DAY_SCORE_HREF)) {
      const segments = href.split("/").filter(Boolean);
      const direct = join(app, ...segments, "page.tsx");
      const dynamic = join(
        app,
        ...segments.slice(0, -1),
        "[metric]",
        "page.tsx",
      );
      expect(existsSync(direct) || existsSync(dynamic), href).toBe(true);
    }
  });
});
