/**
 * v1.39 (C2) — the setup flow, path 4: a child's managed profile.
 *
 * Q1 "someone I look after" keeps the questions in the guardian's own record
 * and creates the profile on the confirm screen, after the questions — the
 * maintainer's answer to spec question 2, and the only order the routes
 * allow, since the three writes refuse under an acting-account switch. The
 * immunization log is on for that answer, the first-result screen is not in
 * the order (its tasks would write the wrong record), and the done screen
 * offers the new record through the same switch the account menu uses.
 *
 * Creating the profile resolves `requireFreshMfa`, so the account carries a
 * confirmed factor (stamped by global setup after its login) and the fixture
 * makes the session's step-up fresh right before the walk.
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
  acceptAndSetUp,
  choose,
  expectScreen,
  next,
  readMe,
} from "./setup-flow-helpers";

const PROFILE_NAME = "Setup journey child";

test.describe("setup flow — a child's managed profile", () => {
  test.use({ storageState: SETUP_CHILD_STORAGE_STATE_PATH });

  test.beforeEach(async () => {
    await clearManagedProfilesOf(E2E_SETUP_CHILD.username);
    await resetSetupFlow(E2E_SETUP_CHILD.username);
    await stampFreshMfa(E2E_SETUP_CHILD.username);
  });

  test("creates the profile on the confirm screen and offers its record", async ({
    page,
  }) => {
    test.setTimeout(90_000);

    await page.goto("/onboarding");
    await acceptAndSetUp(page);

    await choose(page, "who", ["someone-else"]);
    await next(page);
    await expectScreen(page, "areas");
    await choose(page, "areas", ["blood-pressure"]);
    await next(page);
    await expectScreen(page, "medication");
    await choose(page, "medication", ["no"]);
    await next(page);
    await expectScreen(page, "sources");
    await choose(page, "sources", ["manual"]);
    await next(page);
    await expectScreen(page, "visit");
    await choose(page, "visit", ["no"]);
    await next(page);

    // The confirm screen is the managed-profile form for this answer.
    await expectScreen(page, "confirm");
    const managed = page.locator('[data-slot="onboarding-confirm-managed"]');
    await expect(managed).toBeVisible();
    await managed
      .locator('[data-slot="managed-profile-name"]')
      .fill(PROFILE_NAME);
    await managed
      .locator('[data-slot="managed-profile-create-submit"]')
      .click();

    // No first-result screen for this answer: straight to done, with the new
    // record offered.
    await expectScreen(page, "done");
    await expect(
      page.locator('[data-slot="onboarding-open-managed-record"]'),
    ).toBeVisible({ timeout: 15_000 });

    const me = await readMe(page);
    expect(me.modules.vaccinations).not.toBe(false);
    expect(me.modules.glucose).toBe(false);
    expect(me.onboarding.completedAt).not.toBeNull();
    expect(
      me.onboarding.steps.find((step) => step.id === "first-result")?.status,
    ).toBe("skipped");
    const managedEntries = (me.accountAccess?.accounts ?? []).filter(
      (entry) => entry.recordKind === "managed",
    );
    expect(managedEntries).toHaveLength(1);

    await page.locator('[data-slot="onboarding-open-dashboard"]').click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/");
  });
});
