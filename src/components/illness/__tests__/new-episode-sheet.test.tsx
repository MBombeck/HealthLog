/**
 * Focused component tests for `<NewEpisodeSheet>` edit hydration and
 * `<LogDaySheet>` onset bound timezone integration.
 *
 * Verifies that:
 * 1. Editing an episode hydrates the resolved date field to the user's calendar
 *    day in their display timezone when present.
 * 2. Episode detail passes the display-timezone-adjusted onset date to LogDaySheet
 *    (2026-11-10 instead of the previous .slice(0, 10) value 2026-11-09).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act, isValidElement, type Dispatch, type SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { I18nProvider } from "@/lib/i18n/context";
import type { IllnessEpisodeDTO } from "../types";

const originalDocument = globalThis.document;
beforeAll(() => {
  if (typeof globalThis.document === "undefined") {
    (globalThis as unknown as { document: unknown }).document = {
      documentElement: { lang: "en" },
      cookie: "",
    };
  }
});

afterAll(() => {
  if (originalDocument === undefined) {
    delete (globalThis as unknown as { document?: unknown }).document;
  } else {
    globalThis.document = originalDocument;
  }
});

let activeStore: {
  get: (initial: unknown) => [unknown, (next: unknown) => void];
  ref?: <T>(initial: T) => { current: T };
  effect?: (
    effect: () => void | (() => void),
    deps?: readonly unknown[],
  ) => void;
} | null = null;

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T,>(
      initial: T | (() => T),
    ): [T, Dispatch<SetStateAction<T>>] => {
      if (activeStore) {
        return activeStore.get(initial) as [T, Dispatch<SetStateAction<T>>];
      }
      return actual.useState(initial);
    },
    useRef: <T,>(initial: T): { current: T } => {
      if (activeStore?.ref) {
        return activeStore.ref(initial);
      }
      return actual.useRef(initial);
    },
    useEffect: (
      effect: () => void | (() => void),
      deps?: readonly unknown[],
    ) => {
      if (activeStore?.effect) {
        activeStore.effect(effect, deps);
        return;
      }
      return actual.useEffect(effect, deps);
    },
  };
});

const mockEpisodeInTokyo: IllnessEpisodeDTO = {
  id: "ep-tokyo-1",
  label: "Morning Headache",
  type: "OTHER",
  lifecycle: "ACUTE",
  onsetAt: "2026-11-09T23:30:00.000Z",
  resolvedAt: null,
  parentConditionId: null,
  note: null,
  bodySite: null,
  laterality: null,
  createdAt: "2026-11-09T23:30:00.000Z",
  updatedAt: "2026-11-09T23:30:00.000Z",
};

let mockDisplayTimezone = "Asia/Tokyo";

vi.mock("@/lib/i18n/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n/context")>();
  return {
    ...actual,
    useDisplayTimezone: () => mockDisplayTimezone,
  };
});

let capturedFooter: React.ReactNode = null;
let capturedChildren: React.ReactNode = null;
let capturedResponsiveSheetProps: {
  onOpenChange?: (open: boolean) => void;
} | null = null;
// ResponsiveSheet portals at runtime; render contents directly into markup when open.
vi.mock("@/components/ui/responsive-sheet", () => ({
  ResponsiveSheet: ({
    children,
    open,
    footer,
    onOpenChange,
  }: {
    children?: React.ReactNode;
    open?: boolean;
    footer?: React.ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => {
    capturedChildren = children;
    capturedFooter = footer;
    capturedResponsiveSheetProps = { onOpenChange };
    return open ? (
      <div data-slot="mock-responsive-sheet">
        {children}
        {footer}
      </div>
    ) : null;
  },
}));

const capturedLogDaySheet = vi.fn();
vi.mock("../log-day-sheet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../log-day-sheet")>();
  return {
    ...actual,
    LogDaySheet: (props: {
      onsetDate?: string;
      episodeId: string;
      date: string;
    }) => {
      capturedLogDaySheet(props);
      return (
        <div data-slot="mock-log-day-sheet" data-onset-date={props.onsetDate} />
      );
    },
  };
});

vi.mock("../illness-correlation-card", () => ({
  IllnessCorrelationCard: () => null,
}));
vi.mock("../illness-day-timeline", () => ({
  IllnessDayTimeline: () => null,
}));
vi.mock("@/components/records/related-records-card", () => ({
  RelatedRecordsCard: () => null,
}));

vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({
    canWriteDomain: () => true,
    canManageDomain: () => true,
    inSharedRecord: false,
    sections: [],
  }),
}));

const mockCreateMutateAsync = vi.fn().mockResolvedValue({});
const mockUpdateMutateAsync = vi.fn().mockResolvedValue({});

let mockCreateState = {
  isPending: false,
  isError: false,
};
let mockUpdateState = {
  isPending: false,
  isError: false,
};
const mockCreateReset = vi.fn(() => {
  mockCreateState.isPending = false;
  mockCreateState.isError = false;
});
const mockUpdateReset = vi.fn(() => {
  mockUpdateState.isPending = false;
  mockUpdateState.isError = false;
});

beforeEach(() => {
  mockDisplayTimezone = "Asia/Tokyo";
  mockCreateState = { isPending: false, isError: false };
  mockUpdateState = { isPending: false, isError: false };
  mockCreateMutateAsync.mockReset().mockResolvedValue({});
  mockUpdateMutateAsync.mockReset().mockResolvedValue({});
  mockCreateReset.mockClear();
  mockUpdateReset.mockClear();
});

vi.mock("../use-illness", () => ({
  useCreateEpisode: () => ({
    mutate: vi.fn(),
    mutateAsync: mockCreateMutateAsync,
    get isPending() {
      return mockCreateState.isPending;
    },
    get isError() {
      return mockCreateState.isError;
    },
    reset: mockCreateReset,
  }),
  useUpdateEpisode: () => ({
    mutate: vi.fn(),
    mutateAsync: mockUpdateMutateAsync,
    get isPending() {
      return mockUpdateState.isPending;
    },
    get isError() {
      return mockUpdateState.isError;
    },
    reset: mockUpdateReset,
  }),
  useIllnessEpisodes: () => ({
    data: [],
    isLoading: false,
    isError: false,
  }),
  useIllnessEpisode: () => ({
    data: mockEpisodeInTokyo,
    isLoading: false,
    isError: false,
  }),
  useResolveEpisode: () => ({
    mutate: vi.fn(),
    isPending: false,
    reset: vi.fn(),
  }),
  useDeleteEpisode: () => ({
    mutate: vi.fn(),
    isPending: false,
    reset: vi.fn(),
  }),
  useRestoreEpisode: () => ({
    mutate: vi.fn(),
    isPending: false,
    reset: vi.fn(),
  }),
}));

import { NewEpisodeSheet } from "../new-episode-sheet";
import { IllnessEpisodeDetail } from "../illness-episode-detail";

function renderWithProviders(node: React.ReactNode): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("NewEpisodeSheet — edit hydration in Asia/Tokyo", () => {
  it("hydrates resolved date field to the user's timezone day when present", () => {
    const episode: IllnessEpisodeDTO = {
      id: "ep-tokyo-2",
      label: "Resolved Bout",
      type: "INFECTION",
      lifecycle: "ACUTE",
      onsetAt: "2026-11-05T03:00:00.000Z", // 12:00 PM JST Nov 5
      resolvedAt: "2026-11-09T23:45:00.000Z", // 08:45 AM JST Nov 10
      parentConditionId: null,
      note: null,
      bodySite: null,
      laterality: null,
      createdAt: "2026-11-05T03:00:00.000Z",
      updatedAt: "2026-11-09T23:45:00.000Z",
    };

    const html = renderWithProviders(
      <NewEpisodeSheet
        open={true}
        onOpenChange={() => {}}
        today="2026-11-10"
        editEpisode={episode}
      />,
    );

    expect(html).toMatch(
      /<input[^>]*id="illness-onset"[^>]*value="2026-11-05"/,
    );
    expect(html).toMatch(
      /<input[^>]*id="illness-resolved"[^>]*value="2026-11-10"/,
    );
    expect(html).not.toMatch(
      /<input[^>]*id="illness-resolved"[^>]*value="2026-11-09"/,
    );
  });
});

describe("IllnessEpisodeDetail — LogDaySheet onsetDate bound in Asia/Tokyo", () => {
  it("provides 2026-11-10 rather than slice(0, 10) to LogDaySheet onsetDate", () => {
    capturedLogDaySheet.mockClear();
    const html = renderWithProviders(
      <IllnessEpisodeDetail episodeId="ep-tokyo-1" />,
    );

    expect(capturedLogDaySheet).toHaveBeenCalledWith(
      expect.objectContaining({
        onsetDate: "2026-11-10",
      }),
    );
    expect(html).toContain('data-onset-date="2026-11-10"');
    expect(html).not.toContain('data-onset-date="2026-11-09"');
  });
});

describe("NewEpisodeSheet — blank and whitespace onset date prevention", () => {
  function walkElements(
    node: React.ReactNode,
    out: React.ReactElement[] = [],
  ): React.ReactElement[] {
    if (Array.isArray(node)) {
      for (const n of node) walkElements(n, out);
      return out;
    }
    if (!isValidElement(node)) return out;
    out.push(node);
    const props = node.props as { children?: React.ReactNode };
    if (props?.children) walkElements(props.children, out);
    return out;
  }

  /**
   * Minimal interactive renderer for testing state updates in static SSR tests.
   * Note: The hook-index store tracks useState calls sequentially and relies on
   * React hook call order remaining stable across renders.
   */
  function renderInteractive(renderElement: () => React.ReactElement) {
    const store: unknown[] = [];
    const refStore: { current: unknown }[] = [];
    const prevDeps: (readonly unknown[] | undefined)[] = [];
    const cleanupFns: ((() => void) | void)[] = [];

    function render(): string {
      let hookIdx = 0;
      let refIdx = 0;
      let effectIdx = 0;
      let stateChangedDuringRender = false;
      const pendingEffects: (() => void)[] = [];

      activeStore = {
        get(initial) {
          const idx = hookIdx++;
          if (store.length <= idx) {
            store[idx] =
              typeof initial === "function"
                ? (initial as () => unknown)()
                : initial;
          }
          const setState = (next: unknown) => {
            const nextVal =
              typeof next === "function"
                ? (next as (prev: unknown) => unknown)(store[idx])
                : next;
            if (!Object.is(store[idx], nextVal)) {
              store[idx] = nextVal;
              stateChangedDuringRender = true;
              if (!activeStore) {
                render();
              }
            }
          };
          return [store[idx], setState as React.Dispatch<unknown>];
        },
        ref(initial) {
          const idx = refIdx++;
          if (refStore.length <= idx) {
            refStore[idx] = { current: initial };
          }
          return refStore[idx] as { current: typeof initial };
        },
        effect(effectFn, deps) {
          const idx = effectIdx++;
          const lastDeps = prevDeps[idx];
          const hasChanged =
            !lastDeps ||
            !deps ||
            deps.length !== lastDeps.length ||
            deps.some((dep, i) => !Object.is(dep, lastDeps[i]));

          if (hasChanged) {
            prevDeps[idx] = deps;
            pendingEffects.push(() => {
              cleanupFns[idx]?.();
              cleanupFns[idx] = effectFn();
            });
          }
        },
      };
      try {
        let markup = renderWithProviders(renderElement());
        let loopLimit = 10;
        while (stateChangedDuringRender) {
          if (loopLimit-- <= 0) {
            throw new Error(
              "renderInteractive did not settle within loop limit: detected possible infinite state update loop during render",
            );
          }
          stateChangedDuringRender = false;
          hookIdx = 0;
          refIdx = 0;
          effectIdx = 0;
          markup = renderWithProviders(renderElement());
        }
        for (const runEffect of pendingEffects) {
          runEffect();
        }
        return markup;
      } finally {
        activeStore = null;
      }
    }

    const initialHtml = render();
    return {
      getHtml: () => render(),
      initialHtml,
    };
  }

  function getDateField(id: "illness-onset" | "illness-resolved") {
    if (!capturedChildren) {
      throw new Error("Children not captured");
    }
    const elements = walkElements(capturedChildren);
    const dateField = elements.find((el) => {
      const props = el.props as Record<string, unknown>;
      return props.id === id && typeof props.onChange === "function";
    });
    if (!dateField) throw new Error(`DateField with id ${id} not found`);
    return dateField as React.ReactElement<{
      id: string;
      value?: string;
      onChange?: (val: string) => void;
      max?: string;
    }>;
  }

  function getInputElement(id: string) {
    if (!capturedChildren) {
      throw new Error("Children not captured");
    }
    const elements = walkElements(capturedChildren);
    const input = elements.find((el) => {
      const props = el.props as Record<string, unknown>;
      return props.id === id && typeof props.onChange === "function";
    });
    if (!input) throw new Error(`Input with id ${id} not found`);
    return input as React.ReactElement<{
      id: string;
      value?: string;
      onChange?: (e: { target: { value: string } }) => void;
    }>;
  }

  function getSelectElement(triggerId: string) {
    if (!capturedChildren) {
      throw new Error("Children not captured");
    }
    const elements = walkElements(capturedChildren);
    const select = elements.find((el) => {
      const props = el.props as Record<string, unknown>;
      if (typeof props.onValueChange !== "function") return false;
      const sub = walkElements(props.children as React.ReactNode);
      return sub.some(
        (s) => (s.props as Record<string, unknown>)?.id === triggerId,
      );
    });
    if (!select)
      throw new Error(`Select with trigger id ${triggerId} not found`);
    return select as React.ReactElement<{
      value?: string;
      onValueChange?: (val: string) => void;
    }>;
  }

  function getBodySiteFields() {
    if (!capturedChildren) {
      throw new Error("Children not captured");
    }
    const elements = walkElements(capturedChildren);
    const siteFields = elements.find((el) => {
      const props = el.props as Record<string, unknown>;
      return props.idPrefix === "illness";
    });
    if (!siteFields) throw new Error("BodySiteFields not found");
    return siteFields as React.ReactElement<{
      bodySite?: string;
      laterality?: unknown;
      onBodySiteChange?: (val: string) => void;
      onLateralityChange?: (val: unknown) => void;
    }>;
  }

  function getAlertElement() {
    if (!capturedChildren) return undefined;
    return walkElements(capturedChildren).find(
      (el) => (el.props as Record<string, unknown>)?.role === "alert",
    );
  }

  function getSaveButton() {
    if (!capturedFooter) {
      throw new Error("Footer not captured");
    }
    const elements = walkElements(capturedFooter);
    const saveButton = elements.find((el) => {
      const props = el.props as Record<string, unknown>;
      const label =
        typeof props.children === "string"
          ? props.children.trim()
          : typeof props["aria-label"] === "string"
            ? props["aria-label"].trim()
            : typeof props.name === "string"
              ? props.name.trim()
              : "";
      return (
        /save/i.test(label) &&
        (el.type === Button ||
          el.type === "button" ||
          typeof props.onClick === "function")
      );
    });
    if (!saveButton) throw new Error("Save button not found in footer");
    return saveButton as React.ReactElement<{
      disabled?: boolean;
      onClick?: () => Promise<void>;
    }>;
  }

  it("disables save button and prevents handleSave when editing an episode with a blank onset date", async () => {
    mockUpdateMutateAsync.mockClear();
    mockCreateMutateAsync.mockClear();
    const episodeWithBlankOnset: IllnessEpisodeDTO = {
      ...mockEpisodeInTokyo,
      onsetAt: "",
    };

    const html = renderWithProviders(
      <NewEpisodeSheet
        open={true}
        onOpenChange={() => {}}
        today="2026-11-10"
        editEpisode={episodeWithBlankOnset}
      />,
    );

    const saveButton = getSaveButton();
    expect(saveButton.props.disabled).toBe(true);
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>[^<]*Save[^<]*<\/button>/i,
    );

    await saveButton.props.onClick?.();
    expect(mockUpdateMutateAsync).not.toHaveBeenCalled();
    expect(mockCreateMutateAsync).not.toHaveBeenCalled();
  });

  it("disables save button and prevents handleSave when editing an episode with a whitespace onset date", async () => {
    mockUpdateMutateAsync.mockClear();
    mockCreateMutateAsync.mockClear();
    const episodeWithWhitespaceOnset: IllnessEpisodeDTO = {
      ...mockEpisodeInTokyo,
      onsetAt: "   ",
    };

    const html = renderWithProviders(
      <NewEpisodeSheet
        open={true}
        onOpenChange={() => {}}
        today="2026-11-10"
        editEpisode={episodeWithWhitespaceOnset}
      />,
    );

    const saveButton = getSaveButton();
    expect(saveButton.props.disabled).toBe(true);
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>[^<]*Save[^<]*<\/button>/i,
    );

    await saveButton.props.onClick?.();
    expect(mockUpdateMutateAsync).not.toHaveBeenCalled();
    expect(mockCreateMutateAsync).not.toHaveBeenCalled();
  });

  it("disables save button and prevents handleSave when creating a new episode with blank today", async () => {
    mockUpdateMutateAsync.mockClear();
    mockCreateMutateAsync.mockClear();

    renderWithProviders(
      <NewEpisodeSheet open={true} onOpenChange={() => {}} today="" />,
    );

    const saveButton = getSaveButton();
    expect(saveButton.props.disabled).toBe(true);

    await saveButton.props.onClick?.();
    expect(mockCreateMutateAsync).not.toHaveBeenCalled();
    expect(mockUpdateMutateAsync).not.toHaveBeenCalled();
  });

  it("enables save button, executes update, and preserves exact stored onset instant when onset calendar date is unchanged", async () => {
    mockUpdateMutateAsync.mockClear();
    mockCreateMutateAsync.mockClear();

    renderWithProviders(
      <NewEpisodeSheet
        open={true}
        onOpenChange={() => {}}
        today="2026-11-10"
        editEpisode={mockEpisodeInTokyo}
      />,
    );

    const saveButton = getSaveButton();
    expect(saveButton.props.disabled).toBe(false);

    await saveButton.props.onClick?.();
    expect(mockUpdateMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockUpdateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        id: mockEpisodeInTokyo.id,
        input: expect.objectContaining({
          label: "Morning Headache",
          onsetAt: mockEpisodeInTokyo.onsetAt,
        }),
      }),
    );
  });

  it("preserves exact stored onset instant and serializes user-changed resolved date in session timezone when profile display timezone changes between opening and saving", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-11T12:00:00+09:00"));
      mockDisplayTimezone = "Asia/Tokyo";
      mockUpdateMutateAsync.mockClear();
      mockCreateMutateAsync.mockClear();

      let currentToday = "2026-11-11";
      const runner = renderInteractive(() => (
        <NewEpisodeSheet
          open={true}
          onOpenChange={() => {}}
          today={currentToday}
          editEpisode={mockEpisodeInTokyo}
        />
      ));

      // Profile display timezone changes to America/Los_Angeles and parent derives LA today
      mockDisplayTimezone = "America/Los_Angeles";
      currentToday = "2026-11-10";
      runner.getHtml();

      // User sets resolved date after the timezone switch; satisfies onset <= resolved <= today (onset/resolved are Nov 10 and session today is Nov 11)
      const resolvedField = getDateField("illness-resolved");
      resolvedField.props.onChange?.("2026-11-10");
      runner.getHtml();

      const saveButton = getSaveButton();
      expect(saveButton.props.disabled).toBe(false);

      await saveButton.props.onClick?.();
      expect(mockUpdateMutateAsync).toHaveBeenCalledTimes(1);
      expect(mockUpdateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          id: mockEpisodeInTokyo.id,
          input: expect.objectContaining({
            label: "Morning Headache",
            onsetAt: mockEpisodeInTokyo.onsetAt,
            // Nov 10 2026 in session timezone Asia/Tokyo at local noon is 2026-11-10T03:00:00.000Z
            // (rather than America/Los_Angeles which would be 2026-11-10T20:00:00.000Z)
            resolvedAt: "2026-11-10T03:00:00.000Z",
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("derives onset DateField max dynamically across midnight in session timezone and serializes save with midnight-updated today", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-10T14:59:00.000Z"));
      mockDisplayTimezone = "Asia/Tokyo";
      mockUpdateMutateAsync.mockClear();
      mockCreateMutateAsync.mockClear();

      let currentToday = "2026-11-10";
      const runner = renderInteractive(() => (
        <NewEpisodeSheet
          open={true}
          onOpenChange={() => {}}
          today={currentToday}
          editEpisode={mockEpisodeInTokyo}
        />
      ));

      // Advance fake timers across the scheduled boundary (14:59 -> 15:01 Tokyo midnight is 15:00)
      mockDisplayTimezone = "America/Los_Angeles";
      currentToday = "2026-11-10";
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      });

      // Assert onset DateField max is still derived as Tokyo 2026-11-11
      const onsetField = getDateField("illness-onset");
      expect(onsetField.props.max).toBe("2026-11-11");

      // Select onset 2026-11-11 and save
      onsetField.props.onChange?.("2026-11-11");
      runner.getHtml();

      const saveButton = getSaveButton();
      expect(saveButton.props.disabled).toBe(false);

      await saveButton.props.onClick?.();
      expect(mockUpdateMutateAsync).toHaveBeenCalledTimes(1);
      expect(mockUpdateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          id: mockEpisodeInTokyo.id,
          input: expect.objectContaining({
            onsetAt: "2026-11-10T15:01:00.000Z",
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves both exact stored onsetAt and resolvedAt timestamps on no-op edit when calendar dates are unchanged", async () => {
    mockUpdateMutateAsync.mockClear();
    mockCreateMutateAsync.mockClear();

    const episodeWithBothDates: IllnessEpisodeDTO = {
      ...mockEpisodeInTokyo,
      id: "ep-tokyo-both",
      label: "Flu with exact timestamps",
      // Distinct non-noon timestamps in Asia/Tokyo (+09:00):
      // 2026-11-05T01:23:45.678Z -> 10:23:45 on 2026-11-05 JST
      // 2026-11-09T14:56:12.345Z -> 23:56:12 on 2026-11-09 JST
      onsetAt: "2026-11-05T01:23:45.678Z",
      resolvedAt: "2026-11-09T14:56:12.345Z",
    };

    renderWithProviders(
      <NewEpisodeSheet
        open={true}
        onOpenChange={() => {}}
        today="2026-11-10"
        editEpisode={episodeWithBothDates}
      />,
    );

    const saveButton = getSaveButton();
    expect(saveButton.props.disabled).toBe(false);

    await saveButton.props.onClick?.();

    expect(mockUpdateMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockUpdateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        id: episodeWithBothDates.id,
        input: expect.objectContaining({
          label: episodeWithBothDates.label,
          onsetAt: episodeWithBothDates.onsetAt,
          resolvedAt: episodeWithBothDates.resolvedAt,
        }),
      }),
    );
  });

  it("serializes a new onset instant when editing an episode with a changed onset calendar date", async () => {
    mockUpdateMutateAsync.mockClear();
    mockCreateMutateAsync.mockClear();

    const runner = renderInteractive(() => (
      <NewEpisodeSheet
        open={true}
        onOpenChange={() => {}}
        today="2026-11-10"
        editEpisode={mockEpisodeInTokyo}
      />
    ));

    const onsetField = getDateField("illness-onset");
    onsetField.props.onChange?.("2026-11-08");
    runner.getHtml();

    const saveButton = getSaveButton();
    await saveButton.props.onClick?.();

    expect(mockUpdateMutateAsync).toHaveBeenCalledTimes(1);
    // Nov 8 2026 in Asia/Tokyo at local noon is 2026-11-08T03:00:00.000Z
    expect(mockUpdateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        id: mockEpisodeInTokyo.id,
        input: expect.objectContaining({
          label: "Morning Headache",
          onsetAt: "2026-11-08T03:00:00.000Z",
        }),
      }),
    );
  });

  it("clamps same-day preserved resolvedAt up to onsetAt when onset is changed to today earlier than stored resolvedAt in Asia/Tokyo", async () => {
    vi.useFakeTimers();
    try {
      // Concrete case: Asia/Tokyo at 09:00 JST (00:00:00 UTC) on 2026-11-11
      vi.setSystemTime(new Date("2026-11-11T09:00:00+09:00"));
      mockDisplayTimezone = "Asia/Tokyo";
      mockUpdateMutateAsync.mockClear();
      mockCreateMutateAsync.mockClear();

      // Existing episode: onset yesterday (Nov 10), resolved today at 08:00 JST (2026-11-10T23:00:00.000Z)
      const existingEpisode: IllnessEpisodeDTO = {
        ...mockEpisodeInTokyo,
        id: "ep-tokyo-same-day",
        label: "Same-Day Headache",
        onsetAt: "2026-11-10T03:00:00.000Z",
        resolvedAt: "2026-11-10T23:00:00.000Z",
      };

      const runner = renderInteractive(() => (
        <NewEpisodeSheet
          open={true}
          onOpenChange={() => {}}
          today="2026-11-11"
          editEpisode={existingEpisode}
        />
      ));

      // User changes onset to today (2026-11-11); resolved date remains 2026-11-11
      const onsetField = getDateField("illness-onset");
      onsetField.props.onChange?.("2026-11-11");
      runner.getHtml();

      const saveButton = getSaveButton();
      expect(saveButton.props.disabled).toBe(false);

      await saveButton.props.onClick?.();

      expect(mockUpdateMutateAsync).toHaveBeenCalledTimes(1);
      // Serialized onsetAt at 09:00 JST is 2026-11-11T00:00:00.000Z.
      // Preserved resolvedAt (08:00 JST / 2026-11-10T23:00:00.000Z) is same-day
      // and chronologically earlier, so it is clamped up to onsetAt.
      expect(mockUpdateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          id: existingEpisode.id,
          input: expect.objectContaining({
            onsetAt: "2026-11-11T00:00:00.000Z",
            resolvedAt: "2026-11-11T00:00:00.000Z",
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes onset instant normally when creating a new episode", async () => {
    mockUpdateMutateAsync.mockClear();
    mockCreateMutateAsync.mockClear();

    const runner = renderInteractive(() => (
      <NewEpisodeSheet open={true} onOpenChange={() => {}} today="2026-11-10" />
    ));

    const labelInput = getInputElement("illness-label");
    labelInput.props.onChange?.({ target: { value: "New Condition" } });

    const onsetField = getDateField("illness-onset");
    onsetField.props.onChange?.("2026-11-08");
    runner.getHtml();

    const saveButton = getSaveButton();
    await saveButton.props.onClick?.();

    expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockCreateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "New Condition",
        onsetAt: "2026-11-08T03:00:00.000Z",
      }),
    );
  });

  it("treats whitespace-only resolved date as empty (enables save button and passes null resolvedAt)", async () => {
    mockUpdateMutateAsync.mockClear();
    mockCreateMutateAsync.mockClear();
    const episodeWithWhitespaceResolved: IllnessEpisodeDTO = {
      ...mockEpisodeInTokyo,
      resolvedAt: "   ",
    };

    renderWithProviders(
      <NewEpisodeSheet
        open={true}
        onOpenChange={() => {}}
        today="2026-11-10"
        editEpisode={episodeWithWhitespaceResolved}
      />,
    );

    const saveButton = getSaveButton();
    expect(saveButton.props.disabled).toBe(false);

    await saveButton.props.onClick?.();
    expect(mockUpdateMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockUpdateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        id: mockEpisodeInTokyo.id,
        input: expect.objectContaining({
          label: "Morning Headache",
          resolvedAt: null,
        }),
      }),
    );
  });

  it("disables save button and prevents handleSave when resolved date is before onset date", async () => {
    mockUpdateMutateAsync.mockClear();
    mockCreateMutateAsync.mockClear();
    const episodeEndBeforeStart: IllnessEpisodeDTO = {
      ...mockEpisodeInTokyo,
      onsetAt: "2026-11-10T12:00:00.000Z",
      resolvedAt: "2026-11-05T12:00:00.000Z",
    };

    renderWithProviders(
      <NewEpisodeSheet
        open={true}
        onOpenChange={() => {}}
        today="2026-11-10"
        editEpisode={episodeEndBeforeStart}
      />,
    );

    const saveButton = getSaveButton();
    expect(saveButton.props.disabled).toBe(true);

    await saveButton.props.onClick?.();
    expect(mockUpdateMutateAsync).not.toHaveBeenCalled();
    expect(mockCreateMutateAsync).not.toHaveBeenCalled();
  });

  it("renders save-error alert when handleSave fails on invalid onset date and clears it when onset date is corrected", async () => {
    mockUpdateMutateAsync.mockClear();
    mockCreateMutateAsync.mockClear();
    const episodeWithImpossibleOnset: IllnessEpisodeDTO = {
      ...mockEpisodeInTokyo,
      // Representative impossible calendar date (Month 00 is impossible)
      onsetAt: "2026-00-15",
    };

    const runner = renderInteractive(() => (
      <NewEpisodeSheet
        open={true}
        onOpenChange={() => {}}
        today="2026-11-10"
        editEpisode={episodeWithImpossibleOnset}
      />
    ));

    // Initially passes the non-blank check so save button is enabled and no error is rendered
    expect(runner.getHtml()).not.toContain('role="alert"');
    expect(getAlertElement()).toBeUndefined();

    const saveButton = getSaveButton();
    expect(saveButton.props.disabled).toBe(false);

    // Clicking save should not throw an unhandled exception:
    // serialization error must be caught inside handleSave, preventing mutations and updating error state.
    await expect(saveButton.props.onClick?.()).resolves.not.toThrow();
    expect(mockUpdateMutateAsync).not.toHaveBeenCalled();
    expect(mockCreateMutateAsync).not.toHaveBeenCalled();

    // Verify the existing save-error alert is actually rendered after invalid-date save attempt
    const htmlAfterSave = runner.getHtml();
    expect(htmlAfterSave).toContain('role="alert"');
    expect(htmlAfterSave).toContain("Could not save the episode");

    const alertEl = getAlertElement();
    expect(alertEl).toBeDefined();
    expect((alertEl?.props as Record<string, unknown>)?.role).toBe("alert");

    // Clear stale saveError when user changes onset date after a failed submission
    const onsetField = getDateField("illness-onset");
    onsetField.props.onChange?.("2026-11-10");

    const htmlAfterCorrectOnset = runner.getHtml();
    expect(htmlAfterCorrectOnset).not.toContain('role="alert"');
    expect(getAlertElement()).toBeUndefined();
  });

  it("clears stale save error when user changes resolved date after a failed submission", async () => {
    mockUpdateMutateAsync.mockClear();
    mockCreateMutateAsync.mockClear();
    const episodeWithImpossibleResolved: IllnessEpisodeDTO = {
      ...mockEpisodeInTokyo,
      onsetAt: "2026-11-05T12:00:00.000Z",
      // Month 13 is impossible (> onset date so not disabled by endBeforeStart)
      resolvedAt: "2026-13-10",
    };

    const runner = renderInteractive(() => (
      <NewEpisodeSheet
        open={true}
        onOpenChange={() => {}}
        today="2026-11-10"
        editEpisode={episodeWithImpossibleResolved}
      />
    ));

    expect(runner.getHtml()).not.toContain('role="alert"');
    expect(getAlertElement()).toBeUndefined();

    const saveButton = getSaveButton();
    expect(saveButton.props.disabled).toBe(false);

    // Save attempt fails validation on resolved date
    await expect(saveButton.props.onClick?.()).resolves.not.toThrow();
    expect(mockUpdateMutateAsync).not.toHaveBeenCalled();
    expect(mockCreateMutateAsync).not.toHaveBeenCalled();

    // Save-error alert is rendered
    expect(runner.getHtml()).toContain('role="alert"');
    expect(runner.getHtml()).toContain("Could not save the episode");
    expect(getAlertElement()).toBeDefined();

    // Clear stale saveError when user changes resolved date
    const resolvedField = getDateField("illness-resolved");
    resolvedField.props.onChange?.("2026-11-10");

    expect(runner.getHtml()).not.toContain('role="alert"');
    expect(getAlertElement()).toBeUndefined();
  });

  it("clears stale save error when user edits label, type, note, bodySite, laterality, or lifecycle", async () => {
    mockUpdateMutateAsync.mockClear();
    mockCreateMutateAsync.mockClear();
    const episodeWithImpossibleOnset: IllnessEpisodeDTO = {
      ...mockEpisodeInTokyo,
      onsetAt: "2026-00-15",
    };

    // 1. label change clears error
    const labelRunner = renderInteractive(() => (
      <NewEpisodeSheet
        open={true}
        onOpenChange={() => {}}
        today="2026-11-10"
        editEpisode={episodeWithImpossibleOnset}
      />
    ));
    await getSaveButton().props.onClick?.();
    expect(labelRunner.getHtml()).toContain('role="alert"');
    getInputElement("illness-label").props.onChange?.({
      target: { value: "Updated Label" },
    });
    expect(labelRunner.getHtml()).not.toContain('role="alert"');

    // 2. type change clears error
    const typeRunner = renderInteractive(() => (
      <NewEpisodeSheet
        open={true}
        onOpenChange={() => {}}
        today="2026-11-10"
        editEpisode={episodeWithImpossibleOnset}
      />
    ));
    await getSaveButton().props.onClick?.();
    expect(typeRunner.getHtml()).toContain('role="alert"');
    getSelectElement("illness-type").props.onValueChange?.("ALLERGY");
    expect(typeRunner.getHtml()).not.toContain('role="alert"');

    // 3. note change clears error
    const noteRunner = renderInteractive(() => (
      <NewEpisodeSheet
        open={true}
        onOpenChange={() => {}}
        today="2026-11-10"
        editEpisode={episodeWithImpossibleOnset}
      />
    ));
    await getSaveButton().props.onClick?.();
    expect(noteRunner.getHtml()).toContain('role="alert"');
    getInputElement("illness-note").props.onChange?.({
      target: { value: "Updated note details" },
    });
    expect(noteRunner.getHtml()).not.toContain('role="alert"');

    // 4. bodySite change clears error
    const siteRunner = renderInteractive(() => (
      <NewEpisodeSheet
        open={true}
        onOpenChange={() => {}}
        today="2026-11-10"
        editEpisode={episodeWithImpossibleOnset}
      />
    ));
    await getSaveButton().props.onClick?.();
    expect(siteRunner.getHtml()).toContain('role="alert"');
    getBodySiteFields().props.onBodySiteChange?.("Left Knee");
    expect(siteRunner.getHtml()).not.toContain('role="alert"');

    // 5. laterality change clears error
    const lateralityRunner = renderInteractive(() => (
      <NewEpisodeSheet
        open={true}
        onOpenChange={() => {}}
        today="2026-11-10"
        editEpisode={episodeWithImpossibleOnset}
      />
    ));
    await getSaveButton().props.onClick?.();
    expect(lateralityRunner.getHtml()).toContain('role="alert"');
    getBodySiteFields().props.onLateralityChange?.("RIGHT");
    expect(lateralityRunner.getHtml()).not.toContain('role="alert"');

    // 6. lifecycle change clears error
    const lifecycleRunner = renderInteractive(() => (
      <NewEpisodeSheet
        open={true}
        onOpenChange={() => {}}
        today="2026-11-10"
        editEpisode={episodeWithImpossibleOnset}
      />
    ));
    await getSaveButton().props.onClick?.();
    expect(lifecycleRunner.getHtml()).toContain('role="alert"');
    getSelectElement("illness-lifecycle").props.onValueChange?.(
      "CHRONIC_ONGOING",
    );
    expect(lifecycleRunner.getHtml()).not.toContain('role="alert"');

    // 7. parent condition change clears error when parent select is visible (FLARE / RECURRING)
    const flareEpisode: IllnessEpisodeDTO = {
      ...episodeWithImpossibleOnset,
      lifecycle: "FLARE",
    };
    const parentRunner = renderInteractive(() => (
      <NewEpisodeSheet
        open={true}
        onOpenChange={() => {}}
        today="2026-11-10"
        editEpisode={flareEpisode}
      />
    ));
    await getSaveButton().props.onClick?.();
    expect(parentRunner.getHtml()).toContain('role="alert"');
    getSelectElement("illness-parent").props.onValueChange?.("parent-1");
    expect(parentRunner.getHtml()).not.toContain('role="alert"');
  });

  it("keeps pending Save disabled and avoids duplicate submissions when editing fields during an in-flight save", async () => {
    mockCreateMutateAsync.mockClear();
    mockUpdateMutateAsync.mockClear();
    mockCreateState = { isPending: false, isError: false };
    mockUpdateState = { isPending: false, isError: false };

    let resolveSave: (value: unknown) => void = () => {};
    const unresolvedPromise = new Promise((resolve) => {
      resolveSave = resolve;
    });

    mockCreateMutateAsync.mockImplementationOnce(() => {
      mockCreateState.isPending = true;
      return unresolvedPromise;
    });

    try {
      const runner = renderInteractive(() => (
        <NewEpisodeSheet
          open={true}
          onOpenChange={() => {}}
          today="2026-11-10"
        />
      ));

      // Fill in required label so save button is enabled
      getInputElement("illness-label").props.onChange?.({
        target: { value: "New Condition" },
      });
      runner.getHtml();

      const saveButton = getSaveButton();
      expect(saveButton.props.disabled).toBe(false);

      // Initiate save — does not resolve immediately
      const savePromise = saveButton.props.onClick?.();
      expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1);

      // Re-render to reflect pending state
      runner.getHtml();
      expect(getSaveButton().props.disabled).toBe(true);

      // User edits a field while save is pending
      getInputElement("illness-label").props.onChange?.({
        target: { value: "Condition edited while saving" },
      });
      runner.getHtml();

      // Pending Save must remain disabled
      const saveButtonWhilePending = getSaveButton();
      expect(saveButtonWhilePending.props.disabled).toBe(true);

      // Attempt second save submission while pending
      await saveButtonWhilePending.props.onClick?.();
      expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1);

      // Resolve initial request and finish
      resolveSave({});
      await savePromise;
    } finally {
      resolveSave({});
      mockCreateMutateAsync.mockReset().mockResolvedValue({});
    }
  });

  it("prevents double submission when save is activated twice rapidly before re-render", async () => {
    mockCreateMutateAsync.mockClear();
    let resolveSave: (value: unknown) => void = () => {};
    const deferredPromise = new Promise((resolve) => {
      resolveSave = resolve;
    });
    mockCreateMutateAsync.mockImplementationOnce(() => deferredPromise);

    try {
      const runner = renderInteractive(() => (
        <NewEpisodeSheet
          open={true}
          onOpenChange={() => {}}
          today="2026-11-10"
        />
      ));

      getInputElement("illness-label").props.onChange?.({
        target: { value: "Rapid Click Condition" },
      });
      runner.getHtml();

      const saveButton = getSaveButton();
      expect(saveButton.props.disabled).toBe(false);

      // Invoke save twice concurrently before any React re-render
      const firstCall = saveButton.props.onClick?.();
      const secondCall = saveButton.props.onClick?.();

      expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1);

      resolveSave({});
      await Promise.all([firstCall, secondCall]);
      expect(mockCreateMutateAsync).toHaveBeenCalledTimes(1);
    } finally {
      resolveSave({});
      mockCreateMutateAsync.mockReset().mockResolvedValue({});
    }
  });

  it("clears stale save error and restores form to stored values when the sheet is closed and reopened", async () => {
    mockUpdateMutateAsync.mockClear();
    mockCreateMutateAsync.mockClear();
    const episodeWithImpossibleOnset: IllnessEpisodeDTO = {
      ...mockEpisodeInTokyo,
      label: "Original Stored Label",
      note: "Original Stored Note",
      onsetAt: "2026-00-15",
    };

    let isOpen = true;
    const runner = renderInteractive(() => (
      <NewEpisodeSheet
        open={isOpen}
        onOpenChange={(next) => {
          isOpen = next;
        }}
        today="2026-11-10"
        editEpisode={episodeWithImpossibleOnset}
      />
    ));

    expect(getInputElement("illness-label").props.value).toBe(
      "Original Stored Label",
    );
    expect(getInputElement("illness-note").props.value).toBe(
      "Original Stored Note",
    );

    // Change fields before save failure
    getInputElement("illness-label").props.onChange?.({
      target: { value: "Dirty Unsaved Label" },
    });
    getInputElement("illness-note").props.onChange?.({
      target: { value: "Dirty Unsaved Note" },
    });
    runner.getHtml();

    expect(getInputElement("illness-label").props.value).toBe(
      "Dirty Unsaved Label",
    );
    expect(getInputElement("illness-note").props.value).toBe(
      "Dirty Unsaved Note",
    );

    await getSaveButton().props.onClick?.();
    expect(runner.getHtml()).toContain('role="alert"');

    // Close sheet through the sheet's onOpenChange callback
    capturedResponsiveSheetProps?.onOpenChange?.(false);
    expect(isOpen).toBe(false);
    expect(runner.getHtml()).toBe("");

    // Reopen sheet
    isOpen = true;
    const reopenedHtml = runner.getHtml();
    expect(reopenedHtml).not.toContain('role="alert"');

    // Form fields must be restored to stored values
    expect(getInputElement("illness-label").props.value).toBe(
      "Original Stored Label",
    );
    expect(getInputElement("illness-note").props.value).toBe(
      "Original Stored Note",
    );
  });

  it("prevents an in-flight save from a previous session from closing or erroring a newly reopened sheet on reject", async () => {
    mockCreateMutateAsync.mockClear();
    mockUpdateMutateAsync.mockClear();

    let rejectSave: (err: unknown) => void = () => {};
    const deferredPromise = new Promise((_, reject) => {
      rejectSave = reject;
    });
    mockUpdateMutateAsync.mockImplementationOnce(() => {
      mockUpdateState.isPending = true;
      return deferredPromise.catch((err) => {
        mockUpdateState.isPending = false;
        mockUpdateState.isError = true;
        throw err;
      });
    });

    let isOpen = true;
    let currentEpisode: IllnessEpisodeDTO | undefined = mockEpisodeInTokyo;

    const runner = renderInteractive(() => (
      <NewEpisodeSheet
        open={isOpen}
        onOpenChange={(next) => {
          isOpen = next;
        }}
        today="2026-11-10"
        editEpisode={currentEpisode}
      />
    ));

    // 1. Start save on first episode
    const savePromise = getSaveButton().props.onClick?.();
    expect(mockUpdateMutateAsync).toHaveBeenCalledTimes(1);

    // 2. Drive close through sheet onOpenChange callback
    capturedResponsiveSheetProps?.onOpenChange?.(false);
    expect(isOpen).toBe(false);
    runner.getHtml();

    // 3. Reopen sheet for a new entry
    currentEpisode = undefined;
    isOpen = true;
    runner.getHtml();
    expect(isOpen).toBe(true);

    // 4. Settle the old save by rejecting it
    rejectSave(new Error("Old save failed"));
    await savePromise;

    // 5. Verify the newly reopened sheet remains open and does not display the old error
    expect(isOpen).toBe(true);
    const htmlAfterOldSaveSettles = runner.getHtml();
    expect(htmlAfterOldSaveSettles).not.toContain('role="alert"');
    expect(getAlertElement()).toBeUndefined();
  });

  it("prevents an in-flight save from a previous session from closing a newly reopened sheet on resolve", async () => {
    mockCreateMutateAsync.mockClear();
    mockUpdateMutateAsync.mockClear();

    let resolveSave: (val: unknown) => void = () => {};
    const deferredPromise = new Promise((resolve) => {
      resolveSave = resolve;
    });
    mockUpdateMutateAsync.mockImplementationOnce(() => {
      mockUpdateState.isPending = true;
      return deferredPromise.then((val) => {
        mockUpdateState.isPending = false;
        return val;
      });
    });

    let isOpen = true;
    let currentEpisode: IllnessEpisodeDTO | undefined = mockEpisodeInTokyo;

    const runner = renderInteractive(() => (
      <NewEpisodeSheet
        open={isOpen}
        onOpenChange={(next) => {
          isOpen = next;
        }}
        today="2026-11-10"
        editEpisode={currentEpisode}
      />
    ));

    // 1. Start save on first episode
    const savePromise = getSaveButton().props.onClick?.();
    expect(mockUpdateMutateAsync).toHaveBeenCalledTimes(1);

    // 2. Drive close through sheet onOpenChange callback
    capturedResponsiveSheetProps?.onOpenChange?.(false);
    expect(isOpen).toBe(false);
    runner.getHtml();

    // 3. Reopen sheet for a new entry
    currentEpisode = undefined;
    isOpen = true;
    runner.getHtml();
    expect(isOpen).toBe(true);

    // 4. Settle the old save by resolving it
    resolveSave({});
    await savePromise;

    // 5. Verify the newly reopened sheet remains open
    expect(isOpen).toBe(true);
    const htmlAfterOldSaveSettles = runner.getHtml();
    expect(htmlAfterOldSaveSettles).not.toContain('role="alert"');
  });

  it("prevents an in-flight save from closing or erroring when closed externally and upon reopen", async () => {
    mockCreateMutateAsync.mockClear();
    mockUpdateMutateAsync.mockClear();

    let resolveSave: (val: unknown) => void = () => {};
    const deferredPromise = new Promise((resolve) => {
      resolveSave = resolve;
    });
    mockUpdateMutateAsync.mockImplementationOnce(() => {
      mockUpdateState.isPending = true;
      return deferredPromise.then((val) => {
        mockUpdateState.isPending = false;
        return val;
      });
    });

    let isOpen = true;
    const onOpenChangeMock = vi.fn((next: boolean) => {
      isOpen = next;
    });
    let currentEpisode: IllnessEpisodeDTO | undefined = mockEpisodeInTokyo;

    const runner = renderInteractive(() => (
      <NewEpisodeSheet
        open={isOpen}
        onOpenChange={onOpenChangeMock}
        today="2026-11-10"
        editEpisode={currentEpisode}
      />
    ));

    // 1. Start save on first episode
    const savePromise = getSaveButton().props.onClick?.();
    expect(mockUpdateMutateAsync).toHaveBeenCalledTimes(1);

    // 2. Drive close externally (controlled prop change without onOpenChange callback)
    isOpen = false;
    runner.getHtml();
    expect(isOpen).toBe(false);

    // Clear calls to verify close-time settlement does not invoke onOpenChange callback
    onOpenChangeMock.mockClear();

    // 3. Settle the old save while the sheet is STILL CLOSED (proves close-time invalidation)
    resolveSave({});
    await savePromise;

    // Assert close-time invalidation: onOpenChange callback was not called again
    expect(onOpenChangeMock).not.toHaveBeenCalled();
    expect(isOpen).toBe(false);

    // 4. Preserve reopen assertions as a separate check: reopening starts a clean session
    currentEpisode = undefined;
    isOpen = true;
    const reopenedHtml = runner.getHtml();
    expect(isOpen).toBe(true);
    expect(reopenedHtml).not.toContain('role="alert"');
  });

  it("invalidates an in-flight save when an ignored handler close is followed by an external close", async () => {
    mockCreateMutateAsync.mockClear();
    mockUpdateMutateAsync.mockClear();

    let resolveSave: (val: unknown) => void = () => {};
    const deferredPromise = new Promise((resolve) => {
      resolveSave = resolve;
    });
    mockUpdateMutateAsync.mockImplementationOnce(() => {
      mockUpdateState.isPending = true;
      return deferredPromise.then((val) => {
        mockUpdateState.isPending = false;
        return val;
      });
    });

    let isOpen = true;
    const onOpenChangeMock = vi.fn();

    const runner = renderInteractive(() => (
      <NewEpisodeSheet
        open={isOpen}
        onOpenChange={onOpenChangeMock}
        today="2026-11-10"
        editEpisode={mockEpisodeInTokyo}
      />
    ));

    // 1. User triggers handler-driven close (e.g. clicks Cancel or backdrop)
    capturedResponsiveSheetProps?.onOpenChange?.(false);
    expect(onOpenChangeMock).toHaveBeenCalledWith(false);

    // Parent IGNORES the callback: isOpen remains true in the parent state
    expect(isOpen).toBe(true);
    runner.getHtml();

    // 2. User starts a new save in this still-open session
    const savePromise = getSaveButton().props.onClick?.();
    expect(mockUpdateMutateAsync).toHaveBeenCalledTimes(1);

    // 3. Parent later triggers an external close while save is in flight
    onOpenChangeMock.mockClear();
    isOpen = false;
    runner.getHtml();

    // 4. In-flight save now settles
    resolveSave({});
    await savePromise;

    // Generation mismatch: save was invalidated by the external close effect.
    // onOpenChange was not called again.
    expect(onOpenChangeMock).not.toHaveBeenCalled();
    expect(isOpen).toBe(false);
  });

  it("invalidates an in-flight save when handler-driven close and reopen are batched", async () => {
    mockCreateMutateAsync.mockClear();
    mockUpdateMutateAsync.mockClear();

    let resolveSave: (val: unknown) => void = () => {};
    const deferredPromise = new Promise((resolve) => {
      resolveSave = resolve;
    });
    mockUpdateMutateAsync.mockImplementationOnce(() => {
      mockUpdateState.isPending = true;
      return deferredPromise.then((val) => {
        mockUpdateState.isPending = false;
        return val;
      });
    });

    let isOpen = true;
    let currentEpisode: IllnessEpisodeDTO | undefined = mockEpisodeInTokyo;

    const runner = renderInteractive(() => (
      <NewEpisodeSheet
        open={isOpen}
        onOpenChange={(next) => {
          isOpen = next;
        }}
        today="2026-11-10"
        editEpisode={currentEpisode}
      />
    ));

    // 1. Start save on initial episode
    const savePromise = getSaveButton().props.onClick?.();
    expect(mockUpdateMutateAsync).toHaveBeenCalledTimes(1);

    // 2. Handler-driven close is triggered
    capturedResponsiveSheetProps?.onOpenChange?.(false);
    expect(isOpen).toBe(false);

    // 3. In the same tick / before intermediate effect runs, parent immediately reopens for new entry
    currentEpisode = undefined;
    isOpen = true;
    runner.getHtml();
    expect(isOpen).toBe(true);

    // 4. Old save now settles
    resolveSave({});
    await savePromise;

    // 5. Reopened sheet remains open and clean; old save was synchronously invalidated on close
    expect(isOpen).toBe(true);
    const htmlAfterSettles = runner.getHtml();
    expect(htmlAfterSettles).not.toContain('role="alert"');
  });

  it("allows newly reopened sheet to save and close cleanly while an earlier save is still hanging", async () => {
    mockCreateMutateAsync.mockClear();
    mockUpdateMutateAsync.mockClear();

    let resolveStaleSave: (val: unknown) => void = () => {};
    const stalePromise = new Promise((resolve) => {
      resolveStaleSave = resolve;
    });

    mockUpdateMutateAsync.mockImplementationOnce(() => stalePromise);

    let isOpen = true;
    const onOpenChangeMock = vi.fn((next: boolean) => {
      isOpen = next;
    });

    const runner = renderInteractive(() => (
      <NewEpisodeSheet
        open={isOpen}
        onOpenChange={onOpenChangeMock}
        today="2026-11-10"
        editEpisode={mockEpisodeInTokyo}
      />
    ));

    // 1. Start initial save (hangs)
    const staleSavePromise = getSaveButton().props.onClick?.();
    expect(mockUpdateMutateAsync).toHaveBeenCalledTimes(1);

    // 2. Close sheet while save is in-flight
    capturedResponsiveSheetProps?.onOpenChange?.(false);
    expect(isOpen).toBe(false);
    runner.getHtml();

    // 3. Reopen sheet
    isOpen = true;
    runner.getHtml();
    expect(isOpen).toBe(true);

    // Verify Save button is NOT disabled despite stale save still pending
    expect(getSaveButton().props.disabled).toBe(false);

    // 4. In the reopened session, user clicks Save again
    mockUpdateMutateAsync.mockResolvedValueOnce({});
    const newSavePromise = getSaveButton().props.onClick?.();
    expect(mockUpdateMutateAsync).toHaveBeenCalledTimes(2);

    await newSavePromise;

    // Proves new save succeeds and requests closure
    expect(onOpenChangeMock).toHaveBeenLastCalledWith(false);

    // 5. Finally stale save resolves — does not re-open or error
    resolveStaleSave({});
    await staleSavePromise;
  });
});
