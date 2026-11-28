/**
 * 1.50 — the first run of a fresh server, in a browser: the setup code, the
 * owner account, the five server steps, then the owner's own setup and the
 * dashboard. Runs against a second, empty server (`E2E_FRESH_BASE_URL`, its
 * database `E2E_FRESH_DATABASE_URL`, its code `E2E_FRESH_SETUP_TOKEN`) and is
 * skipped where none is configured: claiming a server is a one-time act the
 * shared e2e instance cannot repeat.
 *
 * Also pinned: the claim switches open sign-up off, Later on the second
 * factor keeps the deadline strip away, and Not now on the relay keeps the
 * question off the dashboard. axe runs on the anonymous screens in both
 * themes. Stable `data-*` attributes only.
 */
import AxeBuilder from "@axe-core/playwright";
import pg from "pg";
import type { Page } from "@playwright/test";

import { expect, test } from "./setup/test";
import {
  acknowledge,
  choose,
  expectScreen,
  next,
  readSetup,
  SHELL,
} from "./setup-flow-helpers";

const BASE = process.env.E2E_FRESH_BASE_URL;
const DB = process.env.E2E_FRESH_DATABASE_URL;
const TOKEN = process.env.E2E_FRESH_SETUP_TOKEN;

test.skip(!BASE || !DB || !TOKEN, "no fresh server configured");
test.describe.configure({ mode: "serial" });
test.use({
  baseURL: BASE,
  storageState: { cookies: [], origins: [] },
});

async function emptyServer(): Promise<void> {
  const pool = new pg.Pool({ connectionString: DB });
  try {
    await pool.query("TRUNCATE users CASCADE");
    await pool.query("DELETE FROM app_settings");
    await pool.query("DELETE FROM rate_limits");
  } finally {
    await pool.end();
  }
}

async function axeClean(page: Page, label: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const blocking = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(blocking, `${label} (${scheme})`).toEqual([]);
  }
}

test.beforeAll(emptyServer);

test("a fresh server, from the setup code to the owner's dashboard", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });

  // Signing in is not where a fresh server starts.
  await page.goto("/auth/login");
  await expect(page).toHaveURL(/\/auth\/register$/, { timeout: 15_000 });
  await expect(page.locator('[data-slot="first-account-setup"]')).toBeVisible();
  await axeClean(page, "setup code");
  await page.locator("#setup-token").fill(TOKEN ?? "");
  await page.locator('[data-slot="onboarding-next"]').click();

  // One primary: create the owner account.
  await expect(page.locator('[data-slot="owner-setup-claimed"]')).toBeVisible();
  await page.locator('[data-slot="owner-setup-create"]').click();
  await expect(page.locator('[data-slot="owner-setup-account"]')).toBeVisible();
  await axeClean(page, "owner account");
  await page.locator("#email").fill("owner@healthlog.test");
  await page.locator("#username").fill("owner");
  await page.locator("#password").fill("correct horse battery staple 42");
  await page.locator('[data-slot="onboarding-next"]').click();

  await expectScreen(page, "account-mfa");
  // Nobody else may register from here on.
  const status = await page.evaluate(async () => {
    const res = await fetch("/api/auth/registration-status");
    return (await res.json()).data as { registrationEnabled: boolean };
  });
  expect(status.registrationEnabled).toBe(false);
  await page.locator('[data-slot="onboarding-skip"]').click();

  await expectScreen(page, "signups");
  await expect(
    page.locator('[data-slot="onboarding-choice"][data-value="invited"]'),
  ).toHaveAttribute("data-checked", "true");
  await next(page);

  await page.waitForURL(/\/onboarding\/server\/(relay|ai)$/);
  if (page.url().endsWith("/relay")) {
    await page.locator('[data-slot="onboarding-skip"]').click();
  }
  await expectScreen(page, "ai");
  await page.locator('[data-slot="onboarding-skip"]').click();
  await expectScreen(page, "recovery");
  await page.locator('[data-slot="onboarding-skip"]').click();

  // The owner's own setup follows.
  await expectScreen(page, "who");
  await choose(page, "who", ["me"]);
  await acknowledge(page);
  await next(page);
  await expectScreen(page, "areas");
  await choose(page, "areas", ["blood-pressure"]);
  await next(page);
  await expectScreen(page, "units");
  await next(page);
  await expectScreen(page, "sources");
  await page.locator('[data-slot="onboarding-skip"]').click();
  await expectScreen(page, "reminders");
  await page.locator('[data-slot="onboarding-skip"]').click();
  await page.waitForURL(/\/onboarding\/ai$|\/$/, { timeout: 15_000 });
  if (page.url().endsWith("/onboarding/ai")) {
    await page.locator('[data-slot="onboarding-ai-no"]').click();
  }

  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  await expect(page.locator(SHELL)).toHaveCount(0);
  // One setup surface: the card. No deadline strip after Later, no relay
  // question after Not now.
  await expect(page.locator('[data-slot="setup-card"]')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator('[data-slot="mfa-enrollment-banner"]')).toHaveCount(
    0,
  );
  await expect(
    page.locator('[data-slot="today-ask"][data-kind="push_relay"]'),
  ).toHaveCount(0);

  const setup = await readSetup(page);
  expect(setup.instance?.status).toBe("done");
  expect(setup.person.status).toBe("done");
  expect(
    setup.person.tasks.find((task) => task.id === "second-factor")?.deadline,
  ).toBeTruthy();
});
