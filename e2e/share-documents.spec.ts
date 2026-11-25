/**
 * v1.28 (document vault, Phase 3) — clinician document-sharing lifecycle e2e.
 *
 * Drives the whole public-surface path against the production server + a real
 * Postgres (migrations 0228 + 0229): the owner picks documents into a new share
 * link through the Settings picker, a recipient unlocks the link with the
 * passphrase and pulls each blob through the public `/c/<token>/d/<id>` serve
 * route, and a revoke closes it. The load-bearing assertions:
 *
 *   - the serve route confines to the link's FROZEN set — an owned document NOT
 *     attached to the link 404s (token-scoped, never a global document fetch);
 *   - the serving posture matches the owner route — Class A (PDF/JPEG) inline
 *     with its true type + nosniff + no-store, Class B (text) opaque
 *     `application/octet-stream` attachment;
 *   - EXIF/GPS is stripped from the shared JPEG on egress (the served bytes
 *     drop the marker the stored bytes still carry);
 *   - revocation is enforced at serve time — a revoked link serves nothing;
 *   - the clinician view renders inline previews (img/iframe) for Class A and a
 *     download-only affordance for Class B;
 *   - the create reveal promotes a scannable QR (runs under the 390px mobile
 *     project too).
 *
 * The share fixtures (`ensureShareDocFixture`) seed the attached trio; the
 * broader corpus (`ensureVaultFixture`) supplies the ≥50 documents the picker
 * cap test and the not-attached foreign-id probe need.
 */
import type { Browser, Page } from "@playwright/test";
import { expect, test } from "./setup/test";

import { E2E_USER, STORAGE_STATE_PATH } from "./setup/global-setup";
import {
  completeReproofWithPassword,
  useStaleSession,
} from "./setup/recent-proof";
import {
  ensureShareDocFixture,
  ensureVaultFixture,
  MRT_DOC_ID,
  SHARE_DOC_PREFIX,
  SHARE_JPEG_DOC_ID,
  SHARE_PDF_DOC_ID,
  SHARE_TEXT_DOC_ID,
} from "./setup/vault-fixture";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";

/** An owned document from the broad corpus that is NEVER attached to the link
 *  under test — the foreign-id probe against the frozen-set confinement. */
const UNATTACHED_OWNED_DOC_ID = "e2evaultdoc000000000000";

interface CreatedShare {
  token: string;
  passphrase: string;
  label: string;
}

/**
 * Drive the owner create flow: name the link, choose a record scope, open the
 * picker, isolate the share-fixture trio by search, select all three, create
 * the link, and read the one-time token + passphrase off the reveal card. Also
 * asserts the QR promotion.
 */
async function createShareWithDocs(page: Page): Promise<CreatedShare> {
  const label = `${SHARE_DOC_PREFIX} ${Date.now()}`;

  const sharingDataReady = page.waitForResponse(
    (response) =>
      response.status() === 200 &&
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/share-links",
  );
  await page.goto("/settings/sharing");
  await sharingDataReady;
  await page.locator("#share-label").fill(label);
  // A record link starts with an empty scope and cannot be minted on one, so
  // the scope is chosen here the way an owner chooses it: one click on the
  // named standard set.
  await page.getByTestId("report-apply-standard-share").click();

  // Open the document picker and isolate the seeded trio.
  await page.getByTestId("share-attach-open").click();
  const search = page.getByPlaceholder("Search documents");
  await search.fill(SHARE_DOC_PREFIX);
  const list = page.getByTestId("share-doc-picker-list");
  await expect(list).toBeVisible();
  // Exactly the three share-fixture documents match the prefix.
  const rows = list.getByRole("button");
  await expect(rows).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    const row = rows.nth(i);
    await row.click();
    await expect(row).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByRole("button", { name: "Done" }).click();

  // Three chips staged before create.
  await expect(
    page.getByTestId("share-attached-chips").getByRole("listitem"),
  ).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Create link" })).toBeEnabled();

  await page.getByRole("button", { name: "Create link" }).click();
  // Making a link asks for a recent proof, and the session is a stale one
  // (see the `beforeEach`), so the owner confirms it is them first.
  await completeReproofWithPassword(page, E2E_USER.password);

  const reveal = page.getByTestId("share-token-reveal");
  await expect(reveal).toBeVisible();
  await expect(page.getByTestId("share-created-doc-count")).toContainText("3");

  // QR promotion — present and rendered at a scannable size (the UI wave
  // promoted it as the primary mobile affordance; runs under the 390px project).
  const qrBlock = page.getByTestId("share-qr-block");
  await expect(qrBlock).toBeVisible();
  const qrImg = qrBlock.getByRole("img");
  await expect(qrImg).toBeVisible();
  const box = await qrImg.boundingBox();
  expect(box, "QR image has a rendered box").not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(160);

  // The one-time secrets: token from the share URL, passphrase from its cell.
  const shareUrl = (await reveal.locator("code").first().innerText()).trim();
  const token = shareUrl.split("/c/")[1];
  expect(token, "token parsed from share URL").toMatch(/^hls_[0-9a-f]{48}$/);
  const passphrase = (
    await page.getByTestId("share-passphrase").innerText()
  ).trim();
  expect(passphrase.length).toBeGreaterThan(0);

  return { token, passphrase, label };
}

/** A recipient browser context (no owner session) that has unlocked `token`
 *  by following the `#k=<passphrase>` deep link the QR encodes. */
async function openUnlockedClinician(
  browser: Browser,
  share: CreatedShare,
): Promise<Page> {
  const ctx = await browser.newContext({
    baseURL: BASE,
    serviceWorkers: "block",
  });
  const page = await ctx.newPage();
  // The gate reads `#k=` from the fragment, POSTs the unlock, and reloads with
  // the record — exactly what a clinician scanning the QR would trigger.
  await page.goto(`${BASE}/c/${share.token}#${"k"}=${share.passphrase}`);
  await expect(
    page.getByRole("heading", { name: "Shared health record" }),
  ).toBeVisible({ timeout: 15_000 });
  return page;
}

test.describe("clinician document sharing", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  // Every test here starts from a session signed in ten minutes ago, so making
  // a link always meets the re-proof dialog rather than only when the run has
  // been going for five minutes.
  let endStaleSession: (() => Promise<void>) | null = null;
  test.beforeEach(async ({ page }) => {
    endStaleSession = await useStaleSession(page, E2E_USER.username);
  });
  test.afterEach(async () => {
    await endStaleSession?.();
    endStaleSession = null;
  });

  test.beforeAll(async () => {
    await ensureVaultFixture();
    await ensureShareDocFixture();
  });

  test("share → unlock → serve (posture + EXIF strip) → revoke → 404", async ({
    page,
    browser,
  }) => {
    // A full lifecycle across two browser contexts (owner create + picker,
    // recipient unlock, several document serves, revoke): legitimately heavy,
    // so it earns the tripled timeout rather than racing the default 30s on a
    // loaded CI runner.
    test.slow();
    const share = await createShareWithDocs(page);
    const clinician = await openUnlockedClinician(browser, share);

    // ── The clinician view lists the documents with the right affordances ──
    await expect(
      clinician.getByRole("heading", { name: "Documents" }),
    ).toBeVisible();
    // Class A image → inline <img> at the token-scoped serve route.
    const inlineImage = clinician.getByRole("img", {
      name: "Share e2e scan",
    });
    await expect(inlineImage).toBeVisible();
    await expect(inlineImage).toHaveAttribute(
      "src",
      new RegExp(`/d/${SHARE_JPEG_DOC_ID}$`),
    );
    // Class A PDF → inline <iframe> at the same route family.
    await expect(
      clinician.locator(`iframe[src*="/d/${SHARE_PDF_DOC_ID}"]`),
    ).toHaveCount(1);
    // Class B text → NO inline frame; the download-only hint is shown.
    await expect(
      clinician.locator(`iframe[src*="/d/${SHARE_TEXT_DOC_ID}"]`),
    ).toHaveCount(0);
    await expect(
      clinician.getByText("This file downloads to your device"),
    ).toBeVisible();

    const serve = (id: string) => `${BASE}/c/${share.token}/d/${id}`;

    // ── Class A PDF: inline, true type, nosniff, no-store ──
    const pdf = await clinician.request.get(serve(SHARE_PDF_DOC_ID));
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toBe("application/pdf");
    expect(pdf.headers()["content-disposition"]).toContain("inline");
    expect(pdf.headers()["x-content-type-options"]).toBe("nosniff");
    // The proxy's `/c/` edge block wins over the route header (middleware
    // headers override route headers), yielding a stricter no-store posture.
    expect(pdf.headers()["cache-control"]).toContain("no-store");
    // The proxy owns the CSP for this path (SAMEORIGIN framing + document CSP).
    expect(pdf.headers()["content-security-policy"]).toContain(
      "frame-ancestors 'self'",
    );
    expect(pdf.headers()["x-frame-options"]).toBe("SAMEORIGIN");

    // ── Class A JPEG: inline image, EXIF/GPS stripped on egress ──
    const jpeg = await clinician.request.get(serve(SHARE_JPEG_DOC_ID));
    expect(jpeg.status()).toBe(200);
    expect(jpeg.headers()["content-type"]).toBe("image/jpeg");
    expect(jpeg.headers()["content-disposition"]).toContain("inline");
    const jpegBody = await jpeg.body();
    expect(
      jpegBody.includes(Buffer.from("GPSLatitude")),
      "served JPEG must not carry the stored GPS marker",
    ).toBe(false);

    // ── Class B text: opaque octet-stream attachment (never inline) ──
    const txt = await clinician.request.get(serve(SHARE_TEXT_DOC_ID));
    expect(txt.status()).toBe(200);
    expect(txt.headers()["content-type"]).toBe("application/octet-stream");
    expect(txt.headers()["content-disposition"]).toContain("attachment");
    expect(txt.headers()["x-content-type-options"]).toBe("nosniff");

    // ── Frozen-set confinement: an OWNED but un-attached document 404s ──
    const foreign = await clinician.request.get(serve(UNATTACHED_OWNED_DOC_ID));
    expect(foreign.status()).toBe(404);
    // A syntactically-plausible but unknown id also 404s (same blunt miss).
    const guessed = await clinician.request.get(
      serve("e2edoesnotexist00000001"),
    );
    expect(guessed.status()).toBe(404);

    // ── Revoke through the owner UI, then the serve route stops cold ──
    await page.reload();
    const activeItem = page
      .getByTestId("share-active-list")
      .getByRole("listitem")
      .filter({ hasText: share.label })
      .first();
    await expect(activeItem).toBeVisible();
    await activeItem.getByRole("button", { name: "Revoke" }).click();
    // Confirm in the alert dialog.
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Revoke" })
      .click();

    // The already-unlocked recipient can no longer pull any blob — revocation
    // is re-enforced at serve time, before any decrypt.
    await expect(async () => {
      const afterRevoke = await clinician.request.get(serve(SHARE_PDF_DOC_ID));
      expect(afterRevoke.status()).toBe(404);
    }).toPass({ timeout: 10_000 });

    await clinician.context().close();
  });

  test("the document Share action mints a DOCUMENT-ONLY link — the document, never the record", async ({
    page,
    browser,
  }) => {
    // Opens two stacked sheets (detail → share), drives a real create with the
    // one-time QR render, then unlocks the link as a recipient to prove the
    // served view carries the document and ZERO health metrics. Heavier than
    // the default 30s budget. Runs on the desktop and 390px mobile projects.
    test.slow();

    // Deep-link straight to the document detail sheet.
    await page.goto(`/documents?doc=${MRT_DOC_ID}`);
    const detail = page.getByRole("dialog").filter({ hasText: "MRT Knie" });
    await expect(detail).toBeVisible();

    // The Share action sits beside Download in the footer.
    await detail.getByRole("button", { name: "Share" }).click();

    // The share flow opens with the document already attached and its title
    // pre-filled as the link label — no context switch to Settings.
    const shareSheet = page
      .getByRole("dialog")
      .filter({ hasText: "Share this document" });
    await expect(shareSheet).toBeVisible();
    await expect(shareSheet.locator("#share-label")).toHaveValue("MRT Knie");
    const chips = shareSheet
      .getByTestId("share-attached-chips")
      .getByRole("listitem");
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toContainText("MRT Knie");

    // Document-only mode hides every record-scope control: no FHIR API toggle,
    // no FHIR resource-type checkboxes, no history-range selector. Only the
    // document, label, and expiry remain.
    await expect(shareSheet.locator("#share-fhir")).toHaveCount(0);
    await expect(shareSheet.locator("#share-range")).toHaveCount(0);
    await expect(shareSheet.locator("#share-expiry")).toHaveCount(1);

    // Create the link — the one-time reveal (with the scannable QR) lands in
    // the same sheet, carrying the one attached document.
    await shareSheet.getByRole("button", { name: "Create link" }).click();
    await completeReproofWithPassword(page, E2E_USER.password);
    const reveal = shareSheet.getByTestId("share-token-reveal");
    await expect(reveal).toBeVisible();
    await expect(
      shareSheet.getByTestId("share-created-doc-count"),
    ).toContainText("1");
    const qrImg = shareSheet.getByTestId("share-qr-block").getByRole("img");
    await expect(qrImg).toBeVisible();
    const box = await qrImg.boundingBox();
    expect(box, "QR image has a rendered box").not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(160);

    // Read the one-time secrets off the reveal and unlock the link as a
    // recipient (no owner session).
    const shareUrl = (await reveal.locator("code").first().innerText()).trim();
    const token = shareUrl.split("/c/")[1];
    expect(token, "token parsed from share URL").toMatch(/^hls_[0-9a-f]{48}$/);
    const passphrase = (
      await shareSheet.getByTestId("share-passphrase").innerText()
    ).trim();
    const clinician = await openUnlockedClinician(browser, {
      token,
      passphrase,
      label: "MRT Knie",
    });

    // The served view lists the attached document…
    await expect(
      clinician.getByRole("heading", { name: "Documents" }),
    ).toBeVisible();
    await expect(
      clinician.locator(
        `iframe[src*="/d/${MRT_DOC_ID}"], img[src*="/d/${MRT_DOC_ID}"]`,
      ),
    ).toHaveCount(1);

    // …and NOTHING from the health record: no vitals, no labs, no medications,
    // no reporting-period line. This is the privacy guarantee — sharing a
    // document must never expose a single metric.
    await expect(
      clinician.getByRole("heading", { name: "Vital signs" }),
    ).toHaveCount(0);
    await expect(clinician.locator('[data-leaf~="LAB_RESULTS"]')).toHaveCount(
      0,
    );
    await expect(
      clinician.getByRole("heading", { name: "Medications & adherence" }),
    ).toHaveCount(0);
    await expect(clinician.getByText("Reporting period:")).toHaveCount(0);

    await clinician.context().close();
  });

  test("picker enforces the document cap at the limit", async ({ page }) => {
    await page.goto("/settings/sharing");
    await page.locator("#share-label").fill(`${SHARE_DOC_PREFIX} cap`);
    await page.getByTestId("share-attach-open").click();

    const list = page.getByTestId("share-doc-picker-list");
    await expect(list).toBeVisible();
    // The picker loads one page (server `limit=50`), which equals the cap; the
    // corpus fixture guarantees a full page.
    const rows = list.getByRole("button");
    const count = await rows.count();
    expect(count).toBeGreaterThanOrEqual(50);

    // Select up to the cap. Each click below the cap is enabled; the click that
    // reaches the cap flips `atCap`, after which the max-reached banner shows.
    for (let i = 0; i < 50; i++) await rows.nth(i).click();

    await expect(
      page.getByText("You've reached the maximum of 50"),
    ).toBeVisible();
    // The footer count is pinned at the cap ("50 of 50 selected").
    await expect(page.getByText("50 of 50 selected").first()).toBeVisible();
  });
});
