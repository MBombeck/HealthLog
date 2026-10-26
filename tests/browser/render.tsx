/**
 * Render a component the way the app mounts it, in a real browser.
 *
 * The providers are the app's own: `I18nProvider` with a real catalog and a
 * real TanStack `QueryClient`. The signed-in account is seeded into that
 * client under `queryKeys.authMe()`, exactly where `useAuth` reads it once
 * `/api/auth/me` has answered, so a component that asks for the account gets
 * it without a request. Everything else a component fetches goes through the
 * network and is answered by `stubFetch()` from `./fetch-stub`.
 *
 * The app stylesheet is loaded by `setup.ts` for every browser test, so
 * `hidden`, `pointer-events-none`, popper placement and the breakpoints lay
 * out as they do in the app.
 *
 *   const { screen, queryClient } = await renderWithApp(<MeasurementForm />, {
 *     user: { unitPreference: "imperial" },
 *   });
 *   await screen.getByLabelText("Value (lb)").fill("210");
 */
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "vitest-browser-react";

import type { AuthUser } from "@/hooks/use-auth";
import type { Locale } from "@/lib/i18n/config";
import { I18nProvider } from "@/lib/i18n/context";
import { loadMessages } from "@/lib/i18n/load-locale";
import { queryKeys } from "@/lib/query-keys";

/** A signed-in account with every preference at its default. */
export function authUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: "user-1",
    username: "user",
    email: null,
    role: "USER",
    heightCm: null,
    dateOfBirth: null,
    gender: null,
    timezone: "UTC",
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    onboardingTourCompleted: true,
    onboardingTourProgress: null,
    avatarUrl: null,
    glucoseUnit: null,
    unitPreference: "metric",
    timeFormat: "AUTO",
    dateFormat: "AUTO",
    disableCoach: false,
    fullName: null,
    insurerName: null,
    insurerIkNumber: null,
    insuranceNumber: null,
    lastReportPracticeName: null,
    reportSelection: null,
    cycleTrackingEnabled: false,
    ...overrides,
  };
}

export interface RenderWithAppOptions {
  /** The reader's language. Its catalog is loaded before the first render. */
  locale?: Locale;
  /**
   * The signed-in account, merged over `authUser()`. `null` leaves the
   * account unanswered, as before `/api/auth/me` returns.
   */
  user?: Partial<AuthUser> | null;
  /** Bring a client to seed more reads before rendering. */
  queryClient?: QueryClient;
}

export interface AppRender {
  screen: RenderResult;
  queryClient: QueryClient;
}

/** A client configured like a test should want it: no retries, no refetch. */
export function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

export async function renderWithApp(
  ui: ReactNode,
  { locale = "en", user = {}, queryClient }: RenderWithAppOptions = {},
): Promise<AppRender> {
  const client = queryClient ?? testQueryClient();
  if (user !== null) client.setQueryData(queryKeys.authMe(), authUser(user));
  if (locale !== "en") await loadMessages(locale);
  const screen = await render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale={locale}>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
  return { screen, queryClient: client };
}
