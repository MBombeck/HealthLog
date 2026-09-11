/**
 * v1.38.19 (wave B / C1, C2, I1, I2, I3) — the connect arm of the one task
 * the flow ends on.
 *
 * This arm is the only place in the flow that renders a claim about real
 * account state, and it shipped without a test. It decided "connected" from
 * the ledger's `state` field, whose "no row" default was `connected` — so a
 * brand-new account that ticked WHOOP on Q4 was told WHOOP was connected and
 * had the flow's one result stamped as achieved on its behalf. It also had a
 * single piece of copy, "the first sync is in progress", for every outcome,
 * including the two that need the person to act.
 *
 * Vitest renders without a DOM here (project convention: SSR only), so what
 * is pinned is the first paint — which tile the screen paints for each of the
 * eight verdicts and what it says. Whether the result is RECORDED is decided
 * by `connectSourceView(...).settled` and pinned in
 * `src/lib/onboarding/__tests__/first-result-config.test.ts`, where the eight
 * verdicts are enumerated against the decision itself rather than its markup.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { SyncVerdict } from "@/lib/integrations/sync-verdict";
import {
  defaultOnboardingSteps,
  emptyOnboardingNeeds,
  type OnboardingStateDto,
} from "@/lib/onboarding/needs";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("../use-onboarding-flow", async () => {
  const actual = await vi.importActual<typeof import("../use-onboarding-flow")>(
    "../use-onboarding-flow",
  );
  return {
    ...actual,
    useOnboardingAnswer: () => ({
      mutateAsync: vi.fn().mockResolvedValue(undefined),
      isPending: false,
    }),
  };
});

const envelope = vi.hoisted(() => ({
  value: undefined as { isLoading: boolean; data: unknown } | undefined,
}));

vi.mock("@/components/settings/integrations/shared", async () => {
  const actual = await vi.importActual<
    typeof import("@/components/settings/integrations/shared")
  >("@/components/settings/integrations/shared");
  return {
    ...actual,
    useIntegrationStatuses: () => envelope.value,
  };
});

import { FirstResultScreen } from "../first-result-screen";

interface StatusOverrides {
  connected?: boolean;
  configured?: boolean;
  available?: boolean;
  state?: string;
  verdict?: SyncVerdict;
  since?: string | null;
  lastSuccessAt?: string | null;
}

function statuses(overrides: StatusOverrides | null) {
  envelope.value =
    overrides === null
      ? { isLoading: true, data: undefined }
      : {
          isLoading: false,
          data: {
            threshold: 3,
            integrations: [
              {
                integration: "whoop",
                connected: overrides.connected ?? false,
                configured: overrides.configured ?? true,
                available: overrides.available,
                state: overrides.state ?? "unknown",
                lastSuccessAt: overrides.lastSuccessAt ?? null,
                lastAttemptAt: null,
                lastError: null,
                consecutiveFailuresByKind: null,
                syncHealth: {
                  verdict: overrides.verdict ?? "disconnected",
                  since: overrides.since ?? null,
                },
                metricFreshness: [],
              },
            ],
          },
        };
}

function state(): OnboardingStateDto {
  return {
    steps: defaultOnboardingSteps(),
    needs: {
      ...emptyOnboardingNeeds(),
      recordTarget: "me",
      sources: ["whoop"],
    },
    completedAt: null,
    firstResult: null,
  };
}

function render(overrides: StatusOverrides | null) {
  statuses(overrides);
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <FirstResultScreen state={state()} />
    </I18nProvider>,
  );
}

const VERDICT_SLOT = [
  ["disconnected", "connect"],
  ["pending_first_sync", "result"],
  ["fresh", "result"],
  ["stale", "result"],
  ["stalled", "attention"],
  ["failing", "attention"],
  ["reauth_required", "attention"],
  ["parked", "attention"],
] as const;

describe("<FirstResultScreen> — the connect arm", () => {
  it.each(VERDICT_SLOT)(
    "paints the %s verdict on the %s tile",
    (verdict, slot) => {
      const html = render({
        connected: verdict !== "disconnected",
        verdict,
        since: "2026-09-01T00:00:00.000Z",
        lastSuccessAt: "2026-09-01T00:00:00.000Z",
      });
      expect(html).toContain(`data-connect-slot="${slot}"`);
    },
  );

  it("never claims a connection for a fresh account's empty ledger", () => {
    // The exact envelope a brand-new account publishes: no row for the
    // provider, so the ledger state is the synthetic `unknown`.
    const html = render({ connected: false, state: "unknown" });
    expect(html).toContain('data-connect-slot="connect"');
    expect(html).not.toContain("is connected");
    expect(html).not.toContain("The first sync is in progress");
  });

  it("says the first sync is running only while it actually is", () => {
    expect(
      render({ connected: true, verdict: "pending_first_sync" }),
    ).toContain("The first sync is in progress");
    expect(
      render({
        connected: true,
        verdict: "fresh",
        lastSuccessAt: "2026-09-01T00:00:00.000Z",
      }),
    ).not.toContain("The first sync is in progress");
  });

  it("names the state a connection that needs repairing is in", () => {
    const html = render({
      connected: true,
      verdict: "reauth_required",
      since: "2026-09-01T00:00:00.000Z",
    });
    expect(html).toContain("needs renewing");
    expect(html).toContain("/settings/integrations#whoop");
  });

  it("points a source the instance cannot connect at the credentials", () => {
    const html = render({ connected: false, configured: false });
    expect(html).toContain('data-connect-slot="credentials"');
    expect(html).toContain("no WHOOP app on file yet");
  });

  it("decides nothing while the status envelope is still in flight", () => {
    const html = render(null);
    expect(html).not.toContain("data-connect-slot=");
    expect(html).toContain('data-slot="onboarding-task-checking"');
  });
});
