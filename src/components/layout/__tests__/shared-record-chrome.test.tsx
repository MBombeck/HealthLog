/**
 * The chrome that tells somebody whose record they are in.
 *
 * These render the real components to markup rather than asserting on their
 * source, because the property that matters is what a person sees. The suite
 * runs SSR-only (`@testing-library/react` is not a dependency here), so what
 * is proven is the paint: the banner appears exactly when the server says the
 * session is inside a record, it names the person, and the switcher offers
 * exactly the accounts the server published. What is NOT proven here is the
 * click — the switch itself is driven end to end in
 * `e2e/account-sharing.spec.ts`.
 *
 * Mutation checks, run:
 *   - make the banner render unconditionally (drop the `if (!active)` bail) →
 *     "renders nothing in the caller's own record" goes red.
 *   - make the switcher ignore `canSwitch` → "renders nothing when nothing is
 *     shared" goes red.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import type { AccountAccess } from "@/lib/sharing/account-access-view";

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
  useLogout: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/use-account-switch", () => ({
  useAccountSwitch: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { AccountSwitcherMenuItems } from "../account-switcher-menu";
import { SharedRecordBanner } from "../shared-record-banner";

const OWNER = {
  accountId: "acct-owner",
  username: "grandma",
  displayName: "Margarethe",
  fullName: null,
  access: "read" as const,
  level: "read" as const,
  sections: null,
  recordKind: "shared" as const,
  canWrite: false,
  writableDomains: [],
  manageableDomains: [],
};

function render(access: AccountAccess, node: React.ReactNode): string {
  mockAccessRef.value = access;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<SharedRecordBanner>", () => {
  it("renders nothing in the caller's own record", () => {
    const html = render(
      { accounts: [OWNER], active: null, canSwitch: true },
      <SharedRecordBanner />,
    );
    // Holding a grant is not being inside the record. A banner that appeared
    // on the strength of the list would claim a context the session is not in.
    expect(html).toBe("");
  });

  it("names the person whose record is open", () => {
    const html = render(
      { accounts: [OWNER], active: OWNER, canSwitch: true },
      <SharedRecordBanner />,
    );
    expect(html).toContain('data-slot="shared-record-banner"');
    expect(html).toContain('data-account-id="acct-owner"');
    // The display name, not the username: this is the line somebody reads
    // before they log a blood pressure.
    expect(html).toContain("Margarethe");
  });

  it("falls back to the username when the account set no display name", () => {
    const html = render(
      {
        accounts: [{ ...OWNER, displayName: null }],
        active: { ...OWNER, displayName: null },
        canSwitch: true,
      },
      <SharedRecordBanner />,
    );
    // Never an unnamed banner. "You are in 's record" is worse than useless.
    expect(html).toContain("grandma");
  });

  it("names the owner in full when they have a full name, to a read-only delegate", () => {
    // v1.37.2 — the banner is the account-access view that renders server-side,
    // and this OWNER is READ (`canWrite: false`). The full name leads over the
    // greeting name: a delegate about to log a reading sees whose record it is
    // as who they are, not by a nickname. A deliberate disclosure to everyone
    // shared with, read-only included (maintainer decision 2026-08-08).
    const named = {
      ...OWNER,
      fullName: "Test Full Name",
      displayName: "Margarethe",
    };
    const html = render(
      { accounts: [named], active: named, canSwitch: true },
      <SharedRecordBanner />,
    );
    expect(html).toContain('data-slot="shared-record-banner"');
    expect(html).toContain("Test Full Name");
  });

  it("says the access is read-only, and carries the way out", () => {
    const html = render(
      { accounts: [OWNER], active: OWNER, canSwitch: true },
      <SharedRecordBanner />,
    );
    expect(html).toContain('data-slot="shared-record-banner-exit"');
    expect(html).toContain("read it, not change it");
  });

  it("drops the read-only line when the server says the grant can write", () => {
    // Resolved server-side. The banner never decides what a grant permits; the
    // day a WRITE grant exists this line stops claiming otherwise on its own.
    const writable = {
      ...OWNER,
      access: "write" as const,
      level: "write" as const,
      canWrite: true,
    };
    const html = render(
      { accounts: [writable], active: writable, canSwitch: true },
      <SharedRecordBanner />,
    );
    expect(html).toContain('data-slot="shared-record-banner"');
    expect(html).not.toContain("read it, not change it");
  });

  it("names MANAGE and a managed profile without reducing either to add access", () => {
    const managedProfile = {
      ...OWNER,
      accountId: "managed-profile",
      access: "write" as const,
      level: "manage" as const,
      recordKind: "managed" as const,
      canWrite: true,
    };
    const html = render(
      {
        accounts: [managedProfile],
        active: managedProfile,
        canSwitch: true,
      },
      <SharedRecordBanner />,
    );

    expect(html).toContain('data-access-level="manage"');
    expect(html).toContain('data-record-kind="managed"');
    expect(html).toContain("Managed profile");
    expect(html).toContain("change or remove what is in it");
    expect(html).not.toContain("add to it, but not change");
  });

  it("uses the warning register, not a subtle tint", () => {
    // Somebody who stops noticing the banner logs their own reading into
    // another person's record. The visual register is part of the contract.
    const html = render(
      { accounts: [OWNER], active: OWNER, canSwitch: true },
      <SharedRecordBanner />,
    );
    expect(html).toContain("bg-warning/15");
    expect(html).toContain("border-warning/40");
  });

  it("keeps the warning-banner context copy at the foreground contrast floor", () => {
    const html = render(
      { accounts: [OWNER], active: OWNER, canSwitch: true },
      <SharedRecordBanner />,
    );
    const context = html.match(
      /<span[^>]*data-slot="shared-record-banner-context"[^>]*>/,
    )?.[0];

    expect(context).toContain("text-foreground");
    expect(context).not.toContain("text-muted-foreground");
  });
});

describe("<AccountSwitcherMenuItems>", () => {
  it("renders nothing when nothing is shared", () => {
    const html = render(
      { accounts: [], active: null, canSwitch: false },
      <AccountSwitcherMenuItems />,
    );
    // An account that has never used sharing sees the user menu it always saw.
    expect(html).toBe("");
  });

  it("binds canSwitch rather than the list length", () => {
    // The server publishes the boolean; the client renders it. A menu that
    // derived the affordance from `accounts.length` would be a second program
    // deciding whether this person may switch.
    const html = render(
      { accounts: [OWNER], active: null, canSwitch: false },
      <AccountSwitcherMenuItems />,
    );
    expect(html).toBe("");
  });

  // WHAT IS NOT PROVEN HERE. Nothing below renders the switcher's account
  // rows. Radix mounts `DropdownMenuSubContent` — and the `MenuContent` its
  // trigger requires — inside a portal, and portals do not render server-side
  // at all, so any assertion about the rows would be measuring the renderer
  // rather than the component. An earlier draft asserted on that markup and
  // passed for the wrong reason. The rows, their labels, the active tick and
  // the click are driven against a real browser in
  // `e2e/account-sharing.spec.ts`.
  //
  // What the two cases above DO prove is the gate, and they prove it sharply:
  // with the `canSwitch` bail removed they do not merely return different
  // markup, they throw, because the Radix sub-menu has no menu root here.
});
