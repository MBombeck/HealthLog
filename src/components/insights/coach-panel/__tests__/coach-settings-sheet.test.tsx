import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { toast } from "sonner";

import { I18nProvider } from "@/lib/i18n/context";
import { DEFAULT_COACH_PREFS } from "@/lib/validations/coach-prefs";

// v1.4.23 W6 (Design-H3 + H4) — verify the settings sheet renders a
// skeleton placeholder while the persisted prefs are loading (no
// `DEFAULT_COACH_PREFS` ghost form) and emits a sonner toast on save
// success.
//
// The shadcn `<Sheet>` wraps Radix Dialog which uses Portals — those
// don't materialise under `renderToStaticMarkup`. We mock the sheet
// primitives down to plain wrappers so the form/skeleton body is
// reachable in the static markup.

const queryState: { data: unknown } = { data: undefined };
const mutationCallbacks: { onSuccess: ((env: unknown) => void) | null } = {
  onSuccess: null,
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: queryState.data }),
  useMutation: (opts: { onSuccess?: (env: unknown) => void }) => {
    mutationCallbacks.onSuccess = opts.onSuccess ?? null;
    return {
      mutate: (next: unknown) => {
        mutationCallbacks.onSuccess?.({ data: next });
      },
      isPending: false,
    };
  },
  useQueryClient: () => ({
    setQueryData: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn() },
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-slot="mock-sheet">{children}</div> : null,
  SheetContent: ({ children }: { children: React.ReactNode }) => (
    <div data-slot="mock-sheet-content">{children}</div>
  ),
  SheetHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SheetTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  SheetDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
}));

import { CoachSettingsSheet } from "../coach-settings-sheet";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

beforeEach(() => {
  queryState.data = undefined;
  mutationCallbacks.onSuccess = null;
  vi.mocked(toast.success).mockClear();
});

describe("<CoachSettingsSheet>", () => {
  it("renders a skeleton shell while persisted prefs are loading (Design-H3)", () => {
    queryState.data = undefined;
    const html = render(
      <CoachSettingsSheet open={true} onOpenChange={() => {}} />,
    );
    expect(html).toContain('data-slot="coach-prefs-skeleton"');
    // Form body markers must be absent during the skeleton state so
    // the user never sees the DEFAULT_COACH_PREFS ghost form.
    expect(html).not.toContain('data-slot="coach-prefs-tone"');
    expect(html).not.toContain('data-slot="coach-prefs-evidence"');
  });

  it("renders the form once persisted prefs land", () => {
    queryState.data = DEFAULT_COACH_PREFS;
    const html = render(
      <CoachSettingsSheet open={true} onOpenChange={() => {}} />,
    );
    expect(html).not.toContain('data-slot="coach-prefs-skeleton"');
    expect(html).toContain('data-slot="coach-prefs-tone"');
    expect(html).toContain('data-slot="coach-prefs-evidence"');
  });

  it("fires a sonner toast on save success (Design-H4)", () => {
    queryState.data = DEFAULT_COACH_PREFS;
    render(<CoachSettingsSheet open={true} onOpenChange={() => {}} />);
    // Static markup doesn't dispatch click events; trigger the captured
    // mutation success path directly. Verifies the wired-up onSuccess
    // emits the toast with the localised "Saved." string.
    mutationCallbacks.onSuccess?.({ data: DEFAULT_COACH_PREFS });
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith("Saved.");
  });

  // v1.4.25 W5 — defaultWindow picker added.
  it("renders the default-window picker once persisted prefs land", () => {
    queryState.data = DEFAULT_COACH_PREFS;
    const html = render(
      <CoachSettingsSheet open={true} onOpenChange={() => {}} />,
    );
    expect(html).toContain('data-slot="coach-prefs-default-window"');
    expect(html).toContain("Default analysis window");
  });
});
