/**
 * v1.39 (C2) — the setup flow, path 4: a child's managed profile.
 *
 * Q1 "someone I look after" keeps the questions in the guardian's own record
 * and creates the profile on the confirm screen, after the questions — the
 * maintainer's answer to spec question 2, and the only order the routes
 * allow, since the three writes refuse under an acting-account switch. The
 * answers are then applied to the CHILD: the completion carries the new
 * record's id, the derivation lands there (immunization log on, everything
 * the answers did not name off), and the guardian's own module map is left
 * exactly as it was. The first-result screen is not in the order (its tasks
 * would write the guardian's record), and the done screen offers the new
 * record through the same switch the account menu uses.
 *
 * This spec once asserted `glucose === false` on the GUARDIAN's map — the
 * review's H1 — which pinned the child's answers re-ordering a parent's own
 * record. It now reads the child's map through a real switch and the
 * guardian's map for being untouched, so a regression to deriving onto the
 * caller fails twice over.
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

    // The guardian's own record: flow complete, module map untouched — a
    // fresh account carries no explicit map, so nothing reads `false`.
    const me = await readMe(page);
    expect(me.onboarding.completedAt).not.toBeNull();
    expect(
      me.onboarding.steps.find((step) => step.id === "first-result")?.status,
    ).toBe("skipped");
    for (const key of ["glucose", "sleep", "mood", "labs", "medications"]) {
      expect(me.modules[key], `guardian module ${key}`).not.toBe(false);
    }
    const managedEntries = (me.accountAccess?.accounts ?? []).filter(
      (entry) => entry.recordKind === "managed",
    );
    expect(managedEntries).toHaveLength(1);

    // The child's record, read through a real switch: the answers landed
    // here. Switched back afterwards so the jar leaves the way it came.
    const switched = await page.request.post("/api/account/switch", {
      data: { accountId: managedEntries[0].accountId },
    });
    expect(switched.status(), "switching into the child's record").toBe(200);
    try {
      const child = await readMe(page);
      expect(child.modules.vaccinations).not.toBe(false);
      for (const key of ["glucose", "sleep", "mood", "labs", "medications"]) {
        expect(child.modules[key], `child module ${key}`).toBe(false);
      }
      expect(child.onboarding.needs.recordTarget).toBe("someone-else");
      expect(child.onboarding.completedAt).not.toBeNull();
    } finally {
      const back = await page.request.post("/api/account/switch", {
        data: { accountId: null },
      });
      expect(back.status(), "switching back").toBe(200);
    }

    await page.locator('[data-slot="onboarding-open-dashboard"]').click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/");
  });
});
