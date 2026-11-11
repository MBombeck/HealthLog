/**
 * Every episode in the journal stays reachable from the illness page.
 *
 * A recurring bout filed under its condition nests inside that condition's
 * card. The list view drew no nested episodes at all, so an ended recurring
 * bout of an ended condition (both in "Resolved") had no row anywhere and was
 * found only through search; a bout nested under an already-nested parent was
 * lost in either view.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { IllnessEpisodeDTO } from "../types";

const state = vi.hoisted(() => ({
  episodes: [] as unknown[],
  view: "list" as "list" | "cards",
}));

vi.mock("../use-illness", () => ({
  useIllnessEpisodes: () => ({
    data: state.episodes,
    isLoading: false,
    isError: false,
    refetch: () => {},
  }),
  useResolveEpisode: () => ({ isPending: false, mutate: () => {} }),
}));

vi.mock("@/lib/module-list-prefs", () => ({
  useModuleListPrefs: () => ({ prefs: { view: state.view, order: [] } }),
  applyOrder: <T,>(items: T[]) => items,
}));

vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({
    canWriteDomain: () => true,
    canManageDomain: () => false,
    inSharedRecord: false,
  }),
}));

vi.mock("../illness-insights-card", () => ({
  IllnessInsightsCard: () => null,
}));
vi.mock("@/components/symptoms/symptoms-section", () => ({
  SymptomsSection: () => null,
}));
vi.mock("../new-episode-sheet", () => ({ NewEpisodeSheet: () => null }));
vi.mock("../log-day-sheet", () => ({
  LogDaySheet: () => null,
  useLastLoggableDay: (today: string) => today,
}));
vi.mock("@/components/day/day-link", () => ({
  DAY_LINK_SLOT: "{date}",
  DayLinkStated: ({ children }: { children: React.ReactNode }) => children,
  withDayLinkSlot: (text: string, node: React.ReactNode) => [text, node],
}));

import { I18nProvider } from "@/lib/i18n/context";
import { groupEpisodes } from "../group-episodes";
import { IllnessView } from "../illness-view";

function episode(over: Partial<IllnessEpisodeDTO>): IllnessEpisodeDTO {
  return {
    id: "e",
    label: "Episode",
    type: "CHRONIC",
    lifecycle: "ACUTE",
    onsetAt: "2026-10-08T12:00:00.000Z",
    resolvedAt: null,
    parentConditionId: null,
    note: null,
    bodySite: null,
    laterality: null,
    createdAt: "2026-10-08T12:00:00.000Z",
    updatedAt: "2026-10-08T12:00:00.000Z",
    ...over,
  };
}

function render(): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <IllnessView />
    </I18nProvider>,
  );
}

const condition = episode({
  id: "cond",
  label: "Back pain",
  lifecycle: "CHRONIC_ONGOING",
});
const bout = episode({
  id: "bout",
  label: "Back pain bout",
  lifecycle: "RECURRING",
  parentConditionId: "cond",
});

describe("illness page nesting", () => {
  it.each(["list", "cards"] as const)(
    "shows a recurring bout inside its condition in the %s view",
    (view) => {
      state.view = view;
      state.episodes = [condition, bout];
      const html = render();
      expect(html).toContain("Back pain bout");
      expect(html).toContain('href="/illness/bout"');
      // A recurring bout is named as one, not counted as a flare.
      expect(html).toContain("Recurring");
      expect(html).not.toContain("1 flare");
    },
  );

  it("places every episode exactly once, ended recurring bouts included", () => {
    const resolvedCondition = episode({
      id: "old",
      label: "Prostatitis",
      resolvedAt: "2023-05-04T12:00:00.000Z",
    });
    const endedBout = episode({
      id: "ended",
      label: "Ended bout",
      lifecycle: "RECURRING",
      parentConditionId: "old",
      resolvedAt: "2026-10-14T12:00:00.000Z",
    });
    const flareOfBout = episode({
      id: "flare",
      label: "Flare of the bout",
      lifecycle: "FLARE",
      parentConditionId: "ended",
      resolvedAt: "2026-10-12T12:00:00.000Z",
    });
    const activeBoutOfEnded = episode({
      id: "again",
      label: "Back again",
      lifecycle: "RECURRING",
      parentConditionId: "old",
    });
    const loopA = episode({ id: "a", parentConditionId: "b" });
    const loopB = episode({ id: "b", parentConditionId: "a" });
    const list = [
      resolvedCondition,
      endedBout,
      flareOfBout,
      activeBoutOfEnded,
      loopA,
      loopB,
    ];

    const grouped = groupEpisodes(list);
    const placed = [
      ...grouped.activeParents,
      ...grouped.resolvedParents,
      ...[...grouped.childrenByParent.values()].flat(),
    ].map((e) => e.id);
    expect(placed.sort()).toEqual(list.map((e) => e.id).sort());

    const shownCards = new Set(
      [...grouped.activeParents, ...grouped.resolvedParents].map((e) => e.id),
    );
    // Every nested episode hangs off a card that is itself shown.
    for (const parentId of grouped.childrenByParent.keys()) {
      expect(shownCards.has(parentId)).toBe(true);
    }
    // The ended bout and the flare under it both sit in the ended
    // condition's card; the still-running bout is a card of its own.
    expect(grouped.childrenByParent.get("old")?.map((e) => e.id)).toEqual([
      "ended",
      "flare",
    ]);
    expect(grouped.activeParents.map((e) => e.id)).toContain("again");
  });
});
