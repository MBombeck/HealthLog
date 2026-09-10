/**
 * v1.39 (C2) — driving the setup flow in a browser, shared by its journeys.
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
  | "first-result"
  | "done";

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

/** The account payload, as the browser's session sees it. */
export async function readMe(page: Page): Promise<MePayload> {
  const res = await page.request.get("/api/auth/me");
  expect(res.status(), "reading the account payload").toBe(200);
  return ((await res.json()) as { data: MePayload }).data;
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
  const res = await page.request.get("/api/dashboard/widgets");
  expect(res.status(), "reading the dashboard layout").toBe(200);
  const { data } = (await res.json()) as {
    data: { widgets: Array<{ id: string; order: number }> };
  };
  return [...data.widgets].sort((a, b) => a.order - b.order).map((w) => w.id);
}

/** One answer through the answers route, on the browser's own session. */
export async function answer(page: Page, body: unknown): Promise<void> {
  const res = await page.request.patch("/api/onboarding/answers", {
    data: body,
  });
  expect(res.status(), `answering ${JSON.stringify(body)}`).toBe(200);
}

export async function complete(page: Page): Promise<void> {
  const res = await page.request.post("/api/onboarding/complete", { data: {} });
  expect(res.status(), "completing the flow").toBe(200);
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
