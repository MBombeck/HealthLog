/**
 * v1.39 (C2) — axe over every setup screen, at both viewports, plus one
 * keyboard-only pass through a question.
 *
 * The pattern is `a11y.spec.ts`: a scan waits for something the SCREEN
 * renders once its state is there — the question's chips, the confirm
 * screen's module card, the first-result task — never for the heading the
 * scan then checks. The state is driven through the answers route on the
 * page's own session, screen by screen, so every URL is one the step machine
 * lets through. Both widths run inside the desktop project, because the
 * account is mutated and a second project would drive it from a second
 * browser.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";

import {
  E2E_SETUP_A11Y,
  SETUP_A11Y_STORAGE_STATE_PATH,
} from "./setup/global-setup";
import { resetSetupFlow } from "./setup/setup-flow-fixture";
import { expect, test } from "./setup/test";
import {
  answer,
  answerEverything,
  complete,
  expectScreen,
  type SetupScreen,
} from "./setup-flow-helpers";

type AxeViolation = Awaited<
  ReturnType<AxeBuilder["analyze"]>
>["violations"][number];

const WCAG_TAGS: Record<string, true> = {
  wcag2a: true,
  wcag2aa: true,
  wcag21a: true,
  wcag21aa: true,
};
const SEMANTIC_RULES: Record<string, true> = {
  "heading-order": true,
  "page-has-heading-one": true,
  "landmark-one-main": true,
  "landmark-unique": true,
  region: true,
};

const VIEWPORTS = [
  { label: "desktop 1280", width: 1280, height: 720 },
  { label: "phone 390", width: 390, height: 844 },
];

/** Where to go, and what has to be on screen before axe may look. */
interface ScreenCase {
  screen: SetupScreen;
  path: string;
  painted: (page: Page) => Locator;
  /** The state the screen needs, written through the API before the visit. */
  prepare?: (page: Page) => Promise<void>;
}

const SCREENS: ScreenCase[] = [
  {
    screen: "welcome",
    path: "/onboarding",
    painted: (page) => page.locator('[data-slot="onboarding-set-up"]'),
  },
  {
    screen: "who",
    path: "/onboarding/who",
    painted: (page) => page.locator('[data-slot="onboarding-question-who"]'),
  },
  {
    screen: "areas",
    path: "/onboarding/areas",
    painted: (page) => page.locator('[data-slot="onboarding-question-areas"]'),
    prepare: (page) => answer(page, { step: "who", recordTarget: "me" }),
  },
  {
    screen: "medication",
    path: "/onboarding/medication",
    painted: (page) =>
      page.locator('[data-slot="onboarding-question-medication"]'),
    prepare: (page) =>
      answer(page, { step: "areas", areas: ["glucose", "weight-body"] }),
  },
  {
    screen: "sources",
    path: "/onboarding/sources",
    painted: (page) =>
      page.locator('[data-slot="onboarding-question-sources"]'),
    prepare: (page) => answer(page, { step: "medication", medication: "yes" }),
  },
  {
    screen: "visit",
    path: "/onboarding/visit",
    painted: (page) => page.locator('[data-slot="onboarding-question-visit"]'),
    prepare: (page) => answer(page, { step: "sources", sources: ["oura"] }),
  },
  {
    screen: "units",
    path: "/onboarding/units",
    painted: (page) =>
      page.locator('[data-slot="onboarding-question-glucose-unit"]'),
    prepare: (page) => answer(page, { step: "visit", visit: "within-a-month" }),
  },
  {
    screen: "confirm",
    path: "/onboarding/confirm",
    painted: (page) => page.locator('[data-slot="onboarding-confirm-modules"]'),
    prepare: (page) =>
      answer(page, {
        step: "units",
        units: { glucoseUnit: "mmol/L", unitPreference: "metric" },
      }),
  },
  {
    screen: "first-result",
    path: "/onboarding/first-result",
    painted: (page) => page.locator('[data-slot="onboarding-task-connect"]'),
    prepare: (page) => complete(page),
  },
  {
    screen: "done",
    path: "/onboarding/done",
    painted: (page) => page.locator('[data-slot="onboarding-open-dashboard"]'),
    prepare: (page) =>
      answer(page, { step: "first-result", status: "skipped" }),
  },
];

function reportBlocking(label: string, blocking: AxeViolation[]) {
  if (blocking.length === 0) return;
  console.log(
    `axe violations for ${label}:\n${blocking
      .map(
        (violation) =>
          `  - [${violation.impact}] ${violation.id}: ${violation.help}\n` +
          violation.nodes
            .map((node) => `    ${node.target.join(" ")}: ${node.html}`)
            .join("\n"),
      )
      .join("\n")}`,
  );
}

async function runAxe(page: Page): Promise<AxeViolation[]> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  return results.violations.filter((violation) => {
    if (SEMANTIC_RULES[violation.id]) {
      return (
        violation.impact === "moderate" ||
        violation.impact === "serious" ||
        violation.impact === "critical"
      );
    }
    const isWcagRule = violation.tags.some((tag) => WCAG_TAGS[tag]);
    return (
      isWcagRule &&
      (violation.impact === "serious" || violation.impact === "critical")
    );
  });
}

// Serial: every test here drives the ONE account through the API, and two
// workers doing that at once would each find the other's answers.
test.describe.configure({ mode: "serial" });

test.describe("setup flow — axe on every screen", () => {
  test.use({ storageState: SETUP_A11Y_STORAGE_STATE_PATH });

  for (const vp of VIEWPORTS) {
    test(`every screen is clean at ${vp.label}`, async ({ page }) => {
      test.setTimeout(180_000);
      await resetSetupFlow(E2E_SETUP_A11Y.username);
      await page.setViewportSize({ width: vp.width, height: vp.height });

      for (const item of SCREENS) {
        await item.prepare?.(page);
        await page.goto(item.path, { waitUntil: "domcontentloaded" });
        await expectScreen(page, item.screen);
        await expect(item.painted(page)).toBeVisible({ timeout: 15_000 });
        // Focus lands on the heading on every screen.
        await expect(page.locator("h1")).toBeFocused();
        const blocking = await runAxe(page);
        reportBlocking(`${item.screen} @${vp.label}`, blocking);
        expect(blocking, `${item.screen} @${vp.label}`).toEqual([]);
      }
    });
  }

  test("a question can be answered with the keyboard alone", async ({
    page,
  }) => {
    await resetSetupFlow(E2E_SETUP_A11Y.username);
    await answerEverything(page);
    await page.goto("/onboarding/who", { waitUntil: "domcontentloaded" });
    await expectScreen(page, "who");
    // Focus is on the heading; Tab reaches the first chip's radio, Space
    // picks it, and the keyboard walks to "Next".
    await page.keyboard.press("Tab");
    const chosen = page.locator(
      '[data-slot="onboarding-question-who"] input[type="radio"]:focus',
    );
    await expect(chosen).toHaveCount(1);
    await page.keyboard.press("ArrowDown");
    await expect(
      page.locator('[data-slot="onboarding-choice"][data-checked="true"]'),
    ).toHaveAttribute("data-value", "someone-else");
    // Tab past the chip group to the action row, then activate "Next".
    for (let i = 0; i < 4; i += 1) {
      if (await page.locator('[data-slot="onboarding-next"]:focus').count()) {
        break;
      }
      await page.keyboard.press("Tab");
    }
    await expect(page.locator('[data-slot="onboarding-next"]')).toBeFocused();
    await page.keyboard.press("Enter");
    await expectScreen(page, "areas");
  });
});
