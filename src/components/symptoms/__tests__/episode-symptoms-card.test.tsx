/**
 * The "Symptoms logged" card on an illness episode's detail page (#1237).
 *
 * An occurrence belongs to an episode when it is filed against it
 * (`SymptomEvent.episodeId`), not when it merely happened while the episode
 * ran. Before the fix the card also read every occurrence inside the
 * episode's onset-to-recovery span, so a long-running condition listed the
 * symptoms of every illness overlapping it and the person's choice in the
 * "during" selector changed nothing on the page.
 *
 * Mutation checks (each run, each seen red):
 *   - read the span as well and merge it in (the pre-fix card) → "lists only
 *     the occurrences filed against this episode" goes red (the unrelated
 *     headache shows);
 *   - drop the `episodeId === episode.id` guard → "never shows another
 *     episode's occurrence" goes red.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { SymptomEventDTO } from "@/lib/symptoms/shared";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ from: string; to: string; episodeId: string | null }>,
  filed: [] as SymptomEventDTO[],
  everything: [] as SymptomEventDTO[],
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { timezone: "Europe/Berlin" } }),
}));

vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({ canManageDomain: () => false }),
}));

vi.mock("../use-symptoms", () => ({
  useSymptomDefinitions: () => ({
    isError: false,
    refetch: vi.fn(),
    data: {
      limit: 8,
      definitions: [
        { id: "aura", label: "Aura", icon: "Zap", isActive: true },
        { id: "headache", label: "Headache", icon: "Brain", isActive: true },
      ],
    },
  }),
  // The route narrows by `episodeId` when one is given; without one it
  // answers everything inside the window, like the real one.
  useSymptomEvents: (
    from: string,
    to: string,
    options: { episodeId?: string | null } = {},
  ) => {
    const episodeId = options.episodeId ?? null;
    state.calls.push({ from, to, episodeId });
    return {
      isError: false,
      refetch: vi.fn(),
      data: {
        events: episodeId ? state.filed : state.everything,
        limit: 500,
        hasMore: false,
      },
    };
  },
  useDeleteSymptomEvent: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { EpisodeSymptomsCard } from "../episode-symptoms-card";

function event(
  id: string,
  definitionId: string,
  episodeId: string | null,
): SymptomEventDTO {
  return {
    id,
    definitionId,
    occurredAt: "2026-10-10T09:00:00.000Z",
    intensity: 5,
    note: null,
    episodeId,
    endAt: null,
    source: "MANUAL",
    externalId: null,
    createdAt: "2026-10-10T09:00:00.000Z",
    updatedAt: "2026-10-10T09:00:00.000Z",
  };
}

function render(): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <EpisodeSymptomsCard episode={{ id: "migraine" }} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  state.calls = [];
});

describe("<EpisodeSymptomsCard>", () => {
  it("lists only the occurrences filed against this episode", () => {
    // A chronic migraine runs all year; a cold overlaps it. The aura is filed
    // with the migraine, the headache with the cold, on the same morning.
    const aura = event("e-aura", "aura", "migraine");
    const headache = event("e-headache", "headache", "cold");
    state.filed = [aura];
    state.everything = [aura, headache];

    const html = render();
    expect(html).toContain("Aura");
    expect(html).not.toContain("Headache");
    // Every read the card makes is narrowed to the link.
    expect(state.calls.length).toBeGreaterThan(0);
    expect(state.calls.every((c) => c.episodeId === "migraine")).toBe(true);
  });

  it("never shows another episode's occurrence, even if the answer holds one", () => {
    state.filed = [
      event("e-aura", "aura", "migraine"),
      event("e-headache", "headache", "cold"),
    ];
    state.everything = [];
    const html = render();
    expect(html).toContain("Aura");
    expect(html).not.toContain("Headache");
  });

  it("renders nothing when nothing is filed, however much happened meanwhile", () => {
    state.filed = [];
    state.everything = [
      event("e-headache", "headache", null),
      event("e-aura", "aura", "cold"),
    ];
    expect(render()).toBe("");
  });
});
