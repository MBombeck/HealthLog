import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { AchievementProgress } from "@/lib/gamification/achievements";

/**
 * v1.4.15 phase-B4 — `<RecentAchievementsCard>` contract.
 *
 *   1. `pickRecentUnlocks` — locked entries dropped, unlocked sorted by
 *      `completedAt` descending, capped at the requested limit. Pure.
 *   2. Card render — empty state shows the discovery CTA + link to
 *      `/achievements`; populated state shows the most recent N items
 *      with their localized title + completedAt date.
 */

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));

let mockData: {
  summary: unknown;
  achievements: AchievementProgress[];
  metrics: unknown;
} = {
  summary: {},
  achievements: [],
  metrics: {},
};

// v1.4.34 IW-F-Perf — the card now reads through the shared
// `useAchievementsQuery` hook; the test mocks the hook directly so the
// network layer + TanStack provider scaffolding stays out of scope.
vi.mock("@/lib/queries/use-achievements-query", () => ({
  useAchievementsQuery: () => ({ data: mockData }),
}));

import {
  RecentAchievementsCard,
  pickRecentUnlocks,
} from "../recent-achievements-card";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <RecentAchievementsCard />
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

const baseAchievement: AchievementProgress = {
  id: "intake-total-1",
  metric: "totalTakenIntakes",
  category: "medication",
  titleKey: "achievements.badges.intakeTotal1.title",
  descriptionKey: "achievements.badges.intakeTotal1.description",
  icon: "Pill",
  format: "count",
  target: 1,
  current: 1,
  points: 8,
  unlocked: true,
  progressPercent: 100,
  completedAt: "2026-04-15T12:00:00.000Z",
  isHidden: false,
};

describe("pickRecentUnlocks", () => {
  it("filters out locked entries", () => {
    const result = pickRecentUnlocks(
      [
        { ...baseAchievement, id: "a", unlocked: true },
        { ...baseAchievement, id: "b", unlocked: false },
      ],
      5,
    );
    expect(result.map((item) => item.id)).toEqual(["a"]);
  });

  it("sorts by completedAt descending and caps at the limit", () => {
    const result = pickRecentUnlocks(
      [
        {
          ...baseAchievement,
          id: "older",
          completedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          ...baseAchievement,
          id: "newer",
          completedAt: "2026-04-01T00:00:00.000Z",
        },
        {
          ...baseAchievement,
          id: "newest",
          completedAt: "2026-04-15T00:00:00.000Z",
        },
        {
          ...baseAchievement,
          id: "ancient",
          completedAt: "2025-12-01T00:00:00.000Z",
        },
      ],
      3,
    );
    expect(result.map((item) => item.id)).toEqual(["newest", "newer", "older"]);
  });

  it("places entries without completedAt at the bottom", () => {
    const result = pickRecentUnlocks(
      [
        { ...baseAchievement, id: "no-date", completedAt: null },
        {
          ...baseAchievement,
          id: "dated",
          completedAt: "2026-04-15T00:00:00.000Z",
        },
      ],
      5,
    );
    expect(result.map((item) => item.id)).toEqual(["dated", "no-date"]);
  });
});

describe("<RecentAchievementsCard>", () => {
  it("shows the empty-state CTA when no unlocks exist", () => {
    mockData = { summary: {}, achievements: [], metrics: {} };
    const html = render();
    expect(html).toContain("No achievements yet");
    // Link to /achievements so the user can discover the feature
    expect(html).toContain('href="/achievements"');
    expect(html).toContain("View all");
  });

  it("renders up to three most-recent unlocks with title + date", () => {
    mockData = {
      summary: {},
      achievements: [
        {
          ...baseAchievement,
          id: "a",
          completedAt: "2026-04-15T12:00:00.000Z",
        },
        {
          ...baseAchievement,
          id: "b",
          completedAt: "2026-04-10T12:00:00.000Z",
        },
        {
          ...baseAchievement,
          id: "c",
          completedAt: "2026-04-05T12:00:00.000Z",
        },
        {
          ...baseAchievement,
          id: "d",
          completedAt: "2026-04-01T12:00:00.000Z",
        },
      ],
      metrics: {},
    };
    const html = render();
    // Card title (always painted)
    expect(html).toContain("Recent unlocks");
    // Three "recent-achievement-item" slots — capped at the limit
    const matches = html.match(/data-slot="recent-achievement-item"/g) ?? [];
    expect(matches.length).toBe(3);
    // Empty-state copy must NOT appear once we have unlocks
    expect(html).not.toContain("No achievements yet");
  });
});
