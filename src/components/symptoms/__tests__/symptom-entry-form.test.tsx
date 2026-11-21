/**
 * The symptom quick-entry form (v1.40): the person's symptoms as chips with
 * the inline "add" chip beside them, the 0-10 slider, and the "during" episode
 * selector whenever an episode ran at the chosen time.
 *
 * Mutation checks (each run, each seen red):
 *   - offer every episode instead of `linkableEpisodes(...)` → "offers no
 *     episode selector when every episode ended before the chosen time" goes
 *     red;
 *   - offer only open episodes (the pre-#1237 filter) → "offers a resolved
 *     episode that ran on the chosen day" goes red;
 *   - render the add chip unconditionally → "a delegate who may log but not
 *     manage gets no add chip" goes red;
 *   - offer the filter field at any length → "offers no filter on a short
 *     row" goes red; never offer it → "offers a filter once the row is long,
 *     and keeps every chip until something is typed" goes red;
 *   - drop the `definitions.isError` branch → "a failed read shows the error
 *     row, not the empty hint" goes red (the empty hint renders instead).
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const state = vi.hoisted(() => ({
  canManage: true,
  definitionsFailed: false,
  /** Further symptoms after Aura and Headache, to grow the chip row. */
  extra: 0,
  episodes: [] as Array<{
    id: string;
    label: string;
    onsetAt: string;
    resolvedAt: string | null;
  }>,
}));

vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({
    canManageDomain: () => state.canManage,
    canWriteDomain: () => true,
  }),
  useActiveRecordName: () => null,
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({}),
}));

vi.mock("@/components/illness/use-illness", () => ({
  useIllnessEpisodes: () => ({ data: state.episodes, isLoading: false }),
}));

vi.mock("../use-symptoms", () => ({
  useSymptomDefinitions: () =>
    state.definitionsFailed
      ? { isLoading: false, isError: true, data: undefined, refetch: vi.fn() }
      : {
          isLoading: false,
          isError: false,
          data: {
            limit: 30,
            definitions: [
              {
                id: "d1",
                label: "Aura",
                icon: "Zap",
                sortOrder: 0,
                isActive: true,
                code: null,
                recent: {
                  count30d: 0,
                  maxIntensity30d: null,
                  lastOccurredAt: null,
                },
              },
              {
                id: "d2",
                label: "Headache",
                icon: "Brain",
                sortOrder: 1,
                isActive: true,
                code: null,
                recent: {
                  count30d: 0,
                  maxIntensity30d: null,
                  lastOccurredAt: null,
                },
              },
              ...Array.from({ length: state.extra }, (_, i) => ({
                id: `x${i}`,
                label: `Extra ${i}`,
                icon: "Tag",
                sortOrder: 2 + i,
                isActive: true,
                code: null,
                recent: {
                  count30d: 0,
                  maxIntensity30d: null,
                  lastOccurredAt: null,
                },
              })),
            ],
          },
        },
  useLogSymptomEvents: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useLatestSymptomIntensities: () => new Map(),
  invalidateSymptomReads: vi.fn(),
  SymptomSaveError: class extends Error {},
  useCreateSymptomDefinition: () => ({
    mutateAsync: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { SymptomEntryForm } from "../symptom-entry-form";

function render(defaultDate?: string): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <SymptomEntryForm defaultDate={defaultDate} />
    </I18nProvider>,
  );
}

describe("<SymptomEntryForm>", () => {
  it("lists the person's symptoms as chips, nothing chosen, with the add chip", () => {
    state.canManage = true;
    state.episodes = [];
    const html = render();
    expect(html.match(/data-testid="symptom-chip"/g)).toHaveLength(2);
    expect(html).toContain("Aura");
    expect(html).toContain("Headache");
    expect(html).not.toContain('aria-checked="true"');
    // Several may be picked: each chip is a checkbox in a group.
    expect(html).toContain('role="checkbox"');
    expect(html).toContain("Pick several if they came together.");
    expect(html).toContain('data-testid="symptom-add-chip"');
    // The intensity is a slider on the 0-10 scale.
    expect(html).toContain('data-slot="slider-field"');
    expect(html).toContain('aria-valuemax="10"');
  });

  it("a delegate who may log but not manage gets no add chip", () => {
    state.canManage = false;
    expect(render()).not.toContain('data-testid="symptom-add-chip"');
  });

  it("offers the episode selector only while an episode is open", () => {
    state.canManage = true;
    state.episodes = [
      {
        id: "e1",
        label: "Migraine",
        onsetAt: "2026-01-01T00:00:00.000Z",
        resolvedAt: null,
      },
    ];
    expect(render()).toContain("-episode");
  });

  it("offers no episode selector when every episode ended before the chosen time", () => {
    state.episodes = [
      {
        id: "e1",
        label: "Cold",
        onsetAt: "2026-08-01T00:00:00.000Z",
        resolvedAt: "2026-08-08T00:00:00.000Z",
      },
    ];
    expect(render()).not.toContain("-episode");
  });

  it("offers a resolved episode that ran on the chosen day", () => {
    // Opened from a day inside the episode: what happened then belongs to it.
    state.episodes = [
      {
        id: "e1",
        label: "Cold",
        onsetAt: "2026-08-01T00:00:00.000Z",
        resolvedAt: "2026-08-08T23:00:00.000Z",
      },
    ];
    expect(render("2026-08-05")).toContain("-episode");
  });

  it("a failed read shows the error row, not the empty hint", () => {
    state.canManage = true;
    state.episodes = [];
    state.definitionsFailed = true;
    try {
      const html = render();
      expect(html).toContain('data-slot="query-error-row"');
      expect(html).toContain("load your symptoms");
      expect(html).not.toContain("first symptom");
      expect(html).not.toContain('data-testid="symptom-add-chip"');
    } finally {
      state.definitionsFailed = false;
    }
  });

  it("offers no filter on a short row", () => {
    state.canManage = true;
    state.extra = 0;
    expect(render()).not.toContain('data-testid="symptom-chip-filter"');
  });

  it("offers a filter once the row is long, and keeps every chip until something is typed", () => {
    state.canManage = true;
    state.extra = 28;
    try {
      const html = render();
      expect(html).toContain('data-testid="symptom-chip-filter"');
      expect(html).toContain('placeholder="Find a symptom"');
      expect(html.match(/data-testid="symptom-chip"/g)).toHaveLength(30);
      // Thirty named symptoms is the cap: no add chip, and the hint names it.
      expect(html).not.toContain('data-testid="symptom-add-chip"');
      expect(html).toContain("Up to 30 symptoms.");
    } finally {
      state.extra = 0;
    }
  });
});
