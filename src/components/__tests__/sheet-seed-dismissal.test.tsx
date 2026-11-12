import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Edit sheets open filled, so "the body has input" says nothing about them:
 * each compares its fields with what it opened with and hands that to the
 * sheet's dismissal guard. Opened and untouched, every one of them says
 * "nothing to lose", so a tap outside closes it without asking; a sheet the
 * guard was never wired to passes nothing at all.
 */

const sheets: unknown[] = [];

vi.mock("@/components/ui/responsive-sheet", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/ui/responsive-sheet")
  >()),
  ResponsiveSheet: (props: { dirty?: unknown; children?: ReactNode }) => {
    sheets.push(props.dirty);
    return <>{props.children}</>;
  },
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true, user: { modules: {} } }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { NewEpisodeSheet } from "@/components/illness/new-episode-sheet";
import { TagEditorSheet } from "@/components/mood/manage/tag-editor-sheet";
import {
  EditSymptomDefinitionSheet,
  EditSymptomEventSheet,
} from "@/components/symptoms/symptom-edit-sheets";
import { TargetEditSheet } from "@/components/targets/target-edit-sheet";
import { LifeEventSheet } from "@/components/timeline/life-event-sheet";

function dirtyOf(node: ReactNode): unknown {
  sheets.length = 0;
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
  return sheets[0];
}

const noop = () => {};

beforeEach(() => {
  sheets.length = 0;
});

describe("seeded edit sheets and the dismissal guard", () => {
  it.each([
    [
      "an illness episode",
      <NewEpisodeSheet
        key="episode"
        open
        onOpenChange={noop}
        today="2026-11-10"
        editEpisode={{
          id: "ep-1",
          label: "Cold",
          type: "INFECTION",
          lifecycle: "ACUTE",
          onsetAt: "2026-11-01T12:00:00.000Z",
          resolvedAt: null,
          parentConditionId: null,
          note: "Started on the train",
          bodySite: null,
          laterality: null,
          createdAt: "2026-11-01T12:00:00.000Z",
          updatedAt: "2026-11-01T12:00:00.000Z",
        }}
      />,
    ],
    [
      "a new illness episode",
      <NewEpisodeSheet
        key="new-episode"
        open
        onOpenChange={noop}
        today="2026-11-10"
      />,
    ],
    [
      "a mood tag",
      <TagEditorSheet
        key="tag"
        open
        onOpenChange={noop}
        groups={[{ key: "custom", name: "Custom" }]}
        tag={{ key: "c-1", label: "Garden", icon: "Leaf", groupKey: "custom" }}
      />,
    ],
    [
      "a symptom occurrence",
      <EditSymptomEventSheet
        key="symptom-event"
        label="Headache"
        onClose={noop}
        event={{
          id: "se-1",
          definitionId: "sd-1",
          occurredAt: "2026-11-09T08:30:00.000Z",
          intensity: 6,
          note: "After screen time",
          episodeId: null,
          createdAt: "2026-11-09T08:30:00.000Z",
          updatedAt: "2026-11-09T08:30:00.000Z",
        }}
      />,
    ],
    [
      "a symptom",
      <EditSymptomDefinitionSheet
        key="symptom"
        onClose={noop}
        definition={{
          id: "sd-1",
          label: "Headache",
          icon: "Brain",
          sortOrder: 0,
          isActive: true,
          recent: { count30d: 1, maxIntensity30d: 6, lastOccurredAt: null },
        }}
      />,
    ],
    [
      "a target",
      <TargetEditSheet
        key="target"
        open
        onOpenChange={noop}
        targetType="WEIGHT"
        targetLabel="Weight"
        unit="kg"
        initialRange={{ min: 70, max: 80 }}
      />,
    ],
    [
      "a life event",
      <LifeEventSheet key="life-event" open onOpenChange={noop} event={null} />,
    ],
  ])("%s opens with nothing to lose", (_name, node) => {
    expect(dirtyOf(node)).toBe(false);
  });
});
