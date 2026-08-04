/**
 * "Take all due" and who is offered it.
 *
 * v1.36.1 withheld the sweep from a delegate on a note saying it rides the
 * bulk intake route. It does not, and `take-all-due.ts` says so at length: it
 * loops `POST /api/medications/{id}/intake`, the delegable write, and each
 * request is byte-identical to tapping that medication's own button. So a
 * caregiver with five morning tablets to confirm was tapping five times for
 * nothing, on the release that exists to let them confirm doses at all.
 *
 * Rendered rather than described, on the three capability states. SSR-only, so
 * this holds the paint and never the click; the loop's own behaviour is pinned
 * in `take-all-due.test.ts` and the browser leg in `e2e/account-sharing.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { AccountAccess } from "@/lib/sharing/account-access-view";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));

const accessRef: { value: AccountAccess } = {
  value: { accounts: [], active: null, canSwitch: false },
};

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: {
      timezone: "Europe/Berlin",
      accountAccess: accessRef.value,
    },
  }),
}));

vi.mock("@/components/medications/wizard/medication-wizard-dialog", () => ({
  MedicationWizardDialog: () => null,
}));
vi.mock("@/components/medications/log-intake-dialog", () => ({
  LogIntakeDialog: () => null,
}));

import MedicationsPage from "@/app/medications/page-client";
import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

const OWNER = {
  accountId: "acct-owner",
  username: "owner",
  displayName: "Margarethe",
  access: "read" as const,
  level: "read" as const,
  sections: null,
  canWrite: false,
};

const OWN_RECORD: AccountAccess = {
  accounts: [OWNER],
  active: null,
  canSwitch: true,
};
const READ_ONLY: AccountAccess = {
  accounts: [OWNER],
  active: OWNER,
  canSwitch: true,
};
const WRITABLE: AccountAccess = {
  accounts: [OWNER],
  active: { ...OWNER, access: "write", level: "write", canWrite: true },
  canSwitch: true,
};

/** A window straddling the frozen clock below, so both medications read due. */
const openWindow = {
  windowStart: "11:00",
  windowEnd: "13:00",
  label: null,
  daysOfWeek: null,
  dose: null,
};

/** Two due medications — the button earns its slot only from the second. */
const DUE_MEDS = [
  {
    id: "m1",
    name: "Ramipril",
    dose: "5 mg",
    category: "OTHER",
    active: true,
    notificationsEnabled: true,
    pausedAt: null,
    lastTakenAt: null,
    todayEventCount: 0,
    stockDosesRemaining: null,
    schedules: [{ id: "s1", ...openWindow }],
  },
  {
    id: "m2",
    name: "Aspirin",
    dose: "100 mg",
    category: "OTHER",
    active: true,
    notificationsEnabled: true,
    pausedAt: null,
    lastTakenAt: null,
    todayEventCount: 0,
    stockDosesRemaining: null,
    schedules: [{ id: "s2", ...openWindow }],
  },
];

function render(access: AccountAccess): string {
  accessRef.value = access;
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  });
  client.setQueryData(queryKeys.medications(), DUE_MEDS);
  client.setQueryData(queryKeys.medicationListLayout(), {
    version: 1,
    view: "cards",
    order: [],
  });
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <QueryClientProvider client={client}>
        <MedicationsPage />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // Inside the 11:00–13:00 window in Europe/Berlin (UTC+2 in August).
  vi.setSystemTime(new Date("2026-08-04T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const TAKE_ALL = "Take all due";

describe("take all due", () => {
  it("is offered in the caller's own record", () => {
    // The control this whole file is about: without it, the fixture is not
    // producing a due set and every negative below would be vacuous.
    expect(render(OWN_RECORD)).toContain(TAKE_ALL);
  });

  it("is offered to a delegate who may write", () => {
    // Marking a dose is the admitted verb; doing it for several medications
    // at once is the same verb, N times, over the same route.
    expect(render(WRITABLE)).toContain(TAKE_ALL);
  });

  it("is absent for a read-only delegate", () => {
    expect(render(READ_ONLY)).not.toContain(TAKE_ALL);
  });
});
