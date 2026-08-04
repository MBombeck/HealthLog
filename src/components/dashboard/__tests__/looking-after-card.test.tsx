/**
 * The caregiver's front door, rendered.
 *
 * SSR-only, like the rest of the component suite: what is proven is the
 * paint — who the card lists and when it exists at all. The tap that switches
 * records is the switcher's existing mutation and is driven end to end in
 * `e2e/account-sharing.spec.ts`.
 *
 * Mutation checks, run:
 *   - drop the `accounts.length === 0` bail → "an account nobody shares with
 *     sees nothing" goes red.
 *   - drop the `active != null` bail → "no doorway into the room you are in"
 *     goes red.
 *   - render the level from `entry.access` instead of `entry.canWrite` → "the
 *     level is the server's resolved boolean" goes red.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { AccountAccess } from "@/lib/sharing/account-access-view";

const GRANDMOTHER = {
  accountId: "acct-gran",
  username: "gran",
  displayName: "Margarethe",
  access: "read" as const,
  level: "read" as const,
  sections: null,
  canWrite: false,
};
const FATHER = {
  accountId: "acct-dad",
  username: "dad",
  displayName: null,
  access: "write" as const,
  level: "write" as const,
  sections: null,
  canWrite: true,
};

const mockAccessRef: { value: AccountAccess } = {
  value: { accounts: [], active: null, canSwitch: false },
};

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "delegate",
      username: "delegate",
      email: null,
      role: "USER",
      avatarUrl: null,
      modules: {},
      accountAccess: mockAccessRef.value,
    },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-account-switch", () => ({
  useAccountSwitch: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { LookingAfterCard } from "../looking-after-card";

function render(access: AccountAccess): string {
  mockAccessRef.value = access;
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <LookingAfterCard />
    </I18nProvider>,
  );
}

describe("<LookingAfterCard>", () => {
  it("an account nobody shares with sees nothing", () => {
    // The v1.36.0 posture: the feature is invisible until it applies to you.
    // Not an empty state, not a prompt to ask somebody for access.
    expect(render({ accounts: [], active: null, canSwitch: false })).toBe("");
  });

  it("lists every record shared with this account", () => {
    const html = render({
      accounts: [GRANDMOTHER, FATHER],
      active: null,
      canSwitch: true,
    });
    expect(html).toContain('data-slot="looking-after-card"');
    expect(html).toContain('data-account-id="acct-gran"');
    expect(html).toContain('data-account-id="acct-dad"');
    // The display name where there is one, the username where there is not.
    expect(html).toContain("Margarethe");
    expect(html).toContain("dad");
  });

  it("the level is the server's resolved boolean", () => {
    const html = render({
      accounts: [GRANDMOTHER, FATHER],
      active: null,
      canSwitch: true,
    });
    expect(html).toContain("Can view and add");
    expect(html).toContain("Can view");
  });

  it("a grant labelled write but resolved read reads as read", () => {
    // `access` describes the row; `canWrite` is the decision the server made
    // about it this second. A grant that lapsed, or a level this build does
    // not honour, must not promise an add the next request would refuse.
    const html = render({
      accounts: [
        { ...FATHER, access: "write", level: "write", canWrite: false },
      ],
      active: null,
      canSwitch: true,
    });
    expect(html).toContain("Can view");
    expect(html).not.toContain("Can view and add");
  });

  it("shows no health data, only a doorway", () => {
    const html = render({
      accounts: [GRANDMOTHER],
      active: null,
      canSwitch: true,
    });
    // A preview would put somebody else's readings on this dashboard, outside
    // the banner frame that says which record you are looking at. The card
    // carries names and levels and nothing else.
    expect(html).not.toMatch(/\d+(\.\d+)?\s*(kg|mmHg|bpm)/);
  });

  it("no doorway into the room you are already in", () => {
    expect(
      render({
        accounts: [GRANDMOTHER],
        active: GRANDMOTHER,
        canSwitch: true,
      }),
    ).toBe("");
  });
});
