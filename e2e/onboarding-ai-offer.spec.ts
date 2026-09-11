/**
 * v1.38.19 — the AI offer at the end of the setup flow.
 *
 * The screen used to promise that insights "work for you right now" the
 * moment the operator had configured a key. It never knew whether the key
 * answered, and it never mentioned the consent receipt the egress actually
 * needs — so the person who believed it met a `consent.ai.required` refusal
 * on their first briefing. On 2026-09-11 the operator's own instance was
 * answering HTTP 500 from its OAuth proxy while the screen kept promising.
 *
 * Two runs, one account, and the only difference between them is a row in
 * `provider_health`:
 *
 *   a success inside the freshness window  → the offer, and one tap grants
 *   a dead credential inside its cooldown  → "not answering", and no button
 *
 * What is deliberately absent: any call to a provider. The flow's rule holds
 * — nothing in it talks to one — and a probe here would bill the operator for
 * every registration on the instance.
 *
 * Serial, and it restores the instance state it seeded: the tri-state folds
 * across accounts by design, so its inputs are instance-wide.
 */
import {
  E2E_SETUP_AI_OFFER,
  SETUP_AI_OFFER_STORAGE_STATE_PATH,
} from "./setup/global-setup";
import {
  clearAiConsent,
  clearOperatorProvider,
  seedOperatorProvider,
  seedSharedProviderResult,
} from "./setup/ai-offer-fixture";
import { resetSetupFlow } from "./setup/setup-flow-fixture";
import { expect, test } from "./setup/test";
import {
  answer,
  answerEverything,
  complete,
  expectScreen,
} from "./setup-flow-helpers";

const OFFER = '[data-slot="onboarding-ai-offer"]';
const GRANT = '[data-slot="onboarding-ai-offer-grant"]';
const UNAVAILABLE = '[data-slot="onboarding-ai-unavailable"]';
const SHARED_KEY = '[data-slot="onboarding-ai-shared-key"]';

/** Walk the account to the done screen through the API, then open it. */
async function openDoneScreen(page: import("@playwright/test").Page) {
  await page.goto("/onboarding");
  await answerEverything(page);
  // Q6 applies because the answers name glucose and weight; the flow does not
  // complete while a screen it owes is unanswered.
  await answer(page, {
    step: "units",
    units: { glucoseUnit: "mmol/L", unitPreference: "metric" },
  });
  await complete(page);
  await answer(page, { step: "first-result", status: "skipped" });
  await page.goto("/onboarding/done");
  await expectScreen(page, "done");
  // The panel itself is unconditional; the variant inside it is not.
  await expect(page.locator('[data-slot="onboarding-ai-panel"]')).toBeVisible();
}

// One account, one instance-wide ledger. Two workers driving this at once
// would each read the other's seed.
test.describe.configure({ mode: "serial" });

test.describe("the setup flow's AI offer follows the shared provider's health", () => {
  test.use({ storageState: SETUP_AI_OFFER_STORAGE_STATE_PATH });

  test.beforeEach(async () => {
    await resetSetupFlow(E2E_SETUP_AI_OFFER.username);
    await clearAiConsent(E2E_SETUP_AI_OFFER.username);
    await seedOperatorProvider();
  });

  test.afterAll(async () => {
    await clearOperatorProvider();
    await clearAiConsent(E2E_SETUP_AI_OFFER.username);
  });

  test("offers one tap when the shared provider worked recently, and the tap leaves a receipt", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await seedSharedProviderResult(E2E_SETUP_AI_OFFER.username, {
      result: "ok",
      okMinutesAgo: 30,
    });

    // No receipt before the tap — otherwise the assertion after it proves
    // nothing about the button.
    const before = await page.request.get(
      "/api/consent/ai/latest?kind=ai_full",
    );
    expect(before.status()).toBe(200);
    expect(
      ((await before.json()) as { data: { receipt: unknown } }).data.receipt,
    ).toBeNull();

    await openDoneScreen(page);

    await expect(page.locator(OFFER)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(UNAVAILABLE)).toHaveCount(0);

    // No provider was called to decide this. The flow reads a projection.
    const probes: string[] = [];
    page.on("request", (req) => {
      const path = new URL(req.url()).pathname;
      if (path === "/api/ai/test" || path.startsWith("/api/insights/"))
        probes.push(path);
    });

    await page.locator(GRANT).click();

    // The line the person reads swaps to the granted one.
    await expect(page.locator(SHARED_KEY)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(GRANT)).toHaveCount(0);
    expect(probes, "the offer must not trigger a provider call").toEqual([]);

    const after = await page.request.get("/api/consent/ai/latest?kind=ai_full");
    const receipt = (
      (await after.json()) as {
        data: { receipt: { kind: string; revokedAt: string | null } | null };
      }
    ).data.receipt;
    expect(receipt).not.toBeNull();
    expect(receipt!.kind).toBe("ai_full");
    expect(receipt!.revokedAt).toBeNull();
  });

  test("says the provider is not answering while its credential is benched, and offers no button", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await seedSharedProviderResult(E2E_SETUP_AI_OFFER.username, {
      result: "auth_failed",
    });

    await openDoneScreen(page);

    await expect(page.locator(UNAVAILABLE)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(GRANT)).toHaveCount(0);
    await expect(page.locator(OFFER)).toHaveCount(0);
    // The unproven promise is not shown to somebody who has not consented.
    await expect(page.locator(SHARED_KEY)).toHaveCount(0);

    // The rest of the panel is untouched: the flow stays complete without it.
    await expect(
      page.locator('[data-slot="onboarding-ai-keyless"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="onboarding-open-dashboard"]'),
    ).toBeVisible();

    // The grant route itself stays open — it is the user's own consent act
    // and is reachable from Settings at any time. What this case pins is the
    // decision the screen was handed, so read it back from the source.
    const status = await page.request.get("/api/user/ai-provider");
    const data = (
      (await status.json()) as {
        data: { serverProviderHealth: string; serverProviderOffer: boolean };
      }
    ).data;
    expect(data.serverProviderHealth).toBe("unhealthy");
    expect(data.serverProviderOffer).toBe(false);
  });
});
