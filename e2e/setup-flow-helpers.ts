/**
 * v1.39 — driving the setup flow in a browser, shared by its journeys.
 *
 * Everything here addresses stable `data-slot` / `data-*` attributes, never
 * viewport text: the copy is i18n-driven and one of the specs runs every
 * locale. The API helpers ride the page's own cookie jar, so what they write
 * lands on the account the browser is signed in as.
 */
import { expect, type Page } from "@playwright/test";

export type SetupScreen =
  | "welcome"
  | "who"
  | "areas"
  | "medication"
  | "sources"
  | "visit"
  | "units"
  | "confirm"
  | "reminders"
  | "ai"
  | "first-result"
  | "done"
  // The server setup (1.49), in the same frame.
  | "accounts"
  | "notifications"
  | "privacy"
  | "health";

export const SHELL = '[data-slot="onboarding-shell"]';

export async function expectScreen(page: Page, screen: SetupScreen) {
  await expect(page.locator(SHELL)).toHaveAttribute("data-screen", screen, {
    timeout: 15_000,
  });
}

/** Tick one or more chips of the question on screen. */
export async function choose(
  page: Page,
  question: string,
  values: readonly string[],
): Promise<void> {
  for (const value of values) {
    await page
      .locator(
        `[data-slot="onboarding-question-${question}"] [data-slot="onboarding-choice"][data-value="${value}"]`,
      )
      .click();
  }
}

export async function next(page: Page): Promise<void> {
  await page.locator('[data-slot="onboarding-next"]').click();
}

export async function skip(page: Page): Promise<void> {
  await page.locator('[data-slot="onboarding-skip"]').click();
}

/**
 * 1.49 — pass the follow-ups the flow shows after confirm, in order, by
 * skipping each: `reminders` for a medication schedule or a mood or cycle
 * area, `ai` while the server offers the Coach (it does on the e2e server,
 * which has AI switched on and no provider, so a person could set one up).
 * The caller names the ones it expects, so a follow-up that appears or
 * vanishes unexpectedly fails here rather than being stepped over.
 */
export async function skipFollowUps(
  page: Page,
  expected: ReadonlyArray<"reminders" | "ai">,
): Promise<void> {
  for (const screen of expected) {
    await expectScreen(page, screen);
    await skip(page);
  }
}

/** The follow-up answers through the API, for specs that jump ahead. */
export async function passFollowUps(page: Page): Promise<void> {
  await answer(page, { step: "reminders", status: "skipped" });
  await answer(page, { step: "ai", status: "skipped" });
}

/** The welcome screen's acknowledgment plus "Set up". */
export async function acceptAndSetUp(page: Page): Promise<void> {
  await expectScreen(page, "welcome");
  const box = page.locator('[data-slot="onboarding-disclaimer"]');
  if ((await box.getAttribute("data-state")) !== "checked") {
    await box.click();
  }
  await page.locator('[data-slot="onboarding-set-up"]').click();
  await expectScreen(page, "who");
}

/**
 * One call on the browser's own session, sent with the page's own fetch.
 *
 * Every Playwright API context in the runner shares one keep-alive agent,
 * and it can hand out a socket the server already closed on its idle
 * timeout; the call then dies with `read ECONNRESET` and CI counts the retry
 * as a failure. The page opens its own connection. A page that has not
 * navigated yet has no origin to fetch against, so it first opens the public
 * version endpoint: the specs call these helpers before their first real
 * navigation, and routing that case back through the API context is what
 * kept the flake alive.
 */
async function sessionCall(
  page: Page,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  if (!page.url().startsWith("http")) {
    await page.goto("/api/version", { waitUntil: "domcontentloaded" });
  }
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(path, {
        method,
        headers:
          body === undefined
            ? undefined
            : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    { method, path, body },
  );
}

/** The account payload, as the browser's session sees it. */
export async function readMe(page: Page): Promise<MePayload> {
  const res = await sessionCall(page, "GET", "/api/auth/me");
  expect(res.status, "reading the account payload").toBe(200);
  return (res.json as { data: MePayload }).data;
}

export interface MePayload {
  modules: Record<string, boolean>;
  onboarding: {
    steps: Array<{ id: string; status: string }>;
    needs: { recordTarget: string | null; areas: string[] };
    completedAt: string | null;
    firstResult: { task: string; completedAt: string | null } | null;
  };
  accountAccess?: {
    accounts: Array<{ accountId: string; recordKind: string }>;
  };
}

/** The dashboard layout's tile ids, in order. */
export async function readTileOrder(page: Page): Promise<string[]> {
  const res = await sessionCall(page, "GET", "/api/dashboard/widgets");
  expect(res.status, "reading the dashboard layout").toBe(200);
  const { data } = res.json as {
    data: { widgets: Array<{ id: string; order: number }> };
  };
  return [...data.widgets].sort((a, b) => a.order - b.order).map((w) => w.id);
}

/** One answer through the answers route, on the browser's own session. */
export async function answer(page: Page, body: unknown): Promise<void> {
  const res = await sessionCall(page, "PATCH", "/api/onboarding/answers", body);
  expect(res.status, `answering ${JSON.stringify(body)}`).toBe(200);
}

export async function complete(page: Page): Promise<void> {
  const res = await sessionCall(page, "POST", "/api/onboarding/complete", {});
  expect(res.status, "completing the flow").toBe(200);
}

/**
 * Answer every question through the API so a later screen can be visited
 * directly. The answers name a glucose area (so Q6 applies) and a wearable
 * (so the first-result task is a connection the screen can wait for).
 */
export async function answerEverything(page: Page): Promise<void> {
  await answer(page, { step: "who", recordTarget: "me" });
  await answer(page, { step: "areas", areas: ["glucose", "weight-body"] });
  await answer(page, { step: "medication", medication: "yes" });
  await answer(page, { step: "sources", sources: ["oura"] });
  await answer(page, { step: "visit", visit: "within-a-month" });
}
