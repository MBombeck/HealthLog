import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The `/admin` snapshot renders its worker row red whenever the process
 * serving the page is not the worker — a split deployment where the web
 * container runs with `HEALTHLOG_PROCESS_TYPE=web`, or a worker that died.
 * `text-destructive` on the tile's `bg-muted/50` wash measured 3.97:1, under
 * the 4.5:1 floor, and `e2e/a11y.spec.ts` went red in exactly that state.
 *
 * jsdom cannot compute a contrast ratio, so this pins the token choice
 * instead: the destructive token paints the indicator, the wording stays in
 * `text-foreground`, and the running state keeps its `text-success` tint.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin",
}));

const workerRunning = { current: false };

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "admin" && queryKey[1] === "status") {
      return {
        data: {
          version: "1.38.14",
          nodeVersion: "v22.0.0",
          gitCommit: "abc1234",
          buildTime: "2026-09-10T00:00:00.000Z",
          startTime: "2026-09-10T00:00:00.000Z",
          database: "connected",
          worker: {
            running: workerRunning.current,
            startedAt: null,
            lastHeartbeat: null,
            lastReminderCheck: null,
            lastWithingsSync: null,
            lastInsightsRun: null,
            jobsProcessed: 0,
          },
          failingJobs: null,
          counts: {
            users: 1,
            measurements: 0,
            medications: 0,
            intakeEvents: 0,
            activeTokens: 0,
            activeSessions: 1,
          },
          integrations: { umami: null, glitchtip: null, webPush: null },
        },
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      };
    }
    return {
      data: null,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { SystemStatusSummary } from "../system-status-summary";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <SystemStatusSummary />
    </I18nProvider>,
  );
}

describe("admin snapshot worker row", () => {
  it("states an absent worker in the foreground token with a destructive indicator", () => {
    workerRunning.current = false;
    const html = render();

    expect(html).toContain("Stopped");
    // The state reads in the foreground token, which is AA on the tile wash.
    expect(html).toContain("text-foreground");
    // The destructive token survives as the indicator, not as the wording.
    expect(html).toContain('data-slot="status-item-indicator"');
    expect(html).toContain("bg-destructive");
    expect(html).not.toContain("text-destructive");
  });

  it("keeps the success tint when the worker is running", () => {
    workerRunning.current = true;
    const html = render();

    expect(html).toContain("Running");
    expect(html).toContain("text-success");
    expect(html).not.toContain('data-slot="status-item-indicator"');
  });
});
