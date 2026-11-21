/**
 * `/seizures?event=<id>`, where the cluster push leads: the linked seizure
 * opens in the seizure sheet for a reader who may write, a reader who may not
 * only scrolls, and a seizure past the first twenty is on the page to scroll
 * to. The repo convention is static markup, so the deep-link hook is mocked
 * and opens the linked record during render, as the real one does after it.
 *
 * Mutation checks (each seen red): drop the hook call; pass `open` without the
 * `canLog` gate; start the list collapsed regardless of the link.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { SeizureEventDTO } from "@/lib/seizures/shared";

const state = vi.hoisted(() => ({
  canWrite: true,
  wanted: "e3" as string | null,
  events: [] as unknown[],
  hookArgs: null as null | Record<string, unknown>,
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () =>
    new URLSearchParams(state.wanted ? `event=${state.wanted}` : ""),
}));
vi.mock("@/hooks/use-deep-linked-record", () => ({
  useDeepLinkedRecord: (args: {
    records?: { id: string }[];
    open?: (r: { id: string }) => void;
  }) => {
    const first = state.hookArgs === null;
    state.hookArgs = args;
    const record = args.records?.find((r) => r.id === state.wanted);
    if (first && record) args.open?.(record);
  },
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "u1" } }),
}));
vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({
    canWriteDomain: () => state.canWrite,
    canManageDomain: () => false,
  }),
}));
vi.mock("../use-seizures", () => ({
  useSeizureDiary: () => ({
    isLoading: false,
    isError: false,
    data: {
      events: state.events,
      types: [],
      truncated: false,
      summary: { clusters: [] },
      settings: { rule: null, niceRule: null },
    },
  }),
}));
vi.mock("../quick-log-card", () => ({ QuickLogCard: () => null }));
vi.mock("../seizure-summary", () => ({ SeizureSummary: () => null }));
vi.mock("../cluster-rule-card", () => ({ ClusterRuleCard: () => null }));
vi.mock("../seizure-type-sheet", () => ({ SeizureTypeSheet: () => null }));
vi.mock("../seizure-sheet", () => ({
  SeizureSheet: ({ event }: { event: SeizureEventDTO | null }) => (
    <div data-testid="sheet" data-event={event?.id ?? "new"} />
  ),
}));

import { SeizuresView } from "../seizures-view";

function event(id: string): SeizureEventDTO {
  return {
    id,
    typeProfileId: null,
    count: 1,
    certainty: "CONFIRMED",
    rescueDoses: [],
    durationSec: null,
    durationSource: "MEASURED",
    onsetAt: "2026-11-18T10:00:00.000Z",
    sleepState: "UNKNOWN",
    loggedBy: "owner",
    loggedByViewer: false,
    loggedByName: null,
  } as unknown as SeizureEventDTO;
}

function render(opts: { canWrite: boolean; wanted: string; count?: number }) {
  state.canWrite = opts.canWrite;
  state.wanted = opts.wanted;
  state.hookArgs = null;
  state.events = Array.from({ length: opts.count ?? 5 }, (_, i) =>
    event(`e${i}`),
  );
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <SeizuresView />
    </I18nProvider>,
  );
}

describe("SeizuresView deep link", () => {
  it("opens the linked seizure in the sheet for a reader who may write", () => {
    const html = render({ canWrite: true, wanted: "e3" });
    expect(state.hookArgs).toMatchObject({
      param: "event",
      anchorAttribute: "data-seizure-id",
    });
    expect(html).toContain('data-seizure-id="e3"');
    expect(html).toContain('data-event="e3"');
  });

  it("only scrolls for a reader who may not write", () => {
    const html = render({ canWrite: false, wanted: "e3" });
    expect(state.hookArgs?.open).toBeUndefined();
    expect(html).not.toContain('data-testid="sheet"');
  });

  it("puts a linked seizure past the first twenty on the page", () => {
    const html = render({ canWrite: false, wanted: "e25", count: 30 });
    expect(html).toContain('data-seizure-id="e25"');
    expect(render({ canWrite: false, wanted: "e1", count: 30 })).not.toContain(
      'data-seizure-id="e25"',
    );
  });
});
