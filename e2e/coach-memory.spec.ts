import type { Page, Route } from "@playwright/test";

import { expect, test } from "./setup/test";
import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { aiBlockAvailable, serveAiBlock } from "./setup/ai-capabilities";
import {
  FIXED_NOW,
  done,
  end,
  feed,
  installLiveCoachStream,
  posts,
  serveConversation,
  tokens,
  applyTheme,
  type StubConversation,
} from "./setup/coach-live-stream";

/**
 * What the Coach keeps, in the same quiet language as everything else in
 * the thread, and the thinking depth in its quick settings.
 *
 *   1. A fact it saved: one meta line under the answer, "Remembered: …",
 *      with Undo, which forgets it.
 *   2. A fact it proposes (health): no line; "Yes, remember it" / "No" as
 *      reply pills, a tap answers with `memoryDecision`.
 *   3. A plan it proposes: "Take on this plan" / "Not now", with
 *      `planDecision`. No plan card in the thread.
 *   4. The memory list in Settings → Coach: an entry is edited in place.
 *   5. The thinking depth: levels above the operator's cap are disabled and
 *      say so; with reasoning switched off the field is locked with one
 *      sentence.
 */

const CONVERSATION_ID = "coach-memory-e2e";

function fulfilJson(route: Route, data: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify({ data, error: null }),
  });
}

interface Fact {
  id: string;
  category: string;
  text: string;
  confidence: number;
  source: string;
  createdAt: string;
}

async function serveFacts(page: Page, facts: Fact[]) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  await page.route(
    /\/api\/insights\/coach\/facts(?:\/[^?]+)?(?:\?.*)?$/,
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      calls.push({
        method,
        path: url.pathname,
        body: method === "GET" ? null : request.postDataJSON(),
      });
      const id = url.pathname.split("/").pop() ?? "";
      if (method === "DELETE") {
        const at = facts.findIndex((f) => f.id === id);
        if (at !== -1) facts.splice(at, 1);
        return fulfilJson(route, { deleted: true });
      }
      if (method === "PATCH") {
        const fact = facts.find((f) => f.id === id);
        const next = (request.postDataJSON() as { fact: string }).fact;
        if (fact) fact.text = next;
        return fulfilJson(route, { fact });
      }
      return fulfilJson(route, { facts });
    },
  );
  return calls;
}

function stub(): StubConversation {
  return {
    id: CONVERSATION_ID,
    title: "Goals",
    messages: [],
    results: {},
    trails: {},
  };
}

async function send(page: Page, text: string) {
  await page.locator('[data-slot="coach-input-textarea"]').fill(text);
  await page.locator('[data-slot="coach-input-send"]').click();
}

async function answer(
  page: Page,
  conversation: StubConversation,
  turn: {
    userId: string;
    userText: string;
    id: string;
    text: string;
    metricSource: Record<string, unknown>;
    frames: unknown[];
    providerType?: string;
  },
) {
  conversation.messages.push(
    { id: turn.userId, role: "user", content: turn.userText },
    {
      id: turn.id,
      role: "assistant",
      content: turn.text,
      metricSource: turn.metricSource,
      providerType: turn.providerType,
    },
  );
  await feed(page, [
    ...tokens(turn.text),
    { type: "provenance", metricSource: turn.metricSource },
    ...turn.frames,
    done(CONVERSATION_ID, turn.id),
  ]);
  await end(page);
  await expect(
    page
      .locator('[data-slot="coach-bubble-assistant"]')
      .filter({ hasText: turn.text }),
  ).toBeVisible();
}

test.describe("Coach memory and plans", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "viewport-independent; desktop run suffices",
    );
    await page.clock.setFixedTime(FIXED_NOW);
    await applyTheme(page, "light");
  });

  test("a saved fact is one quiet line, and Undo forgets it", async ({
    page,
  }) => {
    await serveAiBlock(page, aiBlockAvailable());
    const facts: Fact[] = [
      {
        id: "fact-1",
        category: "goal",
        text: "You want to reach 75 kg by December",
        confidence: 1,
        source: "coach",
        createdAt: "2026-10-06T09:00:00.000Z",
      },
    ];
    const calls = await serveFacts(page, facts);
    const conversation = stub();
    await serveConversation(page, conversation);
    await installLiveCoachStream(page);
    await page.goto("/coach", { waitUntil: "domcontentloaded" });

    await send(page, "I want to reach 75 kg by December.");
    await answer(page, conversation, {
      userId: "coach-memory-e2e-u1",
      userText: "I want to reach 75 kg by December.",
      id: "coach-memory-e2e-a1",
      text: "That is about 3 kg from where you are now, a steady pace over ten weeks.",
      metricSource: {
        windows: [],
        metrics: ["weight"],
        memoryNote: { proposal: false, factId: "fact-1", category: "goal" },
      },
      frames: [
        {
          type: "memoryNote",
          note: {
            proposal: false,
            factId: "fact-1",
            category: "goal",
            fact: "You want to reach 75 kg by December",
          },
        },
      ],
    });

    const note = page.locator('[data-slot="coach-memory-note"]');
    await expect(note).toHaveText(
      /Remembered: You want to reach 75 kg by December\.\s*Undo/,
    );
    // No card, no accent: a meta line.
    await expect(note).toHaveClass(/text-muted-foreground/);
    await note.locator('[data-slot="coach-memory-note-undo"]').click();
    await expect(note).toHaveCount(0);
    expect(
      calls.some((c) => c.method === "DELETE" && c.path.endsWith("/fact-1")),
    ).toBe(true);
  });

  test("a proposed fact and a proposed plan are answered with reply pills", async ({
    page,
  }) => {
    await serveAiBlock(page, aiBlockAvailable());
    await serveFacts(page, []);
    const conversation = stub();
    await serveConversation(page, conversation);
    await installLiveCoachStream(page);
    await page.goto("/coach", { waitUntil: "domcontentloaded" });

    // A health fact is proposed, never saved by itself.
    await send(page, "I started taking ramipril in May.");
    await answer(page, conversation, {
      userId: "coach-memory-e2e-u1",
      userText: "I started taking ramipril in May.",
      id: "coach-memory-e2e-a1",
      text: "Your readings since May sit a little lower. Should I remember that you take ramipril since May?",
      metricSource: {
        windows: [],
        metrics: ["bp"],
        memoryNote: {
          proposal: true,
          proposalId: "p1",
          category: "medication",
        },
      },
      frames: [
        {
          type: "memoryNote",
          note: {
            proposal: true,
            proposalId: "p1",
            category: "medication",
            fact: "Takes ramipril since May",
          },
        },
      ],
    });
    await expect(page.locator('[data-slot="coach-memory-note"]')).toHaveCount(
      0,
    );
    const pills = page.locator('[data-slot="coach-suggested-replies"]');
    await expect(pills.locator("[data-reply-id]")).toHaveText([
      "Yes, remember it",
      "No",
    ]);
    await pills.locator('[data-reply-id="memory-accept"]').click();
    await expect(
      page
        .locator('[data-slot="coach-bubble-user"]')
        .filter({ hasText: "Yes, remember it" }),
    ).toBeVisible();
    expect((await posts(page))[1]).toMatchObject({
      message: "Yes, remember it",
      memoryDecision: {
        messageId: "coach-memory-e2e-a1",
        proposalId: "p1",
        accept: true,
      },
    });
    await answer(page, conversation, {
      userId: "coach-memory-e2e-u2",
      userText: "Yes, remember it",
      id: "coach-memory-e2e-a2",
      text: "Got it, I'll remember.",
      providerType: "decision",
      metricSource: { windows: [], metrics: [] },
      frames: [],
    });
    await expect(pills).toHaveCount(0);

    // A plan is one sentence in the answer, then two pills. No card.
    await send(page, "How do I stop snacking late?");
    await answer(page, conversation, {
      userId: "coach-memory-e2e-u3",
      userText: "How do I stop snacking late?",
      id: "coach-memory-e2e-a3",
      text: "When you finish dinner, then brush your teeth right away. I'll check in with you in 14 days.",
      metricSource: {
        windows: [],
        metrics: [],
        planProposal: { planId: "plan-1", metric: "WEIGHT", reviewInDays: 14 },
      },
      frames: [
        {
          type: "planProposal",
          proposal: {
            planId: "plan-1",
            metric: "WEIGHT",
            reviewInDays: 14,
            ifCue: "When you finish dinner",
            thenAction: "brush your teeth right away",
          },
        },
      ],
    });
    await expect(
      page.locator('[data-slot="coach-plan-proposal-card"]'),
    ).toHaveCount(0);
    await expect(pills.locator("[data-reply-id]")).toHaveText([
      "Take on this plan",
      "Not now",
    ]);
    await pills.locator('[data-reply-id="plan-decline"]').click();
    expect((await posts(page))[3]).toMatchObject({
      message: "Not now",
      planDecision: {
        messageId: "coach-memory-e2e-a3",
        planId: "plan-1",
        accept: false,
      },
    });
    await end(page);
  });

  test("an entry in the memory list is edited in place", async ({ page }) => {
    await serveAiBlock(page, aiBlockAvailable());
    const calls = await serveFacts(page, [
      {
        id: "fact-1",
        category: "goal",
        text: "Wants to reach 80 kg by autumn",
        confidence: 1,
        source: "user",
        createdAt: "2026-10-01T09:00:00.000Z",
      },
      {
        id: "fact-2",
        category: "preference",
        text: "Prefers morning workouts",
        confidence: 0.8,
        source: "coach",
        createdAt: "2026-10-02T09:00:00.000Z",
      },
    ]);
    await page.goto("/settings/coach#coach-memory", {
      waitUntil: "domcontentloaded",
    });
    const card = page.locator("#coach-memory");
    const rows = card.locator('[data-testid="settings-coach-memory-fact"]');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("from you");
    await expect(rows.nth(1)).toContainText("from the Coach");

    await rows
      .nth(0)
      .locator('[data-slot="settings-coach-memory-edit"]')
      .click();
    const input = rows
      .nth(0)
      .locator('[data-slot="settings-coach-memory-edit-input"]');
    await input.fill("Wants to reach 78 kg by December");
    await rows
      .nth(0)
      .locator('[data-slot="settings-coach-memory-edit-save"]')
      .click();
    await expect(rows.nth(0)).toContainText("Wants to reach 78 kg by December");
    expect(
      calls.find((c) => c.method === "PATCH" && c.path.endsWith("/fact-1"))
        ?.body,
    ).toEqual({ fact: "Wants to reach 78 kg by December" });
  });

  for (const scenario of [
    {
      name: "capped at Medium",
      block: {
        level: "medium",
        preference: "medium",
        maxLevel: "medium",
        available: true,
        offIsReal: true,
        source: "admin_cap",
      },
    },
    {
      name: "switched off by the operator",
      block: {
        level: "off",
        preference: "medium",
        maxLevel: "off",
        available: false,
        offIsReal: true,
        source: "admin_off",
      },
    },
  ]) {
    test(`thinking depth in the quick settings, ${scenario.name}`, async ({
      page,
    }) => {
      await page.route("**/api/auth/me", async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as {
          data: Record<string, unknown> | null;
        };
        if (body.data) {
          body.data.ai = aiBlockAvailable();
          body.data.coachReasoning = scenario.block;
        }
        await route.fulfill({ response, json: body });
      });
      await serveFacts(page, []);
      await serveConversation(page, stub());
      await page.goto("/coach", { waitUntil: "domcontentloaded" });
      await page.locator('[data-slot="coach-settings"]').first().click();
      const select = page.locator('[data-slot="coach-reasoning-select"]');
      await expect(select).toBeVisible();
      await expect(select.locator("option")).toHaveText([
        "Off",
        "Low",
        "Medium",
        scenario.block.available ? "High (limited by the admin)" : "High",
      ]);
      const field = page.locator('[data-slot="coach-reasoning-field"]');
      if (scenario.block.available) {
        await expect(select).toBeEnabled();
        await expect(select.locator('option[value="high"]')).toBeDisabled();
        await expect(field).toContainText("a little more waiting");
      } else {
        await expect(select).toBeDisabled();
        await expect(field).toContainText(
          "The admin has turned deeper thinking off.",
        );
      }
      // The memory link names how much the Coach keeps.
      await expect(
        page.locator('[data-slot="coach-settings-memory-link"]'),
      ).toHaveText("Memory (0)");
    });
  }
});
