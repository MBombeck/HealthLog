/**
 * Document vault — the release acceptance suite.
 *
 * Pins the doctor-flow script (three independent routes to one document:
 * type chip, condition chip, text search), the URL deep-link contract
 * (`?kind` / `?episode` / `?year` / `?doc`), delete→undo, the bulk flows
 * (50-item kind change, partial failure, the >100 client-side chunking),
 * keyboard-only navigation, page-wide drop + clipboard paste intake, the
 * duplicate-upload contract, the admin per-file cap (commit-on-Enter +
 * rejection copy naming the limit), and axe scans over the timeline, the
 * open detail sheet, and bulk mode.
 *
 * Fixture: `e2e/setup/vault-fixture.ts` seeds the 60-document corpus (plus
 * the "Knie" episode and the linked MRT trio) straight through Postgres —
 * idempotent, so the desktop and mobile projects can both (re-)run it.
 * Mutating tests operate on their own seeded namespaces or on documents
 * they create, never on the shared doctor-flow corpus.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import {
  ensureVaultFixture,
  seedNamespaceDocs,
  KNIE_EPISODE_ID,
  MRT_DOC_ID,
} from "./setup/vault-fixture";

const DEFAULT_MAX_FILE_BYTES = 26_214_400;

/** Scroll the shell's scroll container until `locator` is visible (the
 *  timeline is virtualized — off-window rows are not in the DOM at all). */
async function scrollUntilVisible(
  page: Page,
  locator: ReturnType<Page["locator"]>,
  maxSteps = 40,
): Promise<void> {
  for (let i = 0; i < maxSteps; i++) {
    if (await locator.isVisible().catch(() => false)) return;
    await page
      .locator("#main-content")
      .evaluate((el) => el.scrollBy(0, el.clientHeight));
    await page.waitForTimeout(150);
  }
  await expect(locator).toBeVisible();
}

/** The invisible whole-card open button for a document titled `title`. */
function openButton(page: Page, title: string) {
  return page.getByRole("button", { name: `Open ${title}` }).first();
}

/** The card checkbox for a document titled `title`. */
function selectBox(page: Page, title: string) {
  return page.getByRole("checkbox", { name: `Select ${title}` }).first();
}

/** Upload `bytes` through the picker input and return when queued. */
async function uploadViaPicker(
  page: Page,
  name: string,
  bytes: Buffer,
  mimeType = "application/pdf",
): Promise<void> {
  await page
    .locator('[data-slot="document-upload-zone"] input[type="file"]')
    .setInputFiles([{ name, mimeType, buffer: bytes }]);
}

function uniquePdf(marker: string): Buffer {
  return Buffer.from(
    `%PDF-1.4\n%${marker}-${Date.now()}-${Math.random()}\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n`,
    "utf8",
  );
}

async function runAxe(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  if (blocking.length > 0) {
    // Pretty-print so failures are actionable in CI logs.
    console.log(
      "axe violations:\n" +
        blocking
          .map(
            (v) =>
              `  - [${v.impact}] ${v.id}: ${v.help}\n    ${v.nodes
                .map((n) => n.target.join(" "))
                .join("\n    ")}`,
          )
          .join("\n"),
    );
  }
  return blocking;
}

async function mockDocumentCoach(page: Page): Promise<void> {
  const fulfil = (
    route: Parameters<Parameters<Page["route"]>[1]>[0],
    data: unknown,
  ) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data, error: null }),
    });

  await page.route("**/api/documents/inbound/usage", (route) =>
    fulfil(route, {
      usedBytes: 4096,
      quotaBytes: 1_073_741_824,
      maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      acceptedExtensions: [".pdf", ".png", ".jpg", ".jpeg", ".webp"],
      linkedEpisodes: [],
      assistAvailable: true,
      contentIndex: { enabled: true, indexedCount: 1, totalCount: 1 },
    }),
  );
  await page.route("**/api/documents/inbound/capability", (route) =>
    fulfil(route, {
      available: true,
      mode: "vision",
      reason: null,
      pdfSupported: true,
      egress: "external",
    }),
  );
  await page.route("**/api/auth/me/documents-auto-ai-read", (route) =>
    fulfil(route, { documentsAutoAiRead: false }),
  );
}

test.describe("document vault", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeAll(async () => {
    await ensureVaultFixture();
  });

  // ── §1A — the 30-second doctor flow, three independent routes ─────────

  test("doctor flow A: the type filter reaches the MRT report", async ({
    page,
  }) => {
    await page.goto("/documents");
    await expect(
      page.getByRole("heading", { name: "Documents" }),
    ).toBeVisible();

    // Open the type dropdown, tick Imaging (multi-select stays open), then
    // dismiss the menu.
    await page.getByRole("button", { name: "All types" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Imaging" }).click();
    await page.keyboard.press("Escape");
    // Autumn 2025 sits below the newest sections — scroll the window down.
    await scrollUntilVisible(page, openButton(page, "MRT Knie"));
    await openButton(page, "MRT Knie").click();

    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("MRT Knie").first()).toBeVisible();
    // Inline preview (Class A PDF) mounts against the serve route.
    await expect(sheet.locator("iframe")).toBeVisible({ timeout: 5_000 });
  });

  test("doctor flow B: the condition filter reaches the MRT report", async ({
    page,
  }) => {
    await page.goto("/documents");
    // Open the condition dropdown and pick the linked episode (single-select
    // → the menu closes on choice).
    await page.locator('[data-slot="document-condition-filter"]').click();
    await page
      .getByRole("menuitemcheckbox", { name: "Knie", exact: true })
      .click();

    // The Knie filter narrows the corpus to the linked MRT trio.
    await expect(openButton(page, "MRT Knie")).toBeVisible();
    await expect(openButton(page, "MRT Aufnahme 1")).toBeVisible();
    await openButton(page, "MRT Knie").click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("doctor flow C: text search reaches the MRT report", async ({
    page,
  }) => {
    await page.goto("/documents");
    await page.getByRole("searchbox", { name: "Search documents" }).fill("MRT");
    // 200 ms debounce → URL → refetch.
    await expect(openButton(page, "MRT Knie")).toBeVisible();
    await openButton(page, "MRT Knie").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page).toHaveURL(/q=MRT/);
  });

  // ── URL deep links ─────────────────────────────────────────────────────

  test("deep links land filtered: ?kind, ?year, ?episode, ?doc", async ({
    page,
  }) => {
    await page.goto("/documents?kind=IMAGING&year=2025");
    // A deep-linked facet surfaces on its dropdown trigger label.
    await expect(
      page.locator('[data-slot="document-type-filter"]'),
    ).toContainText("Imaging");
    await expect(
      page.locator('[data-slot="document-year-filter"]'),
    ).toContainText("2025");
    await scrollUntilVisible(page, openButton(page, "MRT Knie"));

    await page.goto(`/documents?episode=${KNIE_EPISODE_ID}`);
    await expect(openButton(page, "MRT Knie")).toBeVisible();
    await expect(openButton(page, "MRT Aufnahme 2")).toBeVisible();

    // `?doc=` opens the detail sheet; closing it strips the param.
    await page.goto(`/documents?episode=${KNIE_EPISODE_ID}&doc=${MRT_DOC_ID}`);
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("MRT Knie").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).not.toBeVisible();
    await expect(page).not.toHaveURL(/doc=/);
  });

  test("ordinary card selection owns doc history and preserves unrelated query state", async ({
    page,
  }) => {
    await page.goto(`/documents?episode=${KNIE_EPISODE_ID}&view=compact&q=MRT`);
    await expect(openButton(page, "MRT Knie")).toBeVisible();
    await openButton(page, "MRT Knie").click();
    const detail = page.getByRole("dialog", { name: "MRT Knie" });

    await expect
      .poll(() => new URL(page.url()).searchParams.get("doc"))
      .toBe(MRT_DOC_ID);
    expect(new URL(page.url()).searchParams.get("episode")).toBe(
      KNIE_EPISODE_ID,
    );
    expect(new URL(page.url()).searchParams.get("view")).toBe("compact");
    expect(new URL(page.url()).searchParams.get("q")).toBe("MRT");

    await page.goBack();
    await expect(detail).not.toBeVisible();
    expect(new URL(page.url()).searchParams.get("doc")).toBeNull();
    expect(new URL(page.url()).searchParams.get("view")).toBe("compact");

    await page.goForward();
    await expect(detail).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(detail).not.toBeVisible();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("doc"))
      .toBeNull();
    expect(new URL(page.url()).searchParams.get("episode")).toBe(
      KNIE_EPISODE_ID,
    );
    expect(new URL(page.url()).searchParams.get("view")).toBe("compact");
    expect(new URL(page.url()).searchParams.get("q")).toBe("MRT");
  });

  test("Coach close and overlay dismissal consume the document handoff", async ({
    page,
  }) => {
    await mockDocumentCoach(page);
    await page.goto(`/documents?episode=${KNIE_EPISODE_ID}&view=compact&q=MRT`);
    await expect(openButton(page, "MRT Knie")).toBeVisible();
    await openButton(page, "MRT Knie").click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("doc"))
      .toBe(MRT_DOC_ID);

    const detail = page.getByRole("dialog", { name: "MRT Knie" });
    await detail.locator('[data-slot="document-chat-open"]').click();
    const drawer = page.locator('[data-slot="coach-drawer"]');
    await expect(drawer).toBeVisible();
    await expect(detail).not.toBeVisible();

    await drawer.locator('[data-slot="coach-drawer-close"]').click();
    await expect(drawer).not.toBeVisible();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("doc"))
      .toBeNull();
    expect(new URL(page.url()).searchParams.get("episode")).toBe(
      KNIE_EPISODE_ID,
    );
    expect(new URL(page.url()).searchParams.get("view")).toBe("compact");
    expect(new URL(page.url()).searchParams.get("q")).toBe("MRT");
    await expect(detail).not.toBeVisible();

    await page.reload();
    await expect(detail).not.toBeVisible();
    expect(new URL(page.url()).searchParams.get("doc")).toBeNull();

    await expect(openButton(page, "MRT Knie")).toBeVisible();
    await openButton(page, "MRT Knie").click();
    await expect(detail).toBeVisible();
    await detail.locator('[data-slot="document-chat-open"]').click();
    await expect(drawer).toBeVisible();
    await page
      .locator('[data-slot="sheet-overlay"]')
      .last()
      .click({ position: { x: 2, y: 2 } });
    await expect(drawer).not.toBeVisible();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("doc"))
      .toBeNull();
    await expect(detail).not.toBeVisible();
  });

  test("Ask Coach maximize then browser back restores the selected document", async ({
    page,
  }) => {
    await mockDocumentCoach(page);
    await page.goto(`/documents?episode=${KNIE_EPISODE_ID}&view=compact&q=MRT`);
    await expect(openButton(page, "MRT Knie")).toBeVisible();
    await openButton(page, "MRT Knie").click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("doc"))
      .toBe(MRT_DOC_ID);

    const detail = page.getByRole("dialog", { name: "MRT Knie" });
    await detail.locator('[data-slot="document-chat-open"]').click();
    const drawer = page.locator('[data-slot="coach-drawer"]');
    await expect(drawer).toBeVisible();
    await drawer.locator('[data-slot="coach-drawer-maximize"]').click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/coach");
    expect(new URL(page.url()).searchParams.get("doc")).toBe(MRT_DOC_ID);

    await page.goBack();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/documents");
    await expect(detail).toBeVisible();
    const restoredUrl = new URL(page.url());
    expect(restoredUrl.searchParams.get("doc")).toBe(MRT_DOC_ID);
    expect(restoredUrl.searchParams.get("episode")).toBe(KNIE_EPISODE_ID);
    expect(restoredUrl.searchParams.get("view")).toBe("compact");
    expect(restoredUrl.searchParams.get("q")).toBe("MRT");
  });

  test("the condition page links into the vault and back", async ({ page }) => {
    await page.goto(`/illness/${KNIE_EPISODE_ID}`);
    const card = page.locator('[data-slot="episode-documents-card"]');
    await expect(card).toBeVisible();
    await card.getByRole("link", { name: /MRT Knie/ }).click();
    // Lands on the vault, episode-filtered, with the detail sheet open.
    await expect(page).toHaveURL(/\/documents\?episode=/);
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  // ── Delete → undo ──────────────────────────────────────────────────────

  test("delete then undo restores the document", async ({ page }, testInfo) => {
    // Unique per run — a stable name would leave a same-named twin from a
    // previous run in the corpus and break the disappearance assertion.
    const title = `undo-probe-${testInfo.project.name}-${Date.now()}`;
    await page.goto("/documents");
    await uploadViaPicker(page, `${title}.pdf`, uniquePdf(title));
    await page.getByRole("searchbox", { name: "Search documents" }).fill(title);
    // The uploaded card is optimistic and can paint before the 200 ms search
    // draft is committed to the URL. Opening it earlier races that pending
    // replace against the detail's `?doc=` history entry and closes the sheet.
    await expect
      .poll(() => new URL(page.url()).searchParams.get("q"))
      .toBe(title);
    await expect(openButton(page, `${title}.pdf`)).toBeVisible();

    await openButton(page, `${title}.pdf`).click();
    const sheet = page.getByRole("dialog", { name: `${title}.pdf` });
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Delete" }).click();

    // Undo toast → restore → the card returns.
    await expect(page.getByText("Document deleted.")).toBeVisible();
    await expect(openButton(page, `${title}.pdf`)).not.toBeVisible();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(openButton(page, `${title}.pdf`)).toBeVisible();
  });

  // ── Bulk flows (desktop-only: shift-click ranges are a pointer flow) ──

  test("bulk: 50-item kind change round-trips", async ({ page, isMobile }) => {
    test.skip(isMobile, "range selection is a desktop pointer flow");
    test.setTimeout(90_000);
    await seedNamespaceDocs("bulkfifty", 50);

    // Shared filing date → the namespace orders by id desc: "050" first,
    // "001" last. Anchor on the first card, shift-click the last.
    await page.goto("/documents?q=bulkfifty");
    await expect(openButton(page, "bulkfifty 050")).toBeVisible({
      timeout: 15_000,
    });
    await selectBox(page, "bulkfifty 050").click();
    await scrollUntilVisible(page, openButton(page, "bulkfifty 001"));
    await selectBox(page, "bulkfifty 001").click({ modifiers: ["Shift"] });

    const bar = page.locator('[data-slot="document-bulk-bar"]');
    await expect(bar).toBeVisible();
    await expect(bar.getByText("50 selected")).toBeVisible();

    await bar.getByRole("button", { name: "Change type" }).click();
    await page.getByRole("menuitem", { name: "Referral" }).click();
    await expect(page.getByText("50 document(s) updated")).toBeVisible({
      timeout: 15_000,
    });

    // Server state: all 50 now carry the new kind.
    const res = await page.request.get(
      "/api/documents/inbound?q=bulkfifty&kind=REFERRAL&limit=100",
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.documents).toHaveLength(50);
  });

  test("bulk: a partial failure surfaces per-id results", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "bulk selection is a desktop pointer flow");
    await seedNamespaceDocs("bulkpf", 5);

    await page.goto("/documents?q=bulkpf");
    for (let i = 1; i <= 5; i++) {
      const box = selectBox(page, `bulkpf 00${i}`);
      await scrollUntilVisible(page, box);
      await box.click();
    }
    await expect(page.getByText("5 selected")).toBeVisible();

    // Kill one of the five behind the selection's back (tombstone), so the
    // bulk call reports exactly one per-id failure.
    const list = await page.request.get(
      "/api/documents/inbound?q=bulkpf&limit=10",
    );
    const victim = (await list.json()).data.documents.find(
      (d: { title: string }) => d.title === "bulkpf 003",
    );
    const del = await page.request.delete(
      `/api/documents/inbound/${victim.id}`,
    );
    expect(del.status()).toBe(200);

    const bar = page.locator('[data-slot="document-bulk-bar"]');
    await bar.getByRole("button", { name: "Change type" }).click();
    await page.getByRole("menuitem", { name: "Insurance" }).click();
    await expect(page.getByText("1 of 5 could not be updated")).toBeVisible();
  });

  test("bulk: a selection above 100 chunks into two requests", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "range selection is a desktop pointer flow");
    test.setTimeout(120_000);
    await seedNamespaceDocs("bulkchunk", 101);

    // Newest-first by id tiebreak: "101" renders first, "001" last. Walk
    // the infinite query to the end (pages of 50) so the range can span
    // all 101, then anchor + shift-click.
    await page.goto("/documents?q=bulkchunk");
    await expect(openButton(page, "bulkchunk 101")).toBeVisible();
    await selectBox(page, "bulkchunk 101").click();
    await scrollUntilVisible(page, openButton(page, "bulkchunk 001"), 80);
    await selectBox(page, "bulkchunk 001").click({ modifiers: ["Shift"] });
    await expect(page.getByText("101 selected")).toBeVisible();

    let bulkPosts = 0;
    page.on("request", (req) => {
      if (
        req.method() === "POST" &&
        req.url().includes("/api/documents/inbound/bulk")
      ) {
        bulkPosts += 1;
      }
    });

    const bar = page.locator('[data-slot="document-bulk-bar"]');
    await bar.getByRole("button", { name: "Change type" }).click();
    await page.getByRole("menuitem", { name: "Vaccination" }).click();
    await expect(page.getByText("101 document(s) updated")).toBeVisible({
      timeout: 15_000,
    });
    expect(bulkPosts).toBe(2);
  });

  // ── Keyboard-only doctor flow ──────────────────────────────────────────

  test("keyboard-only: search, roving grid, Enter opens, Escape closes", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "keyboard navigation is a desktop flow");
    await page.goto("/documents");
    await expect(
      page.getByRole("heading", { name: "Documents" }),
    ).toBeVisible();

    // `/` focuses the search from anywhere.
    await page.keyboard.press("/");
    await expect(
      page.getByRole("searchbox", { name: "Search documents" }),
    ).toBeFocused();
    await page.keyboard.type("MRT");
    await expect(openButton(page, "MRT Knie")).toBeVisible();

    // Tab from the search into the grid's single roving slot (bounded walk
    // across the filter dropdowns), then arrows move the active card.
    let reachedGrid = false;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      const slot = await page.evaluate(
        () => document.activeElement?.getAttribute("data-slot") ?? "",
      );
      if (slot === "document-open") {
        reachedGrid = true;
        break;
      }
    }
    expect(reachedGrid).toBe(true);

    // Arrow keys move the roving slot; the focus lands asynchronously
    // (the target row may mount on the next virtualizer paint) — poll.
    const activeLabel = () =>
      page.evaluate(
        () => document.activeElement?.getAttribute("aria-label") ?? "",
      );
    const first = await activeLabel();
    await page.keyboard.press("ArrowRight");
    await expect.poll(activeLabel).not.toBe(first);
    await page.keyboard.press("ArrowLeft");
    await expect.poll(activeLabel).toBe(first);

    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Wait for the preview to finish loading — the sheet hands focus back
    // to the dialog after Chromium's PDF viewer grabs it, so Escape works
    // regardless of when the user presses it.
    await expect(dialog.locator("iframe")).toBeVisible();
    await page.waitForTimeout(250);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  });

  // ── Touch: long-press selects (mobile project only) ────────────────────

  test("long-press selects a card on touch", async ({ page, isMobile }) => {
    test.skip(!isMobile, "long-press is the touch selection gesture");
    await page.goto("/documents?q=MRT");
    const button = openButton(page, "MRT Knie");
    await expect(button).toBeVisible();

    await button.dispatchEvent("touchstart");
    await page.waitForTimeout(700);
    await button.dispatchEvent("touchend");

    await expect(page.locator('[data-slot="document-bulk-bar"]')).toBeVisible();
    await expect(page.getByText("1 selected")).toBeVisible();
  });

  // ── Page-wide drop + clipboard paste intake ────────────────────────────

  test("dropping a file anywhere on the page uploads it", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "OS file drag is a desktop gesture");
    await page.goto("/documents");
    await expect(
      page.getByRole("heading", { name: "Documents" }),
    ).toBeVisible();

    const marker = `drop-probe-${Date.now()}`;
    const dataTransfer = await page.evaluateHandle(
      ([name, content]) => {
        const dt = new DataTransfer();
        dt.items.add(
          new File([content], `${name}.pdf`, { type: "application/pdf" }),
        );
        return dt;
      },
      [marker, `%PDF-1.4\n%${marker}\n%%EOF\n`] as const,
    );

    await page.dispatchEvent("body", "dragenter", { dataTransfer });
    await expect(
      page.locator('[data-slot="document-drop-overlay"]'),
    ).toBeVisible();
    await page.dispatchEvent("body", "drop", { dataTransfer });
    await expect(
      page.locator('[data-slot="document-drop-overlay"]'),
    ).not.toBeVisible();

    // The stored card lands in the timeline once the upload settles.
    await page
      .getByRole("searchbox", { name: "Search documents" })
      .fill(marker);
    await expect(openButton(page, `${marker}.pdf`)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("pasting a file from the clipboard uploads it", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "clipboard file paste is a desktop gesture");
    await page.goto("/documents");
    await expect(
      page.getByRole("heading", { name: "Documents" }),
    ).toBeVisible();

    const marker = `paste-probe-${Date.now()}`;
    await page.evaluate(
      ([name, content]) => {
        const dt = new DataTransfer();
        dt.items.add(
          new File([content], `${name}.pdf`, { type: "application/pdf" }),
        );
        const event = new ClipboardEvent("paste", {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        });
        window.dispatchEvent(event);
      },
      [marker, `%PDF-1.4\n%${marker}\n%%EOF\n`] as const,
    );

    await page
      .getByRole("searchbox", { name: "Search documents" })
      .fill(marker);
    await expect(openButton(page, `${marker}.pdf`)).toBeVisible({
      timeout: 10_000,
    });
  });

  test("a duplicate upload highlights the existing row instead of storing twice", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "runs once on the desktop project (shared bucket)");
    await page.goto("/documents");
    const marker = `dup-probe-${Date.now()}`;
    const bytes = uniquePdf(marker);

    await uploadViaPicker(page, `${marker}.pdf`, bytes);
    await page
      .getByRole("searchbox", { name: "Search documents" })
      .fill(marker);
    await expect(openButton(page, `${marker}.pdf`)).toBeVisible();

    await uploadViaPicker(page, `${marker}-copy.pdf`, bytes);
    await expect(
      page.getByText("Already stored — highlighting the existing document."),
    ).toBeVisible();
    // One row, not two — the copy never landed.
    await expect(openButton(page, `${marker}-copy.pdf`)).not.toBeVisible();
  });

  // ── Admin cap: commit-on-Enter + rejection copy naming the limit ──────

  test("a 1 MB admin cap rejects an oversized upload with the limit in the copy", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "admin surface is a desktop flow");
    try {
      await page.goto("/admin/general");
      const capInput = page.getByRole("spinbutton", {
        name: "Document upload limit",
      });
      await expect(capInput).toBeEnabled();
      await capInput.fill("1");
      const saved = page.waitForResponse(
        (res) =>
          res.url().includes("/api/admin/settings") &&
          res.request().method() === "PUT",
      );
      await capInput.press("Enter");
      expect((await saved).status()).toBe(200);

      await page.goto("/documents");
      await expect(
        page.getByRole("heading", { name: "Documents" }),
      ).toBeVisible();
      // ~1.2 MB — over the 1 MB cap, far under the default.
      const big = Buffer.concat([
        Buffer.from("%PDF-1.4\n"),
        Buffer.alloc(1_200_000, 0x20),
      ]);
      await uploadViaPicker(page, "oversized-scan.pdf", big);
      await expect(
        page.getByText("This file is larger than the 1 MB limit."),
      ).toBeVisible();
    } finally {
      const restore = await page.request.put("/api/admin/settings", {
        data: { documentMaxFileBytes: DEFAULT_MAX_FILE_BYTES },
      });
      expect(restore.status()).toBe(200);
    }
  });

  // ── Accessibility ──────────────────────────────────────────────────────

  test("axe: the vault timeline has no serious or critical violations", async ({
    page,
  }) => {
    await page.goto("/documents");
    await expect(
      page.locator('[data-slot="document-card"]').first(),
    ).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");
    const blocking = await runAxe(page);
    expect(blocking).toHaveLength(0);
  });

  test("axe: the open detail sheet has no serious or critical violations", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "scanned once on the desktop project");
    await page.goto(`/documents?doc=${MRT_DOC_ID}`);
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.waitForLoadState("networkidle");
    const blocking = await runAxe(page);
    expect(blocking).toHaveLength(0);
  });

  test("axe: bulk mode has no serious or critical violations", async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "scanned once on the desktop project");
    await page.goto("/documents?q=MRT");
    await expect(openButton(page, "MRT Knie")).toBeVisible();
    await selectBox(page, "MRT Knie").click();
    await expect(page.locator('[data-slot="document-bulk-bar"]')).toBeVisible();
    const blocking = await runAxe(page);
    expect(blocking).toHaveLength(0);
  });
});
