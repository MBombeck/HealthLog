/**
 * 1.50 — the person setup for "someone I look after": who, the areas and the
 * basics, then the managed profile at the end. The answers land on the new
 * record; the guardian's own modules stay as they were. "Later" creates
 * nothing and derives nothing onto anybody, and the card keeps the row.
 */
import {
  E2E_SETUP_CHILD,
  SETUP_CHILD_STORAGE_STATE_PATH,
} from "./setup/global-setup";
import {
  clearManagedProfilesOf,
  resetSetupFlow,
  stampFreshMfa,
} from "./setup/setup-flow-fixture";
import { expect, test } from "./setup/test";
import {
  acknowledge,
  choose,
  expectScreen,
  next,
  readMe,
  readSetup,
} from "./setup-flow-helpers";

const PROFILE_NAME = "Setup journey child";

// Serial: both tests reset and walk the ONE account.
test.describe.configure({ mode: "serial" });

async function walkYou(page: import("@playwright/test").Page) {
  await page.goto("/onboarding");
  await expectScreen(page, "who");
  await choose(page, "who", ["someone-else"]);
  await acknowledge(page);
  await next(page);
  await expectScreen(page, "areas");
  await choose(page, "areas", ["blood-pressure"]);
  await next(page);
  await expectScreen(page, "units");
  // Two segments for this answer: the record's questions and the profile.
  await expect(page.locator('[data-slot="stepper"]')).toHaveAttribute(
    "data-count",
    "2",
  );
  await next(page);
  await expectScreen(page, "profile");
}

test.describe("setup flow — a child's managed profile", () => {
  test.use({ storageState: SETUP_CHILD_STORAGE_STATE_PATH });

  test.beforeEach(async () => {
    await clearManagedProfilesOf(E2E_SETUP_CHILD.username);
    await resetSetupFlow(E2E_SETUP_CHILD.username);
    await stampFreshMfa(E2E_SETUP_CHILD.username);
  });

  test("creates the profile at the end and applies the answers to it", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await walkYou(page);

    await page.locator('[data-slot="managed-profile-name"]').fill(PROFILE_NAME);
    await page.locator('[data-slot="onboarding-next"]').click();
    await expect
      .poll(() => new URL(page.url()).pathname, {
        timeout: 15_000,
      })
      .toBe("/");

    const me = await readMe(page);
    expect(me.onboarding.completedAt).not.toBeNull();
    for (const key of ["glucose", "sleep", "mood", "labs", "medications"]) {
      expect(me.modules[key], `guardian module ${key}`).not.toBe(false);
    }
    const managedEntries = (me.accountAccess?.accounts ?? []).filter(
      (entry) => entry.recordKind === "managed",
    );
    expect(managedEntries).toHaveLength(1);

    const switched = await page.request.post("/api/account/switch", {
      data: { accountId: managedEntries[0].accountId },
    });
    expect(switched.status(), "switching into the child's record").toBe(200);
    try {
      const child = await readMe(page);
      for (const key of ["glucose", "sleep", "mood", "labs"]) {
        expect(child.modules[key], `child module ${key}`).toBe(false);
      }
      // The flow does not ask about medication; an unasked question leaves
      // the module at its default.
      expect(child.modules.medications, "child module medications").not.toBe(
        false,
      );
      expect(child.onboarding.needs.recordTarget).toBe("someone-else");
    } finally {
      const back = await page.request.post("/api/account/switch", {
        data: { accountId: null },
      });
      expect(back.status(), "switching back").toBe(200);
    }
  });

  test("later creates nothing, derives nothing, and keeps the row", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await walkYou(page);

    await page.locator('[data-slot="onboarding-profile-later"]').click();
    await expect
      .poll(() => new URL(page.url()).pathname, {
        timeout: 15_000,
      })
      .toBe("/");

    const me = await readMe(page);
    expect(me.onboarding.completedAt).not.toBeNull();
    for (const key of ["glucose", "sleep", "mood", "labs", "vaccinations"]) {
      expect(me.modules[key], `guardian module ${key}`).not.toBe(false);
    }
    expect((me.accountAccess?.accounts ?? []).length).toBe(0);

    const setup = await readSetup(page);
    expect(
      setup.person.tasks.find((task) => task.id === "managed-profile")?.status,
    ).toBe("todo");
    await expect(
      page.locator('[data-slot="setup-task"][data-task="managed-profile"]'),
    ).toBeVisible({ timeout: 15_000 });
  });
});
