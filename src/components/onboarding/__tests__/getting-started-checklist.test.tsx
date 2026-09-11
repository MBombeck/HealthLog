/**
 * v1.39 (Wave C, C1) — the checklist's data queries follow the same rule as
 * its visibility.
 *
 * `shouldShowChecklist` gained `hasEnteredOnboardingFlow` as a third
 * disjunct; `checklistRelevant` in the component kept restating the older
 * half of the rule, so a wizard-run account past five readings still saw the
 * card while every supporting query was `enabled: false` — the medication,
 * data-source, notification and insights rows read "not done" for things the
 * account had already done (research I9).
 *
 * Rendered SSR-only, per this repo's component-test convention. `useQuery` is
 * mocked to honour `enabled` exactly the way tanstack does — a disabled query
 * has no data — so what the rows say here is what the dashboard says.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";
import type { AuthUser } from "@/hooks/use-auth";
import {
  defaultOnboardingSteps,
  emptyOnboardingNeeds,
  type OnboardingStateDto,
} from "@/lib/onboarding/needs";

let currentUser: AuthUser | null = null;
/** Every `enabled` flag the component asked for, keyed by its query key. */
const enabledByKey = new Map<string, boolean>();

vi.mock("@/hooks/use-auth", () => ({
  useAccountOnceMounted: () => currentUser,
}));

vi.mock("@/lib/queries/use-dashboard-snapshot", () => ({
  useDashboardSnapshot: () => ({
    data: { tiles: { summaries: { weight: { count: 12 } } } },
  }),
}));

const RESPONSES: Record<string, unknown> = {
  '["medications"]': [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
  '["user","ai-provider"]': { aiAvailable: true },
  '["integrations","status"]': {
    integrations: [{ integration: "whoop", connected: true }],
  },
  // Deliberately NOT configured: one open row keeps the card on screen, so
  // the rows this test is about are actually rendered.
  '["notifications","preferences"]': { channels: [{ enabled: false }] },
};

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: (options: {
      queryKey: readonly unknown[];
      enabled?: boolean;
    }) => {
      const key = JSON.stringify(options.queryKey);
      const enabled = options.enabled !== false;
      enabledByKey.set(key, enabled);
      return { data: enabled ? RESPONSES[key] : undefined };
    },
  };
});

const { GettingStartedChecklist } =
  await import("../getting-started-checklist");

/** A record the flow really finished: Q1 answered, confirmed, task settled. */
function settledOnboarding(): OnboardingStateDto {
  return {
    steps: defaultOnboardingSteps().map((step) => ({
      ...step,
      status: "done" as const,
    })),
    needs: { ...emptyOnboardingNeeds(), recordTarget: "me" },
    completedAt: "2026-09-10T08:00:00.000Z",
    firstResult: {
      task: "log-reading",
      target: null,
      completedAt: "2026-09-10T08:05:00.000Z",
    },
  } as OnboardingStateDto;
}

function user(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: "u1",
    email: "a@b.c",
    username: "a",
    heightCm: 175,
    dateOfBirth: "1990-01-01T00:00:00.000Z",
    gender: "MALE",
    onboardingCompletedAt: "2026-09-10T08:00:00.000Z",
    onboarding: settledOnboarding(),
    ...overrides,
  } as AuthUser;
}

function render(): string {
  enabledByKey.clear();
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <GettingStartedChecklist />
    </I18nProvider>,
  );
}

describe("<GettingStartedChecklist> — rows for an established account", () => {
  it("reads the real medication, data-source and insights state once the flow is behind the account", () => {
    currentUser = user();
    const html = render();

    // The card is on screen: the notifications row is genuinely open. The
    // list itself is collapsed on a server paint, so the progress meter is
    // what the rows add up to — profile, measurement, medication, data
    // source and insights done, notifications not.
    expect(html).toContain('data-testid="onboarding-card"');
    expect(html).toContain("5 of 6 done");
  });

  it("keeps the supporting queries enabled while the card can render", () => {
    currentUser = user();
    render();
    expect(enabledByKey.get('["medications"]')).toBe(true);
    expect(enabledByKey.get('["integrations","status"]')).toBe(true);
    expect(enabledByKey.get('["notifications","preferences"]')).toBe(true);
    expect(enabledByKey.get('["user","ai-provider"]')).toBe(true);
  });

  it("still fetches nothing for a record that never entered the flow and is long past five readings", () => {
    currentUser = user({ onboarding: null });
    render();
    expect(enabledByKey.get('["medications"]')).toBe(false);
    expect(enabledByKey.get('["integrations","status"]')).toBe(false);
  });
});
