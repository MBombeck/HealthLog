import { expect, test } from "./setup/test";
import type { Route } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { hash } from "@node-rs/argon2";
import pg from "pg";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { aiBlockAvailable, serveAiBlock } from "./setup/ai-capabilities";

const KEEP_ID = "conversation-delete-keep";
const DROP_ID = "conversation-delete-drop";

function row(id: string, title: string) {
  return {
    id,
    title,
    createdAt: "2026-07-20T10:00:00.000Z",
    updatedAt: "2026-07-20T10:00:00.000Z",
    messageCount: 2,
    fenced: false,
    attachments: [],
    documentTitle: null,
  };
}

/**
 * A deleted conversation must stay deleted. The delete waits out an undo
 * window before it is sent; a reload inside that window used to drop it, and
 * once the window ran out the row showed again until the refetch landed.
 */
test.describe("Coach conversation delete", () => {
  test.beforeEach(async ({ page }) => {
    await serveAiBlock(page, aiBlockAvailable());
  });

  test.use({ storageState: STORAGE_STATE_PATH });

  async function serveConversations(
    page: import("@playwright/test").Page,
    deleteDelayMs: number,
  ) {
    const state = {
      rows: [row(KEEP_ID, "Kept thread"), row(DROP_ID, "Dropped thread")],
      deletes: [] as string[],
    };
    // Context-level, so a `keepalive` request sent while the page unloads is
    // still answered here.
    await page
      .context()
      .route(
        /\/api\/insights\/chat(?:\/[^?]+)?(?:\?|$)/,
        async (route: Route) => {
          const request = route.request();
          const url = new URL(request.url());
          if (request.method() === "DELETE") {
            const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
            state.deletes.push(id);
            state.rows = state.rows.filter((r) => r.id !== id);
            if (deleteDelayMs > 0) await delay(deleteDelayMs);
            return route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ data: { deleted: true }, error: null }),
            });
          }
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              data: { conversations: state.rows, nextCursor: null },
              error: null,
            }),
          });
        },
      );
    return state;
  }

  test("the row does not come back when the window runs out", async ({
    page,
  }) => {
    // A slow DELETE holds the refetch back, which is when the row used to
    // reappear.
    const state = await serveConversations(page, 2_000);
    await page.goto("/coach/conversations", { waitUntil: "domcontentloaded" });

    const items = page.locator('[data-slot="coach-conversations-item"]');
    await expect(items).toHaveCount(2, { timeout: 10_000 });
    await items
      .filter({ hasText: "Dropped thread" })
      .locator('[data-slot="coach-conversations-delete"]')
      .click();
    await expect(items).toHaveCount(1);

    await expect
      .poll(() => state.deletes, { timeout: 15_000 })
      .toEqual([DROP_ID]);
    // Sampled while the DELETE is still in flight.
    for (let i = 0; i < 6; i += 1) {
      expect(await items.count()).toBe(1);
      await delay(250);
    }
    await expect(items).toContainText("Kept thread");
  });
});

/**
 * The real server and database, not a mock: the request that matters here is
 * sent with `keepalive` while the page unloads, which Playwright's routing
 * never sees. The account is the spec's own, so the conversation it seeds
 * cannot surface in another spec's Coach.
 */
test.describe("Coach conversation delete against the database", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a reload inside the undo window still deletes", async ({
    page,
  }, testInfo) => {
    const dbUrl = process.env.DATABASE_URL;
    test.skip(!dbUrl, "DATABASE_URL is required to seed the conversation");

    const suffix = `${testInfo.project.name}-${randomBytes(4).toString("hex")}`;
    const username = `e2e-coach-delete-${suffix}`;
    const password = "Cd5!Vq8nTz3wLp7K";
    const userId = `e2e-coach-delete-user-${suffix}`;
    const conversationId = `e2e-coach-delete-${suffix}`;
    const pool = new pg.Pool({ connectionString: dbUrl });
    try {
      await pool.query(
        `INSERT INTO users
           (id, username, email, password_hash, role, created_at, updated_at,
            onboarding_completed_at, onboarding_tour_completed)
         VALUES ($1, $2, $3, $4, 'USER', now(), now(), now(), true)`,
        [
          userId,
          username,
          `${username}@healthlog.test`,
          await hash(password, {
            memoryCost: 19456,
            timeCost: 2,
            outputLen: 32,
            parallelism: 1,
          }),
        ],
      );
      // A legacy readable title keeps the seed free of the encryption key.
      await pool.query(
        `INSERT INTO coach_conversations (id, user_id, title, updated_at)
         VALUES ($1, $2, 'Dropped thread', now())`,
        [conversationId, userId],
      );

      const login = await page.request.post("/api/auth/login", {
        data: { email: username, password },
      });
      expect(login.status()).toBe(200);

      await page.goto("/coach/conversations", {
        waitUntil: "domcontentloaded",
      });
      const items = page.locator('[data-slot="coach-conversations-item"]');
      await expect(items).toHaveCount(1, { timeout: 15_000 });
      await items.locator('[data-slot="coach-conversations-delete"]').click();
      await expect(items).toHaveCount(0);

      // Well inside the undo window.
      await page.reload({ waitUntil: "domcontentloaded" });

      await expect
        .poll(async () => {
          const { rowCount } = await pool.query(
            "SELECT 1 FROM coach_conversations WHERE id = $1",
            [conversationId],
          );
          return rowCount;
        })
        .toBe(0);
      await expect(
        page.locator('[data-slot="coach-conversations-empty"]'),
      ).toBeVisible({ timeout: 15_000 });
      await expect(items).toHaveCount(0);
    } finally {
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
      await pool.end();
    }
  });
});
