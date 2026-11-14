/**
 * The record switcher inside the account menu, at phone and desktop width
 * (#1372).
 *
 * On a phone the account menu sits against the right edge of the top bar and
 * takes most of the width. The records used to open in a side sub-menu that
 * had room on neither side, so it ran off the screen and cut the names off.
 * Below `sm` they now unfold inside the account menu itself; at desktop width
 * the side sub-menu stays.
 *
 * The harness mounts the switcher the way the top bar does: a right-aligned
 * trigger, `align="end"`, a `w-60` menu.
 *
 * Mutation check, run: forcing the side sub-menu at every width (the
 * component before the fix) turns "unfolds the records inside the account
 * menu" red, because the entries land outside the viewport and outside the
 * account menu.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AccountAccessEntry } from "@/lib/sharing/account-access-view";

import { renderWithApp } from "../../../../tests/browser/render";

const switchTo = vi.fn();
const mutate = vi.fn();

vi.mock("@/hooks/use-account-switch", () => ({
  useAccountSwitch: () => ({ mutate, switchTo, isPending: false }),
}));

import { AccountSwitcherMenuItems } from "../account-switcher-menu";

function entry(
  accountId: string,
  fullName: string,
  recordKind: "shared" | "managed",
): AccountAccessEntry {
  return {
    accountId,
    username: accountId,
    displayName: null,
    fullName,
    access: "read",
    level: "read",
    sections: null,
    recordKind,
    canWrite: false,
    writableDomains: [],
    manageableDomains: [],
  };
}

const ACCOUNTS = [
  entry("acct-a", "Alexandra Konstantinopoulou-Wetherington", "shared"),
  entry("acct-b", "Maximilian Oberhausen", "managed"),
];

async function mountMenu() {
  await renderWithApp(
    <div className="flex justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger>Account</DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem>Settings</DropdownMenuItem>
          <AccountSwitcherMenuItems />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>,
    {
      user: {
        accountAccess: { accounts: ACCOUNTS, active: null, canSwitch: true },
      },
    },
  );
  await page.getByRole("button", { name: "Account" }).click();
  await expect
    .poll(() =>
      document.querySelector('[data-slot="account-switcher-trigger"]'),
    )
    .toBeTruthy();
}

function trigger(): HTMLElement {
  return document.querySelector<HTMLElement>(
    '[data-slot="account-switcher-trigger"]',
  )!;
}

function entries(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '[data-slot="account-switcher-entry"]',
    ),
  ];
}

afterEach(() => {
  switchTo.mockClear();
  mutate.mockClear();
});

describe("the record switcher at phone width", () => {
  it("unfolds the records inside the account menu", async () => {
    await page.viewport(390, 844);
    await mountMenu();

    await userEvent.click(trigger());
    await expect.poll(() => entries().length).toBe(ACCOUNTS.length);

    const accountMenu = trigger().closest('[role="menu"]');
    for (const row of entries()) {
      // In the account menu, not in a menu of its own beside it.
      expect(row.closest('[role="menu"]')).toBe(accountMenu);
      const box = row.getBoundingClientRect();
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(window.innerWidth);
      // A finger-sized row.
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the account menu open while the list unfolds and folds", async () => {
    await page.viewport(390, 844);
    await mountMenu();

    expect(entries()).toHaveLength(0);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");

    await userEvent.click(trigger());
    await expect.poll(() => entries().length).toBe(ACCOUNTS.length);

    await userEvent.click(trigger());
    await expect.poll(() => entries().length).toBe(0);
    // The account menu itself is still there.
    expect(trigger()).toBeTruthy();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the chosen record from the inline list", async () => {
    await page.viewport(390, 844);
    await mountMenu();

    await userEvent.click(trigger());
    await expect.poll(() => entries().length).toBe(ACCOUNTS.length);
    await userEvent.click(
      document.querySelector<HTMLElement>(
        '[data-slot="account-switcher-entry"][data-account-id="acct-b"]',
      )!,
    );

    expect(switchTo).toHaveBeenCalledTimes(1);
    expect(switchTo.mock.calls[0][0]).toBe("acct-b");
  });
});

describe("the record switcher at desktop width", () => {
  it("keeps the side sub-menu", async () => {
    await page.viewport(1280, 900);
    await mountMenu();

    expect(trigger().hasAttribute("data-presentation")).toBe(false);
    await userEvent.click(trigger());
    await expect.poll(() => entries().length).toBe(ACCOUNTS.length);

    const accountMenu = trigger().closest('[role="menu"]');
    for (const row of entries()) {
      const menu = row.closest('[role="menu"]');
      expect(menu).toBeTruthy();
      expect(menu).not.toBe(accountMenu);
    }
  });
});
