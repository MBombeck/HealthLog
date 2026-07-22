/**
 * Document vault — the P2 AI-assist + content-search acceptance suite.
 *
 * Pins the review-first contract (a suggestion prefills an editable field and
 * is only ever written on an explicit save — never auto-committed), the
 * session-only summary panel (transient, carrying the "not saved · not a
 * diagnosis" note), whole-word content search reaching a body-only word through
 * the real blind-token GIN union, the corpus "index all" backfill CTA, the calm
 * provider-unavailable pointer (no provider → no assist button, a settings
 * link instead), and the text-mode image-only refusal that fires client-side
 * before any OCR/upload work.
 *
 * The seeded demo user has NO AI provider, so the unavailable state is the
 * default; the enabled states are driven by `page.route` mocks of `usage` +
 * the OCR capability probe + the AI endpoints. Content search uses NO mock — it
 * seeds a real `document_content_index` row (`ensureVaultAiFixture`) and drives
 * the real list union.
 */
import { expect, test, type Page } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import {
  ensureVaultFixture,
  ensureVaultAiFixture,
  AI_PROBE_DOC_ID,
  CONTENT_DOC_ID,
  CONTENT_BODY_WORD,
} from "./setup/vault-fixture";

/** The vault usage DTO the UI reads before offering upload + AI affordances. */
function usageBody(overrides: {
  assistAvailable: boolean;
  contentIndex: { enabled: boolean; indexedCount: number; totalCount: number };
}) {
  return {
    data: {
      usedBytes: 4096,
      quotaBytes: 1_073_741_824,
      maxFileBytes: 26_214_400,
      acceptedExtensions: [".pdf", ".png", ".jpg", ".jpeg", ".webp"],
      linkedEpisodes: [],
      assistAvailable: overrides.assistAvailable,
      contentIndex: overrides.contentIndex,
    },
    error: null,
  };
}

/** Fulfil the envelope shape the client unwraps (`(await res.json()).data`). */
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
 * Mock the AI-availability surface: `usage` (assist + content-index flags) and
 * the OCR capability probe (transport mode). Endpoints (suggest/summary/reindex)
 * are mocked per-test on top of this.
 */
async function mockAiEnabled(
  page: Page,
  opts: {
    mode: "vision" | "text";
    pdfSupported?: boolean;
    contentIndex?: {
      enabled: boolean;
      indexedCount: number;
      totalCount: number;
    };
  },
): Promise<void> {
  const contentIndex = opts.contentIndex ?? {
    enabled: true,
    indexedCount: 0,
    totalCount: 1,
  };
  await page.route("**/api/documents/inbound/usage", (route) =>
    fulfilJson(route, usageBody({ assistAvailable: true, contentIndex })),
  );
  await page.route("**/api/labs/ocr/capability", (route) =>
    fulfilJson(route, {
      data: {
        available: true,
        mode: opts.mode,
        reason: null,
        pdfSupported: opts.pdfSupported ?? opts.mode === "vision",
      },
      error: null,
    }),
  );
  // v1.27.31 — the document AI section now probes the document-scoped
  // capability endpoint (provider order + vendor-blind egress class), not the
  // labs OCR probe. Mirror the same availability so the AI actions render;
  // egress-notice-specific tests override this route afterwards.
  await page.route("**/api/documents/inbound/capability", (route) =>
    fulfilJson(route, {
      data: {
        available: true,
        mode: opts.mode,
        reason: null,
        pdfSupported: opts.pdfSupported ?? opts.mode === "vision",
        egress: "external",
      },
      error: null,
    }),
  );
  // The detail sheet reads the auto-AI-read opt-in to decide whether to show
  // the manual per-document action row. Default it OFF here so the manual
  // Read / Suggest / Summarise actions render for these assertions; an unmocked
  // fetch would leave the sheet reading a live value.
  await page.route("**/api/auth/me/documents-auto-ai-read", (route) =>
    fulfilJson(route, { data: { documentsAutoAiRead: false }, error: null }),
  );
}

test.describe("document vault — AI assist + content search", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeAll(async () => {
    await ensureVaultFixture();
    await ensureVaultAiFixture();
  });

  // These AI flows drive several mocked provider round-trips per test; on a
  // loaded CI runner they race the default 30s, so the whole group earns the
  // tripled timeout rather than flaking green paths.
  test.beforeEach(() => {
    test.slow();
  });

  // ── (a) Review-first assist: prefill → edit → save, nothing auto-committed ──

  test("assist prefills an editable draft that only saves on commit", async ({
    page,
  }) => {
    await mockAiEnabled(page, { mode: "vision" });

    const suggestedTitle = `Suggested lab report ${Date.now()}`;
    await page.route(
      `**/api/documents/inbound/${AI_PROBE_DOC_ID}/suggest`,
      (route) =>
        fulfilJson(route, {
          data: {
            suggestions: {
              title: suggestedTitle,
              kind: "LAB_RESULT",
              documentDate: "2025-03-03",
            },
          },
          error: null,
        }),
    );

    // Count PATCH writes to this document — a review-first draft must not fire
    // one until the user commits.
    let patchCount = 0;
    page.on("request", (req) => {
      if (
        req.method() === "PATCH" &&
        req.url().includes(`/api/documents/inbound/${AI_PROBE_DOC_ID}`)
      ) {
        patchCount += 1;
      }
    });

    await page.goto(`/documents?doc=${AI_PROBE_DOC_ID}`);
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    const suggest = sheet.locator('[data-slot="assist-suggest"]');
    await expect(suggest).toBeEnabled();
    await suggest.click();

    const review = sheet.locator('[data-slot="assist-suggestion-review"]');
    await expect(review).toBeVisible();

    // Applying the title seeds the EDITABLE field only — no write yet.
    await review.getByRole("button", { name: "Use title" }).click();
    const titleInput = sheet.locator("#document-title-input");
    await expect(titleInput).toHaveValue(suggestedTitle);
    expect(patchCount).toBe(0);

    // Commit (blur/Enter) → the write fires exactly once, carrying the title.
    const saved = page.waitForRequest(
      (req) =>
        req.method() === "PATCH" &&
        req.url().includes(`/api/documents/inbound/${AI_PROBE_DOC_ID}`),
    );
    await titleInput.press("Enter");
    const savedReq = await saved;
    expect(JSON.parse(savedReq.postData() ?? "{}").title).toBe(suggestedTitle);
    expect(patchCount).toBe(1);
  });

  // ── (b) Session-only summary: transient, note present, closing discards ──

  test("summary panel is transient and discards on close", async ({ page }) => {
    await mockAiEnabled(page, { mode: "vision" });
    const summaryText = "A chest imaging report issued by a radiology clinic.";
    let summaryCalls = 0;
    await page.route(
      `**/api/documents/inbound/${AI_PROBE_DOC_ID}/summary**`,
      (route) => {
        summaryCalls += 1;
        return fulfilJson(route, {
          data: { summary: summaryText },
          error: null,
        });
      },
    );

    await page.goto(`/documents?doc=${AI_PROBE_DOC_ID}`);
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    await sheet.getByRole("button", { name: "Summarise" }).click();
    const panel = sheet.locator('[data-slot="document-summary-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel.getByText(summaryText)).toBeVisible();
    expect(summaryCalls).toBe(1);

    // Closing discards — the panel is gone and nothing lingers.
    await panel.getByRole("button", { name: "Hide" }).click();
    await expect(panel).not.toBeVisible();
  });

  // ── (c) Content search reaches a BODY-ONLY word through the token union ──

  test("content search finds a word that lives only in the document body", async ({
    page,
  }) => {
    await page.goto("/documents");
    await expect(
      page.getByRole("heading", { name: "Documents" }),
    ).toBeVisible();

    // The word is absent from every title/filename — the only route is the
    // real blind-token union over the seeded content index.
    await page
      .getByRole("searchbox", { name: "Search documents" })
      .fill(CONTENT_BODY_WORD);

    const card = page.getByRole("button", { name: "Open Radiology note" });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(new RegExp(`q=${CONTENT_BODY_WORD}`));

    // Sanity: the word really is absent from the short fields (server-side
    // confirmation the union — not an ILIKE — did the work).
    const viaApi = await page.request.get(
      `/api/documents/inbound?q=${CONTENT_BODY_WORD}&limit=10`,
    );
    const body = await viaApi.json();
    const hit = body.data.documents.find(
      (d: { id: string }) => d.id === CONTENT_DOC_ID,
    );
    expect(hit).toBeTruthy();
    expect(`${hit.title} ${hit.filename}`.toLowerCase()).not.toContain(
      CONTENT_BODY_WORD,
    );
  });

  // ── (d) Corpus "index all" backfill CTA ──────────────────────────────────

  test("the index-all CTA enqueues the corpus backfill", async ({ page }) => {
    await mockAiEnabled(page, {
      mode: "vision",
      contentIndex: { enabled: true, indexedCount: 1, totalCount: 10 },
    });
    let reindexCalls = 0;
    await page.route("**/api/documents/inbound/reindex", (route) => {
      reindexCalls += 1;
      return fulfilJson(route, { data: { enqueued: 5 }, error: null });
    });

    await page.goto("/documents");
    const hint = page.locator('[data-slot="content-search-hint"]');
    await expect(hint).toBeVisible();
    const indexAll = page.locator('[data-slot="content-index-all"]');
    await expect(indexAll).toBeVisible();
    const reindexRequest = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/documents/inbound/reindex",
    );
    await Promise.all([
      reindexRequest,
      expect(
        page.getByText("Indexing 5 document(s) in the background."),
      ).toBeVisible(),
      indexAll.click(),
    ]);
    expect(reindexCalls).toBe(1);
  });

  // ── (e) No-provider degradation: calm pointer, no assist button ──────────

  test("with no provider the detail sheet shows a calm settings pointer", async ({
    page,
  }) => {
    // No mocks — the seeded demo user has no AI provider configured.
    await page.goto(`/documents?doc=${AI_PROBE_DOC_ID}`);
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    await expect(
      sheet.locator('[data-slot="assist-unavailable"]'),
    ).toBeVisible();
    await expect(
      sheet.getByRole("link", { name: "Open AI settings" }),
    ).toBeVisible();
    // The action button is absent — the endpoint would 422, so the UI never
    // offers it.
    await expect(sheet.locator('[data-slot="assist-suggest"]')).toHaveCount(0);
  });

  // ── (g) "Read with AI": the prominent action maps to the index endpoint ──

  test('the "Read with AI" action reads a document and confirms', async ({
    page,
  }) => {
    await mockAiEnabled(page, { mode: "vision" });
    // AI_PROBE_DOC_ID carries no content index → the action reads "Read with AI"
    // (not "Read again") and the status pill is the calm "not searchable yet".
    let indexCalls = 0;
    let indexHadJsonBody = false;
    await page.route(
      `**/api/documents/inbound/${AI_PROBE_DOC_ID}/index`,
      (route) => {
        indexCalls += 1;
        // VISION mode posts NO JSON body — the endpoint 422s a text body without
        // the local-OCR opt-in, so the UI must never send one on this path.
        indexHadJsonBody = Boolean(route.request().postData());
        return fulfilJson(route, {
          data: { documentId: AI_PROBE_DOC_ID, indexed: true, tokenCount: 12 },
          error: null,
        });
      },
    );

    await page.goto(`/documents?doc=${AI_PROBE_DOC_ID}`);
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    // The prominent action is present and labelled for a first read.
    const read = sheet.locator('[data-slot="document-read-ai"]');
    await expect(read).toBeVisible();
    await expect(read).toHaveText(/Read with AI/);

    await read.click();
    await expect(page.getByText("The AI read your document.")).toBeVisible();
    expect(indexCalls).toBe(1);
    expect(indexHadJsonBody).toBe(false);
  });

  // ── (h) The detail view does not label how the text was extracted ────────

  test("a vision-indexed document carries no extraction-provenance line", async ({
    page,
  }) => {
    // CONTENT_DOC_ID is seeded with source "vision". The detail view used to
    // print a "Read by AI" meta line under the summary; it told the reader
    // nothing they could act on — how the text came out of the page is our
    // plumbing, not their business — so it is gone. This test keeps it gone:
    // the sheet still opens on the deep link, and the line stays absent.
    await page.goto(`/documents?doc=${CONTENT_DOC_ID}`);
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    await expect(
      sheet.locator('[data-slot="document-detail-ai-read"]'),
    ).toHaveCount(0);
    await expect(sheet.getByText("Read by AI")).toHaveCount(0);
  });

  // ── (f) Text-mode refuses a non-image before any OCR/upload ──────────────

  test("text-mode assist refuses a PDF client-side before any request", async ({
    page,
  }) => {
    await mockAiEnabled(page, { mode: "text", pdfSupported: false });
    let suggestCalls = 0;
    await page.route(
      `**/api/documents/inbound/${AI_PROBE_DOC_ID}/suggest`,
      (route) => {
        suggestCalls += 1;
        return fulfilJson(route, {
          data: {
            suggestions: { title: null, kind: null, documentDate: null },
          },
          error: null,
        });
      },
    );

    await page.goto(`/documents?doc=${AI_PROBE_DOC_ID}`);
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    const suggest = sheet.locator('[data-slot="assist-suggest"]');
    await expect(suggest).toBeEnabled();
    await suggest.click();

    // The PDF is refused locally (tesseract reads images only) — the error
    // shows and the server suggest route is never called.
    await expect(
      sheet.getByText("Local OCR reads images only — not this file."),
    ).toBeVisible();
    await page.waitForTimeout(300);
    expect(suggestCalls).toBe(0);
  });
});
