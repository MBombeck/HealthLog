/**
 * v1.38.19 — the setup flow, path 5: a wearable on Q4.
 *
 * The connect arm is the only place in the flow that renders a claim about
 * real account state, and until this file no journey reached it: bp answers
 * `manual`, visit answers `file`, and the child path ends at confirm. The
 * a11y sweep does open the screen, but asserted the connect card was visible
 * — which it was, for the few hundred milliseconds before the status query
 * resolved. So the sweep passed THROUGH the defect it should have caught.
 *
 * Both cases here assert AFTER `GET /api/integrations/status` has settled,
 * which is the only moment at which the screen's claim means anything.
 *
 * Runs in one project (see `playwright.config.ts`): it resets and mutates its
 * own account.
 */
import pg from "pg";

import {
  E2E_SETUP_CONNECT,
  SETUP_CONNECT_STORAGE_STATE_PATH,
} from "./setup/global-setup";
import { resetSetupFlow } from "./setup/setup-flow-fixture";
import type { Page, Response } from "@playwright/test";

import { expect, test } from "./setup/test";
import { answer, expectScreen, readMe } from "./setup-flow-helpers";

function pool(): pg.Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("[setup-flow-connect] DATABASE_URL is not set");
  return new pg.Pool({ connectionString: url });
}

/**
 * Put the account's Oura back to "never connected". The journey's second case
 * writes a token column and a ledger row, neither of which `resetSetupFlow`
 * knows about — it resets the FLOW, and a leftover connection would make the
 * first case assert against the second case's state.
 */
async function clearOura(): Promise<void> {
  const db = pool();
  try {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE username = $1`,
      [E2E_SETUP_CONNECT.username],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("[setup-flow-connect] no account");
    await db.query(
      `UPDATE users SET oura_access_token_encrypted = NULL WHERE id = $1`,
      [id],
    );
    await db.query(
      `DELETE FROM integration_statuses WHERE user_id = $1 AND integration = 'oura'`,
      [id],
    );
  } finally {
    await db.end();
  }
}

/**
 * A connection that has been delivering for an hour: a stored token (the
 * envelope reads `connected` off the column's presence alone) and a ledger
 * row whose last success is recent enough for the `fresh` verdict.
 */
async function seedDeliveringOura(): Promise<void> {
  const db = pool();
  try {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE username = $1`,
      [E2E_SETUP_CONNECT.username],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("[setup-flow-connect] no account");
    await db.query(
      `UPDATE users SET oura_access_token_encrypted = 'e2e-placeholder' WHERE id = $1`,
      [id],
    );
    await db.query(
      `INSERT INTO integration_statuses
         (id, user_id, integration, state, last_success_at, last_attempt_at, created_at, updated_at)
       VALUES ($1, $2, 'oura', 'connected', NOW(), NOW(), NOW(), NOW())
       ON CONFLICT (user_id, integration) DO UPDATE
         SET state = 'connected',
             last_success_at = NOW(),
             last_attempt_at = NOW(),
             updated_at = NOW()`,
      [`e2e-connect-oura-${Date.now()}`, id],
    );
  } finally {
    await db.end();
  }
}

/**
 * Walk the questions through the API, then open the screen under test.
 *
 * `areas` decides whether the priority has anywhere to fall to when the Q4
 * source turns out to be connected already: a Q2 area is a `log-reading` task,
 * an empty Q2 is nothing.
 */
async function reachFirstResult(
  page: Page,
  areas: readonly string[],
): Promise<void> {
  await answer(page, { step: "who", recordTarget: "me" });
  await answer(page, {
    step: "areas",
    ...(areas.length > 0 ? { areas } : { status: "skipped" }),
  });
  await answer(page, { step: "medication", medication: "no" });
  await answer(page, { step: "sources", sources: ["oura"] });
  await answer(page, { step: "visit", visit: "no" });
  const settled = page.waitForResponse(
    (res: Response) =>
      res.url().includes("/api/integrations/status") && res.status() === 200,
  );
  await page.goto("/onboarding/confirm");
  await expectScreen(page, "confirm");
  await page.locator('[data-slot="onboarding-next"]').click();
  await expectScreen(page, "first-result");
  // Every assertion below is about what the screen says once it KNOWS.
  await settled;
}

// The three cases drive the one account, each setting up a different
// connection state. Run in parallel they would each walk the others' state.
test.describe.configure({ mode: "serial" });

test.describe("setup flow — a wearable on Q4", () => {
  test.use({ storageState: SETUP_CONNECT_STORAGE_STATE_PATH });

  test.beforeEach(async () => {
    await resetSetupFlow(E2E_SETUP_CONNECT.username);
    await clearOura();
  });

  test.afterAll(async () => {
    await clearOura();
  });

  test("never claims a connection the account does not have", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto("/onboarding");
    await reachFirstResult(page, ["sleep"]);

    // The tile the screen settled on: either the connect card, or — on an
    // instance with no Oura app configured — the credentials note. Never a
    // result: nothing was connected.
    const tile = page.locator("[data-connect-slot]");
    await expect(tile).toBeVisible({ timeout: 15_000 });
    const slot = await tile.getAttribute("data-connect-slot");
    expect(["connect", "credentials"]).toContain(slot);
    await expect(tile).toHaveAttribute("data-connect-state", "disconnected");
    await expect(
      page.locator('[data-slot="onboarding-first-result-done"]'),
    ).toHaveCount(0);

    // And the ledger was not stamped on the person's behalf.
    const me = await readMe(page);
    expect(me.onboarding.firstResult?.completedAt ?? null).toBeNull();
  });

  test("offers the next task instead of a connection that already works", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await seedDeliveringOura();
    await page.goto("/onboarding");
    await reachFirstResult(page, ["sleep"]);

    // The answers name one area as well, so the priority has somewhere to
    // fall to and the flow ends on something the person can actually do.
    await expect(page.locator("section[data-task]")).toHaveAttribute(
      "data-task",
      "log-reading",
    );
    await expect(
      page.locator('[data-slot="onboarding-task-connect"]'),
    ).toHaveCount(0);
  });

  test("acknowledges a connection that is already delivering", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await seedDeliveringOura();
    await page.goto("/onboarding");
    // Q2 passed over, so the connection is the only task the answers name.
    await reachFirstResult(page, []);

    const tile = page.locator('[data-connect-slot="result"]');
    await expect(tile).toBeVisible({ timeout: 15_000 });
    await expect(tile).toHaveAttribute("data-connect-state", "fresh");

    // The acknowledgment replaces the offer: the connect CTA is gone.
    await expect(
      page.locator('[data-slot="onboarding-task-connect"]'),
    ).toHaveCount(0);

    // A working connection is a result the flow may record.
    await expect
      .poll(async () => (await readMe(page)).onboarding.firstResult?.task, {
        timeout: 15_000,
      })
      .toBe("connect-source");
  });
});
