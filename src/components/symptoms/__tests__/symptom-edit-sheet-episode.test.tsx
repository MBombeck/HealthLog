/**
 * The occurrence edit sheet carries the illness link (#1237).
 *
 * Before the fix the sheet held the time, the intensity and the note, and no
 * link at all: an occurrence filed against an illness opened without any sign
 * of it, and the link could not be changed once logged.
 *
 * Mutation checks (each run, each seen red):
 *   - remove `<EpisodeLinkField>` from the sheet → "opens with the illness the
 *     occurrence is filed against" goes red;
 *   - drop `keepId` from `linkableEpisodes` → "keeps offering the episode it is
 *     filed against" goes red (the link vanishes once the time no longer fits);
 *   - offer only open episodes → "offers a resolved episode the occurrence
 *     happened during" goes red.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { SymptomEventDTO } from "@/lib/symptoms/shared";

const state = vi.hoisted(() => ({
  episodes: [] as Array<{
    id: string;
    label: string;
    onsetAt: string;
    resolvedAt: string | null;
  }>,
}));

vi.mock("@/components/illness/use-illness", () => ({
  useIllnessEpisodes: () => ({ data: state.episodes, isLoading: false }),
}));

vi.mock("../use-symptoms", () => ({
  useUpdateSymptomEvent: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateSymptomDefinition: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

// The sheet portals; render its body inline.
vi.mock("@/components/ui/responsive-sheet", () => ({
  ResponsiveSheet: ({ children }: { children: React.ReactNode }) => (
    <div data-slot="mock-responsive-sheet">{children}</div>
  ),
}));

// Radix Select shows its value only after mount; a plain stand-in exposes
// the chosen value and the offered items to static markup.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    children,
  }: {
    value: string;
    children: React.ReactNode;
  }) => <div data-selected={value}>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <ul>{children}</ul>
  ),
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children: React.ReactNode;
  }) => <li data-option={value}>{children}</li>,
}));

import { I18nProvider } from "@/lib/i18n/context";
import { EditSymptomEventSheet } from "../symptom-edit-sheets";
import { effectiveEpisodeId, linkableEpisodes } from "../episode-link-field";

const COLD = {
  id: "cold",
  label: "Cold",
  onsetAt: "2026-08-01T00:00:00.000Z",
  resolvedAt: "2026-08-08T23:00:00.000Z",
};
const MIGRAINE = {
  id: "migraine",
  label: "Migraine",
  onsetAt: "2026-01-01T00:00:00.000Z",
  resolvedAt: null,
};
const FLU = {
  id: "flu",
  label: "Flu",
  onsetAt: "2026-03-01T00:00:00.000Z",
  resolvedAt: "2026-03-10T00:00:00.000Z",
};

function occurrence(
  occurredAt: string,
  episodeId: string | null,
): SymptomEventDTO {
  return {
    id: "ev1",
    definitionId: "aura",
    occurredAt,
    intensity: 4,
    note: null,
    episodeId,
    endAt: null,
    source: "MANUAL",
    externalId: null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

function render(event: SymptomEventDTO): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <EditSymptomEventSheet event={event} label="Aura" onClose={() => {}} />
    </I18nProvider>,
  );
}

describe("<EditSymptomEventSheet> illness link", () => {
  it("opens with the illness the occurrence is filed against", () => {
    state.episodes = [MIGRAINE, COLD];
    const html = render(occurrence("2026-08-05T09:00:00.000Z", "cold"));
    expect(html).toContain('for="symptom-event-episode"');
    expect(html).toContain('data-selected="cold"');
    expect(html).toContain('data-option="none"');
  });

  it("offers a resolved episode the occurrence happened during, and not one it did not", () => {
    state.episodes = [MIGRAINE, COLD, FLU];
    const html = render(occurrence("2026-08-05T09:00:00.000Z", null));
    expect(html).toContain('data-selected="none"');
    expect(html).toContain('data-option="cold"');
    expect(html).toContain('data-option="migraine"');
    expect(html).not.toContain('data-option="flu"');
  });

  it("keeps offering the episode it is filed against, even outside its span", () => {
    // Filed with the flu, then the flu's recovery date was moved earlier: the
    // server keeps the unchanged link, so the sheet shows it.
    state.episodes = [MIGRAINE, FLU];
    const html = render(occurrence("2026-03-20T09:00:00.000Z", "flu"));
    expect(html).toContain('data-selected="flu"');
    expect(html).toContain('data-option="flu"');
  });
});

describe("linkableEpisodes / effectiveEpisodeId", () => {
  it("admits open episodes and resolved ones whose span holds the time", () => {
    const ids = (at: string, keep: string | null = null) =>
      linkableEpisodes([MIGRAINE, COLD, FLU], at, keep).map((e) => e.id);
    expect(ids("2026-08-05T09:00")).toEqual(["migraine", "cold"]);
    expect(ids("2026-09-01T09:00")).toEqual(["migraine"]);
    // Before the cold began: not the cold's.
    expect(ids("2026-07-31T09:00")).toEqual(["migraine"]);
    expect(ids("2026-09-01T09:00", "flu")).toEqual(["migraine", "flu"]);
    expect(ids("not a time")).toEqual([]);
  });

  it("drops a choice the time has moved away from", () => {
    const options = linkableEpisodes([MIGRAINE, COLD], "2026-09-01T09:00");
    expect(effectiveEpisodeId("cold", options)).toBeNull();
    expect(effectiveEpisodeId("migraine", options)).toBe("migraine");
    expect(effectiveEpisodeId(null, options)).toBeNull();
  });
});
