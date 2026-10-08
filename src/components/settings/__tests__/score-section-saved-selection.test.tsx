/**
 * What the score settings page does with a selection that is already
 * stored, and what it puts on the wire when you press Save.
 *
 * The v1.35.0 defect this pins the fix for: the page filtered the
 * selection on its way to the server, so the answer that came back could
 * never match the form that sent it. The switches then re-seeded from the
 * server's narrower list — a pillar the person had never touched read as
 * switched off — and the draft could never equal the server copy again,
 * which left Save lit and the card claiming unsaved changes forever.
 *
 * Two ends and the pipe between them:
 *
 *   - the rows a stored selection renders (`data-counts` per pillar),
 *   - the state of the Save button, which is the whole "did this settle"
 *     question in one attribute,
 *   - the body the mutation actually hands to `apiPatch`, driven through
 *     the component's own `mutationFn` rather than restated here.
 *
 * SSR markup, matching the rest of the settings suite. The draft re-seed
 * happens in render, so a static render is enough to see it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  SCORE_PILLAR_IDS,
  type ScorePillarId,
} from "@/lib/analytics/score/types";

const ALL: ScorePillarId[] = [...SCORE_PILLAR_IDS];

/** The resolved config the page's primary read returns. */
const configState: { pillars: ScorePillarId[] } = { pillars: [...ALL] };

/** Every `mutationFn` the component registered, newest last. */
const mutationFns: Array<(input: never) => unknown> = [];

const apiPatch = vi.fn(async () => ({ pillars: configState.pillars }));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    // The factory's key, not a guess: `queryKeys.healthScoreConfig()`.
    if (
      Array.isArray(queryKey) &&
      queryKey[0] === "settings" &&
      queryKey[1] === "health-score-config"
    ) {
      return {
        data: {
          pillars: configState.pillars,
          excludedPillars: ALL.filter(
            (id) => !configState.pillars.includes(id),
          ),
          hasSelection: true,
          version: 1,
          changedAt: null,
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
        isSuccess: true,
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      };
    }
    return {
      data: undefined,
      isSuccess: false,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
  },
  useMutation: (options: { mutationFn?: (input: never) => unknown }) => {
    if (options.mutationFn) mutationFns.push(options.mutationFn);
    return { mutate: vi.fn(), isPending: false };
  },
  useQueryClient: () => ({
    setQueryData: vi.fn(),
    getQueryData: vi.fn(),
    invalidateQueries: vi.fn(),
    isFetching: () => 0,
  }),
  // The section reveals once its reads settle; nothing is in flight here.
  useIsFetching: () => 0,
}));

vi.mock("sonner", () => ({
  toast: { message: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/components/outcome/outcome-toast", () => ({
  toastWrittenOutcome: vi.fn(),
}));

vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: (...args: unknown[]) =>
    (apiPatch as unknown as (...a: unknown[]) => unknown)(...args),
  ApiError: class ApiError extends Error {},
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false, user: {} }),
}));

vi.mock("@/lib/queries/use-analytics-query", () => ({
  useAnalyticsQuery: () => ({
    data: undefined,
    isError: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { ScoreSection } from "../score-section";

function render(): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <ScoreSection />
    </I18nProvider>,
  );
}

/** `data-counts` per pillar, read off the rendered rows. */
function countsByPillar(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of html.matchAll(
    /data-pillar="([A-Z_]+)"[^>]*data-counts="(true|false)"/g,
  )) {
    out[match[1]] = match[2];
  }
  return out;
}

function saveIsDisabled(html: string): boolean {
  const at = html.indexOf('data-slot="score-config-save"');
  expect(at, "save button is rendered").toBeGreaterThan(-1);
  const open = html.lastIndexOf("<button", at);
  return html.slice(open, html.indexOf(">", at)).includes("disabled=");
}

beforeEach(() => {
  configState.pillars = [...ALL];
  mutationFns.length = 0;
  apiPatch.mockClear();
});

describe("a selection that is already stored", () => {
  it("shows every pillar the person kept switched on, and only those", () => {
    configState.pillars = ALL.filter(
      (id) => id !== "SLEEP" && id !== "WELLBEING",
    );

    const counts = countsByPillar(render());

    expect(Object.keys(counts).sort()).toEqual([...ALL].sort());
    for (const id of ALL) {
      expect(counts[id], `${id} switch`).toBe(
        configState.pillars.includes(id) ? "true" : "false",
      );
    }
  });

  it("has nothing to save the moment it loads", () => {
    configState.pillars = ALL.filter((id) => id !== "SLEEP");

    expect(saveIsDisabled(render())).toBe(true);
  });

  it("settles on the every-pillar starting point too", () => {
    // "All pillars" has to be a selection the page can hold: if the save
    // silently narrowed it, the form would come back different from the
    // list it sent and never read as saved again.
    configState.pillars = [...ALL];
    const html = render();

    expect(Object.values(countsByPillar(html))).toEqual(ALL.map(() => "true"));
    expect(saveIsDisabled(html)).toBe(true);
  });
});

describe("what the save puts on the wire", () => {
  it("sends the selection unchanged, pillar for pillar", async () => {
    render();
    const save = mutationFns[0];
    expect(save, "the save mutation registered a mutationFn").toBeTypeOf(
      "function",
    );

    await (save as (input: ScorePillarId[]) => unknown)([...ALL]);

    expect(apiPatch).toHaveBeenCalledTimes(1);
    const [path, body] = apiPatch.mock.calls[0] as unknown as [
      string,
      { pillars: ScorePillarId[] },
    ];
    expect(path).toBe("/api/auth/me/health-score-config");
    expect(body.pillars).toEqual(ALL);
  });

  it("puts the selection in registry order whatever order it arrives in", async () => {
    render();
    const save = mutationFns[0] as (input: ScorePillarId[]) => unknown;

    await save(["LIPIDS", "ACTIVITY", "BLOOD_PRESSURE"]);

    const [, body] = apiPatch.mock.calls[0] as unknown as [
      string,
      { pillars: ScorePillarId[] },
    ];
    expect(body.pillars).toEqual(["BLOOD_PRESSURE", "ACTIVITY", "LIPIDS"]);
  });
});
