/**
 * The emergency card in the account menu.
 *
 * The card is set up once and then waits in the background, so it left the
 * rail and the phone's More sheet for the account menu. This mounts the phone's
 * real account menu (the top bar's) and the desktop one's slice, opens them,
 * and reads what a person sees: the entry in one's own record and inside a
 * managed profile one looks after, and no entry inside an adult's shared
 * record, which is the rule the rail entry followed before.
 *
 * Mutation check, run: dropping the shared-record filter in
 * `visibleAccountMenuDestinations` turns "an adult's delegate does not see it"
 * red.
 */
import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AccountAccessEntry } from "@/lib/sharing/account-access-view";

import { renderWithApp } from "../../../../tests/browser/render";

vi.mock("@/hooks/use-account-switch", () => ({
  useAccountSwitch: () => ({
    mutate: vi.fn(),
    switchTo: vi.fn(),
    isPending: false,
  }),
}));

import { AccountMenuRecordItems } from "../account-menu-record-items";
import { TopBar } from "../top-bar";

function active(
  recordKind: "shared" | "managed",
  level: "read" | "write" | "manage",
): AccountAccessEntry {
  return {
    accountId: "acct-record",
    username: "record",
    displayName: null,
    fullName: "Record Holder",
    access: level === "read" ? "read" : "write",
    level,
    sections: null,
    recordKind,
    canWrite: level !== "read",
    writableDomains: [],
    manageableDomains: [],
  };
}

function cardLink(): HTMLAnchorElement | null {
  return document.querySelector<HTMLAnchorElement>(
    '[data-slot="account-menu-record-link"][href="/emergency-card"]',
  );
}

describe("the phone's account menu", () => {
  it("offers the emergency card in one's own record", async () => {
    await page.viewport(390, 844);
    await renderWithApp(<TopBar />);

    await userEvent.click(page.getByRole("button", { name: "User menu" }));
    await expect.poll(() => cardLink()).toBeTruthy();
    expect(cardLink()?.textContent).toBe("Emergency card");
    expect(cardLink()?.closest('[role="menu"]')).toBeTruthy();
  });
});

async function mountSlice(entry: AccountAccessEntry | null) {
  await renderWithApp(
    <DropdownMenu>
      <DropdownMenuTrigger>Account</DropdownMenuTrigger>
      <DropdownMenuContent className="w-60">
        <span data-slot="menu-open" />
        <AccountMenuRecordItems />
      </DropdownMenuContent>
    </DropdownMenu>,
    {
      user: {
        accountAccess: {
          accounts: entry ? [entry] : [],
          active: entry,
          canSwitch: entry !== null,
        },
      },
    },
  );
  await page.getByRole("button", { name: "Account" }).click();
  await expect
    .poll(() => document.querySelector('[data-slot="menu-open"]'))
    .toBeTruthy();
}

describe("the account-menu slice inside a shared record", () => {
  it("a managed profile's guardian sees the profile's card", async () => {
    await mountSlice(active("managed", "manage"));
    await expect.poll(() => cardLink()).toBeTruthy();
  });

  it("an adult's delegate does not see it", async () => {
    await mountSlice(active("shared", "manage"));
    expect(cardLink()).toBeNull();
  });
});
