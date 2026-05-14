/**
 * v1.4.25 W19c-Frontend — Research-mode acknowledgment dialog tests.
 *
 * The dialog is rendered controlled by Settings (commit 3) and gates
 * the GLP-1 drug-level chart (commit 2). The contract is:
 *
 *   1. Multi-section MDR copy renders (what-is, what-isn't, why,
 *      MDR boundary, citations).
 *   2. Acknowledge CTA fires a `POST /api/auth/me/research-mode` with
 *      the exact server-supplied version string.
 *   3. Cancel CTA fires `onOpenChange(false)` without an API call.
 *   4. The stale-version error (server 400 with
 *      `research-mode.version.stale`) surfaces a localised error toast
 *      and keeps the dialog open.
 *
 * Setup mirrors the existing `coach-settings-sheet.test.tsx` pattern:
 * SSR via `renderToStaticMarkup` so the Radix Dialog primitives are
 * mocked to plain wrappers (Portals don't materialise under SSR), and
 * the TanStack Query mutation is captured so we can drive the
 * onSuccess / onError branches by hand.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { toast } from "sonner";

import { I18nProvider } from "@/lib/i18n/context";

const mutationCallbacks: {
  mutationFn: ((version: string) => Promise<unknown>) | null;
  onSuccess: ((data: unknown) => void) | null;
  onError: ((err: unknown) => void) | null;
} = { mutationFn: null, onSuccess: null, onError: null };

const lastMutateCall: { args: unknown[] } = { args: [] };

vi.mock("@tanstack/react-query", () => ({
  useMutation: (opts: {
    mutationFn: (version: string) => Promise<unknown>;
    onSuccess?: (data: unknown) => void;
    onError?: (err: unknown) => void;
  }) => {
    mutationCallbacks.mutationFn = opts.mutationFn;
    mutationCallbacks.onSuccess = opts.onSuccess ?? null;
    mutationCallbacks.onError = opts.onError ?? null;
    return {
      mutate: (version: string) => {
        lastMutateCall.args = [version];
      },
      isPending: false,
    };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// Radix Dialog uses Portals which `renderToStaticMarkup` does not
// realise. We collapse the primitives to plain wrappers so the body of
// the dialog is reachable in the static markup.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
  }) => (open ? <div data-slot="mock-dialog">{children}</div> : null),
  DialogContent: ({
    children,
    ...rest
  }: React.ComponentProps<"div"> & { children: React.ReactNode }) => (
    <div data-slot="mock-dialog-content" {...rest}>
      {children}
    </div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div data-slot="mock-dialog-header">{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2 data-slot="mock-dialog-title">{children}</h2>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p data-slot="mock-dialog-description">{children}</p>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div data-slot="mock-dialog-footer">{children}</div>
  ),
}));

import { ResearchModeAcknowledgmentDialog } from "../ResearchModeAcknowledgmentDialog";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

beforeEach(() => {
  mutationCallbacks.mutationFn = null;
  mutationCallbacks.onSuccess = null;
  mutationCallbacks.onError = null;
  lastMutateCall.args = [];
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

describe("<ResearchModeAcknowledgmentDialog>", () => {
  it("renders nothing while `open === false`", () => {
    const html = render(
      <ResearchModeAcknowledgmentDialog
        open={false}
        onOpenChange={() => {}}
        currentDisclaimerVersion="2026-05-14.1"
      />,
    );
    expect(html).toBe("");
  });

  it("renders the title + the five MDR-copy sections while open", () => {
    const html = render(
      <ResearchModeAcknowledgmentDialog
        open={true}
        onOpenChange={() => {}}
        currentDisclaimerVersion="2026-05-14.1"
      />,
    );

    // Title + primary CTAs.
    expect(html).toContain("Enable Research Mode");
    expect(html).toContain("I understand — enable");
    expect(html).toContain("Cancel");

    // Each of the five sections renders its own headline.
    expect(html).toContain("What this is");
    expect(html).toContain("What this isn&#x27;t");
    expect(html).toContain("Why it&#x27;s an estimate");
    expect(html).toContain("Regulatory boundary");
    expect(html).toContain("Sources");

    // Cited regulatory references must appear verbatim in the
    // user-facing copy (Marc-Voice + research §11 + §12.4).
    expect(html).toContain("2017/745");
    expect(html).toContain("MDCG 2021-24");
    // Peer-reviewed citation.
    expect(html).toContain("10.1002/psp4.13099");

    // Version line surfaces the live server value.
    expect(html).toContain("Disclaimer version: 2026-05-14.1");
  });

  it("acknowledge CTA invokes the mutation with the supplied version", async () => {
    render(
      <ResearchModeAcknowledgmentDialog
        open={true}
        onOpenChange={() => {}}
        currentDisclaimerVersion="2026-05-14.1"
      />,
    );

    // SSR markup can't fire DOM events; invoke the mutation directly
    // (the production component calls `mutation.mutate(version)` from
    // the click handler with `currentDisclaimerVersion`).
    expect(mutationCallbacks.mutationFn).not.toBeNull();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { enabled: true } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await mutationCallbacks.mutationFn?.("2026-05-14.1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/auth/me/research-mode");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      acknowledged: true,
      version: "2026-05-14.1",
    });

    vi.unstubAllGlobals();
  });

  it("onSuccess fires the localised success toast", () => {
    const onAcknowledged = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ResearchModeAcknowledgmentDialog
        open={true}
        onOpenChange={onOpenChange}
        currentDisclaimerVersion="2026-05-14.1"
        onAcknowledged={onAcknowledged}
      />,
    );

    mutationCallbacks.onSuccess?.({ enabled: true });

    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.success).mock.calls[0][0]).toContain(
      "Research Mode enabled",
    );
    expect(onAcknowledged).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("stale-version error surfaces the localised error toast and keeps the dialog open", () => {
    const onOpenChange = vi.fn();
    render(
      <ResearchModeAcknowledgmentDialog
        open={true}
        onOpenChange={onOpenChange}
        currentDisclaimerVersion="2026-05-14.1"
      />,
    );

    mutationCallbacks.onError?.(new Error("research-mode.version.stale"));

    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error).mock.calls[0][0]).toContain(
      "disclaimer was updated",
    );
    // The error path never closes the dialog — the caller stays put
    // so the user can reload and re-read the new copy.
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("generic error path surfaces the generic error toast", () => {
    render(
      <ResearchModeAcknowledgmentDialog
        open={true}
        onOpenChange={() => {}}
        currentDisclaimerVersion="2026-05-14.1"
      />,
    );

    mutationCallbacks.onError?.(new Error("http-500"));

    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error).mock.calls[0][0]).toContain(
      "Could not enable Research Mode",
    );
  });

  it("acknowledge CTA is disabled until the server-supplied version arrives", () => {
    const html = render(
      <ResearchModeAcknowledgmentDialog
        open={true}
        onOpenChange={() => {}}
        currentDisclaimerVersion={null}
      />,
    );

    // The disabled flag stamps as `disabled=""` on a server-rendered button.
    // The acknowledge button carries `data-slot="research-mode-acknowledge"`.
    const acknowledgeFragment = html.match(
      /<button[^>]*data-slot="research-mode-acknowledge"[^>]*>/,
    )?.[0];
    expect(acknowledgeFragment).toBeDefined();
    expect(acknowledgeFragment).toMatch(/\sdisabled(="|\s|>)/);

    // The version line is hidden when null — guard against leaking
    // `version: null` text into the UI.
    expect(html).not.toContain("Disclaimer version:");
  });

  it("renders German copy when locale='de'", () => {
    const html = render(
      <ResearchModeAcknowledgmentDialog
        open={true}
        onOpenChange={() => {}}
        currentDisclaimerVersion="2026-05-14.1"
      />,
      "de",
    );
    expect(html).toContain("Forschungsmodus aktivieren");
    expect(html).toContain("Verstanden — aktivieren");
    expect(html).toContain("Abbrechen");
    expect(html).toContain("2017/745");
  });
});
