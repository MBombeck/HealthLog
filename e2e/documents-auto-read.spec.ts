/**
 * Automatic AI document reading — the per-user opt-in acceptance suite.
 *
 * Two surfaces:
 *   (1) AI settings — the single switch reveals a once-shown honesty confirm
 *       BEFORE writing the setting (off → on), and the confirm is what commits
 *       `documentsAutoAiRead: true`. Turning it off is immediate.
 *   (2) The vault detail sheet — the per-egress "leaves your machine" notice is
 *       shown once and the per-document "Read with AI" action is the explicit
 *       path; reading through it succeeds with no per-document consent prompt.
 *
 * Everything is `page.route`-mocked so the suite mutates no shared demo state.
 * The document-scoped capability endpoint is mocked on every path — an unmocked
 * / changed capability endpoint is the shipped regression that breaks the vault
 * AI e2e, so it is pinned here too. Assertions target stable data-slots, never
 * viewport-dependent text.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./setup/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import { aiBlockAvailable, serveAiBlock } from "./setup/ai-capabilities";
import {
  ensureVaultFixture,
  ensureVaultAiFixture,
  AI_PROBE_DOC_ID,
  CONTENT_DOC_ID,
  openDocumentMenu,
} from "./setup/vault-fixture";

async function fulfilJson(
  route: Parameters<Parameters<Page["route"]>[1]>[0],
  body: unknown,
) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/**
 * Mock the FULL AI-availability surface the vault section probes so the read
 * action renders AND is enabled: `usage` (assist + content-index flags — this is
 * what un-disables the action), the labs OCR capability, and the document-scoped
 * capability (provider order + vendor-blind egress class). Mirrors
 * `mockAiEnabled` in documents-ai.spec.ts; egress-specific tests set the class.
 */
async function mockDocumentCapability(
  page: Page,
  opts: {
    egress: "local" | "external";
    pdfSupported?: boolean;
    /** The per-user auto-AI-read opt-in. OFF keeps the manual action row. */
    autoRead?: boolean;
  },
): Promise<void> {
  const pdfSupported = opts.pdfSupported ?? true;
  const autoRead = opts.autoRead ?? false;
  await page.route("**/api/auth/me/documents-auto-ai-read", (route) =>
    fulfilJson(route, {
      data: { documentsAutoAiRead: autoRead },
      error: null,
    }),
  );
  await page.route("**/api/documents/inbound/usage", (route) =>
    fulfilJson(route, {
      data: {
        usedBytes: 4096,
        quotaBytes: 1_073_741_824,
        maxFileBytes: 26_214_400,
        acceptedExtensions: [".pdf", ".png", ".jpg", ".jpeg", ".webp"],
        linkedEpisodes: [],
        assistAvailable: true,
        contentIndex: { enabled: true, indexedCount: 0, totalCount: 1 },
      },
      error: null,
    }),
  );
  await page.route("**/api/labs/ocr/capability", (route) =>
    fulfilJson(route, {
      data: { available: true, mode: "vision", reason: null, pdfSupported },
      error: null,
    }),
  );
  await page.route("**/api/documents/inbound/capability", (route) =>
    fulfilJson(route, {
      data: {
        available: true,
        mode: "vision",
        reason: null,
        pdfSupported,
        egress: opts.egress,
      },
      error: null,
    }),
  );
}

test.describe("automatic AI reading — settings toggle", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(({}, testInfo) => {
    // The confirm logic is viewport-independent; run the settings flow once on
    // desktop to keep the heavy AI-settings page off the mobile matrix.
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "settings toggle flow runs on desktop only",
    );
    test.slow();
  });

  test("turning it on reveals a once-shown honesty confirm before writing", async ({
    page,
  }) => {
    // The toggle starts OFF; capture the write so we can prove it only fires on
    // confirm (never on the raw switch flip).
    let patchBody: unknown = null;
    await page.route("**/api/auth/me/documents-auto-ai-read", (route) => {
      if (route.request().method() === "PATCH") {
        patchBody = JSON.parse(route.request().postData() ?? "{}");
        return fulfilJson(route, {
          data: { documentsAutoAiRead: true },
          error: null,
        });
      }
      return fulfilJson(route, {
        data: { documentsAutoAiRead: false },
        error: null,
      });
    });

    await page.goto("/settings/ai");
    const card = page.locator('[data-slot="documents-auto-read-card"]');
    await expect(card).toBeVisible();

    // Flip the switch ON — the honesty confirm appears and NOTHING is written.
    await card.getByTestId("documents-auto-read-enable").click();
    const confirm = card.locator('[data-slot="documents-auto-read-confirm"]');
    await expect(confirm).toBeVisible();
    expect(patchBody).toBeNull();

    // Acknowledge — now (and only now) the write fires with the true flag.
    await confirm
      .locator('[data-slot="documents-auto-read-confirm-cta"]')
      .click();
    await expect.poll(() => patchBody).toEqual({ documentsAutoAiRead: true });
    await expect(confirm).not.toBeVisible();
  });

  test("cancelling the confirm writes nothing", async ({ page }) => {
    let patchCalls = 0;
    await page.route("**/api/auth/me/documents-auto-ai-read", (route) => {
      if (route.request().method() === "PATCH") {
        patchCalls += 1;
        return fulfilJson(route, {
          data: { documentsAutoAiRead: true },
          error: null,
        });
      }
      return fulfilJson(route, {
        data: { documentsAutoAiRead: false },
        error: null,
      });
    });

    await page.goto("/settings/ai");
    const card = page.locator('[data-slot="documents-auto-read-card"]');
    await expect(card).toBeVisible();
    await card.getByTestId("documents-auto-read-enable").click();
    const confirm = card.locator('[data-slot="documents-auto-read-confirm"]');
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: /cancel/i }).click();
    await expect(confirm).not.toBeVisible();
    await page.waitForTimeout(300);
    expect(patchCalls).toBe(0);
  });
});

test.describe("automatic AI reading — vault per-document contract", () => {
  // AI surfaces render from the `ai` block of `/api/auth/me`, and the suite
  // has no reachable provider; every capability reads available here so the
  // mocked AI routes below are what the surfaces talk to.
  test.beforeEach(async ({ page }) => {
    await serveAiBlock(page, aiBlockAvailable());
  });

  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeAll(async () => {
    await ensureVaultFixture();
    await ensureVaultAiFixture();
  });

  test.beforeEach(() => test.slow());

  test("the vault shows the explicit read action for an external provider", async ({
    page,
  }) => {
    // External egress (the codex/OAuth or any non-local provider case). The
    // per-document egress notice was retired — the settings-toggle honesty
    // confirm already covers the egress trade — so no per-document notice
    // renders here regardless of egress mode.
    await mockDocumentCapability(page, { egress: "external" });

    await page.goto(`/documents?doc=${AI_PROBE_DOC_ID}`);
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    // With auto-read OFF the per-document read is the explicit path: the
    // sheet's menu offers it. (When auto-read is ON it steps back; that is
    // covered by its own test below.)
    const menu = await openDocumentMenu(page, sheet);
    await expect(menu.locator('[data-slot="document-read-ai"]')).toBeVisible();
  });

  test("reading through the action succeeds with no per-document consent prompt", async ({
    page,
  }) => {
    await mockDocumentCapability(page, { egress: "external" });
    let indexCalls = 0;
    await page.route(
      `**/api/documents/inbound/${AI_PROBE_DOC_ID}/index`,
      (route) => {
        indexCalls += 1;
        return fulfilJson(route, {
          data: { documentId: AI_PROBE_DOC_ID, indexed: true, tokenCount: 9 },
          error: null,
        });
      },
    );

    await page.goto(`/documents?doc=${AI_PROBE_DOC_ID}`);
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    const menu = await openDocumentMenu(page, sheet);
    const read = menu.locator('[data-slot="document-read-ai"]');
    await expect(read).toBeVisible();
    await read.click();

    await expect(page.getByText("The AI read your document.")).toBeVisible();
    expect(indexCalls).toBe(1);
  });

  test("a local-egress provider shows the explicit read action", async ({
    page,
  }) => {
    // A self-hosted local model never leaves the machine; the read action is
    // offered the same way as for an external provider (no per-document notice
    // in either mode after the notice was retired).
    await mockDocumentCapability(page, {
      egress: "local",
      pdfSupported: false,
    });

    await page.goto(`/documents?doc=${AI_PROBE_DOC_ID}`);
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    const menu = await openDocumentMenu(page, sheet);
    await expect(menu.locator('[data-slot="document-read-ai"]')).toBeVisible();
  });

  test("with auto-read ON the sheet drops the AI row only for a read document", async ({
    page,
  }) => {
    // Auto-read reads every upload with no per-document tap, so once a
    // document IS read the manual Read / Suggest actions are redundant and
    // the WHOLE block collapses (v1.28.22 — no status chrome; provenance
    // lives on the vault card). `CONTENT_DOC_ID` ships with a content index,
    // so it is the read-document case.
    await mockDocumentCapability(page, { egress: "external", autoRead: true });

    await page.goto(`/documents?doc=${CONTENT_DOC_ID}`);
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    // The footer's download action is the loaded-state anchor (it renders
    // only once the document GET resolved), so the absence checks below
    // cannot pass vacuously against the loading skeleton.
    await expect(
      sheet.locator('[data-slot="document-download"]'),
    ).toBeVisible();
    await expect(
      sheet.locator('[data-slot="document-ai-section"]'),
    ).toHaveCount(0);
    const menu = await openDocumentMenu(page, sheet);
    await expect(menu.locator('[data-slot="document-read-ai"]')).toHaveCount(0);
    await expect(menu.locator('[data-slot="assist-suggest"]')).toHaveCount(0);
  });

  test("with auto-read ON an unread document keeps its read action", async ({
    page,
  }) => {
    // v1.37.13 — auto-read reads new uploads, but a document that has no
    // content index yet (upload predates the switch, or its read failed)
    // still needs a way in: the AI section stays, with the manual read as
    // the per-document recovery path. Collapsing it here would strand the
    // document with no route to a read at all. The probe document is seeded
    // without a content index, so it is exactly that case.
    await mockDocumentCapability(page, { egress: "external", autoRead: true });

    await page.goto(`/documents?doc=${AI_PROBE_DOC_ID}`);
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    await expect(
      sheet.locator('[data-slot="document-download"]'),
    ).toBeVisible();
    await expect(
      sheet.locator('[data-slot="document-ai-section"]'),
    ).toHaveCount(1);
    const menu = await openDocumentMenu(page, sheet);
    await expect(menu.locator('[data-slot="document-read-ai"]')).toBeVisible();
  });
});
