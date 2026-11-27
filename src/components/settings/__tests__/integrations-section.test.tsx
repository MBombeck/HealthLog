/**
 * Settings → Integrations: two lists of what is set up, one status chip per
 * row, every word from the server's overview.
 *
 * The tests pin, on the whole section:
 *   1. only set-up integrations are rows, in their group, sources first;
 *   2. each row carries exactly one status chip, with the server's status;
 *   3. an active row says when it last worked, any other row says why;
 *   4. no stored provider error or failure counter reaches the page;
 *   5. "Add" lists what is offered and not set up, and nothing else.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  IntegrationOverview,
  IntegrationOverviewItem,
} from "@/lib/integrations/overview";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/integrations",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", role: "USER" },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

let overview: IntegrationOverview | null = null;
let envelope: unknown = null;

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const key = Array.isArray(queryKey) ? queryKey.join("/") : "";
    if (key === "integrations/status/overview") {
      return { data: overview ?? undefined, isLoading: !overview };
    }
    if (key === "integrations/status") {
      return { data: envelope, isLoading: false };
    }
    return { data: null, isLoading: false, refetch: vi.fn() };
  },
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { addableItems } from "../integrations/integration-add-sheet";
import { IntegrationsSection } from "../integrations-section";

const CALLBACK_URLS = {
  withings: "https://app.example/api/withings/callback",
  whoop: "https://app.example/api/whoop/callback",
  "google-health": "https://app.example/api/google-health/callback",
  polar: "https://app.example/api/polar/callback",
  oura: "https://app.example/api/oura/callback",
  strava: "https://app.example/api/strava/callback",
};

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <IntegrationsSection callbackUrls={CALLBACK_URLS} />
    </I18nProvider>,
  );
}

function item(
  key: IntegrationOverviewItem["key"],
  patch: Partial<IntegrationOverviewItem> = {},
): IntegrationOverviewItem {
  const channel = [
    "telegram",
    "ntfy",
    "web-push",
    "webhook",
    "email",
    "apns",
  ].includes(key);
  return {
    key,
    group: channel ? "channel" : "source",
    setUp: false,
    status: null,
    reason: null,
    lastAt: null,
    offered: true,
    setupNote: null,
    ...patch,
  };
}

const TODAY = new Date().toISOString();

beforeEach(() => {
  envelope = {
    threshold: 3,
    integrations: [
      {
        integration: "withings",
        lastError: "Withings refresh error: 503 - upstream",
        consecutiveFailuresByKind: {
          transient: 2,
          reauth_required: 0,
          persistent: 0,
        },
        connected: true,
        configured: true,
      },
    ],
  };
  overview = {
    items: [
      item("apple-health", {
        setUp: true,
        status: "active",
        reason: "data_arriving",
        lastAt: TODAY,
      }),
      item("withings", {
        setUp: true,
        status: "error",
        reason: "reauth_required",
        lastAt: "2026-11-24T06:12:00.000Z",
      }),
      item("oura", { setupNote: "own_credentials" }),
      item("dawarich", { offered: false }),
      item("telegram", { setUp: true, status: "active", lastAt: TODAY }),
      item("ntfy", { setUp: true, status: "off", reason: "switched_off" }),
      item("email", { offered: false }),
      item("webhook"),
      item("apns", { offered: false }),
    ],
  };
});

function rows(html: string): string[] {
  return [...html.matchAll(/data-testid="integration-row-([a-z-]+)"/g)].map(
    (m) => m[1],
  );
}

describe("IntegrationsSection — the lists", () => {
  it("shows only what is set up, sources before channels", () => {
    expect(rows(render())).toEqual([
      "apple-health",
      "withings",
      "telegram",
      "ntfy",
    ]);
  });

  it("gives each row exactly one chip, with the server's status", () => {
    const html = render();
    expect(html.match(/data-slot="status-chip"/g)).toHaveLength(4);
    expect(html).toMatch(
      /data-integration="withings" data-status="error"[\s\S]*?data-slot="status-chip"[^>]*data-tone="error"/,
    );
    expect(html).not.toContain('data-slot="integration-health-badge"');
  });

  it("says when an active row last worked and why any other row is not", () => {
    const html = render();
    expect(html).toContain("Sign-in expired");
    expect(html).toContain("Switched off");
    expect(html).toMatch(/Last today, \d/);
  });

  it("never shows the stored provider error or a failure counter", () => {
    const html = render();
    expect(html).not.toContain("Withings refresh error");
    expect(html).not.toContain("consecutive failures");
  });

  it("paints the card headers while the overview loads", () => {
    overview = null;
    const html = render();
    expect(html).toContain("Data sources");
    expect(html).toContain('aria-busy="true"');
    expect(rows(html)).toEqual([]);
  });
});

describe("IntegrationsSection — Add", () => {
  it("lists what is offered and not set up, nothing the server cannot offer", () => {
    expect(addableItems(overview!.items).map((i) => i.key)).toEqual([
      "oura",
      "webhook",
    ]);
  });
});
