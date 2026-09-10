/**
 * The doctor report is not something a READ-level delegate can generate.
 *
 * `POST /api/export/health-record` resolves `requireRecordAuth("manage",
 * "record")`: a prepared artefact from a declared selection is the one export an
 * invited MANAGER reaches, and READ is below that line. This spec proves both
 * halves of that refusal in a browser — the control is not offered, and the
 * route refuses the request anyway.
 *
 * Why both. A missing button proves nothing about the server, and a 403 proves
 * nothing about what the person is shown; the failure mode this release family
 * keeps rediscovering is a control that renders and then 403s. So the settings
 * page is asserted to carry the shared-record refusal panel instead of the
 * export card, and the route is asserted separately, from the same session.
 *
 * The positive control is the same delegate, the same payload and the same
 * switched-record plumbing against the record it holds a MANAGE grant on. That
 * isolates the one variable the refusal is supposed to be about: if the payload
 * were malformed, the session unfenced or the switch broken, the MANAGE arm
 * would refuse too and the file would go red instead of passing for the wrong
 * reason.
 *
 * Both requests carry the record-context headers the shipped client sends. A
 * raw `fetch` without them is refused by the record-session fence with the SAME
 * status and the SAME error code as an insufficient grant — so an unfenced
 * request would make the refusal below pass for the wrong reason. The context
 * is read from `/api/auth/me`, which is where a browser gets it too.
 *
 * Its own cookie jar, like every spec that moves a session's record selector:
 * the switch is stamped on the session row, so sharing a jar would switch the
 * record under whichever spec happened to be mid-navigation.
 */
import type { Page } from "@playwright/test";

import { expect, test } from "./setup/test";
import {
  E2E_LEVEL_RECORDS,
  REPORT_DELEGATE_STORAGE_STATE_PATH,
} from "./setup/test-helpers";

/** A selection the route accepts, so a refusal is about the grant and nothing
 *  else. One leaf is enough: an empty list is its own 422. */
const SELECTION = { v: 2, leaves: ["WEIGHT"] } as const;

interface ReportAttempt {
  status: number;
  contentType: string;
  errorCode: string | null;
  magic: string;
}

async function openSwitcher(page: Page): Promise<void> {
  await page.getByRole("button", { name: "User menu" }).first().click();
  await page.locator('[data-slot="account-switcher-trigger"]').click();
  await expect(
    page.locator('[data-slot="account-switcher-menu"]'),
  ).toBeVisible();
}

/**
 * Run `act` and wait for the document it replaces to be gone — the switch is a
 * hard navigation, and a banner assertion alone settles nothing. Same helper
 * shape the v1.37/v1.38 sharing journeys use, for the reason written there.
 */
async function withDocumentReplacement(
  page: Page,
  act: () => Promise<void>,
): Promise<void> {
  await page.evaluate(() => {
    (window as Window & { __hlNavToken?: true }).__hlNavToken = true;
  });
  await act();
  await page.waitForFunction(
    () =>
      (window as Window & { __hlNavToken?: true }).__hlNavToken === undefined,
    undefined,
    { timeout: 30_000 },
  );
}

/** Land on the delegate's own record, with the shell live. */
async function openOwnRecord(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("button", { name: "User menu" }).first(),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('[data-slot="shared-record-banner"]')).toHaveCount(
    0,
    { timeout: 30_000 },
  );
}

async function enterRecord(page: Page, username: string): Promise<void> {
  await openSwitcher(page);
  const entry = page.locator(
    `[data-slot="account-switcher-entry"][data-account-username="${username}"]`,
  );
  await expect(entry).toHaveCount(1);
  await withDocumentReplacement(page, () => entry.click());
  await expect(page.locator('[data-slot="shared-record-banner"]')).toBeVisible({
    timeout: 30_000,
  });
}

async function leaveRecord(page: Page): Promise<void> {
  await withDocumentReplacement(page, () =>
    page.locator('[data-slot="shared-record-banner-exit"]').click(),
  );
  await expect(page.locator('[data-slot="shared-record-banner"]')).toHaveCount(
    0,
    { timeout: 30_000 },
  );
}

/**
 * Open the health-record settings page and wait for the shell to decide.
 *
 * Inside somebody else's record the shell answers this destination with the
 * "not part of shared access" panel rather than the section, so the panel is
 * the settled state to gate on — and the thing whose presence says the export
 * card was never offered.
 */
async function openGesundheitsakte(page: Page): Promise<void> {
  await page.goto("/settings/gesundheitsakte", {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.locator('[data-slot="shared-record-unavailable"]'),
  ).toBeVisible({ timeout: 30_000 });
}

/**
 * Ask the route for a PDF from inside the page, carrying the record context the
 * shipped client carries.
 */
async function attemptReport(
  page: Page,
  selection: { v: number; leaves: readonly string[] },
): Promise<ReportAttempt> {
  return page.evaluate(async (chosen) => {
    const me = (await (await fetch("/api/auth/me")).json()) as {
      data: { recordSession: { epoch: number; scope: string | null } | null };
    };
    const context = me.data.recordSession;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (context) {
      headers["x-healthlog-record-epoch"] = String(context.epoch);
      headers["x-healthlog-record-scope"] = context.scope ?? "self";
    }

    const res = await fetch("/api/export/health-record", {
      method: "POST",
      headers,
      body: JSON.stringify({
        format: "pdf",
        locale: "en",
        range: { days: 30 },
        includeCharts: false,
        selection: chosen,
      }),
    });

    const contentType = res.headers.get("content-type") ?? "";
    const buffer = await res.arrayBuffer();
    const head = String.fromCharCode(...new Uint8Array(buffer.slice(0, 5)));

    let errorCode: string | null = null;
    if (contentType.includes("json")) {
      try {
        const payload = JSON.parse(new TextDecoder().decode(buffer)) as {
          meta?: { errorCode?: string };
        };
        errorCode = payload.meta?.errorCode ?? null;
      } catch {
        errorCode = null;
      }
    }

    return { status: res.status, contentType, errorCode, magic: head };
  }, selection);
}

test.describe.serial("a read-level delegate and the doctor report", () => {
  test.use({ storageState: REPORT_DELEGATE_STORAGE_STATE_PATH });

  const readRecord = E2E_LEVEL_RECORDS.find(
    (record) => record.access === "READ" && record.recordKind === "shared",
  );
  if (!readRecord) throw new Error("the READ-level record fixture is missing");

  const manageRecord = E2E_LEVEL_RECORDS.find(
    (record) => record.access === "MANAGE" && record.recordKind === "shared",
  );
  if (!manageRecord) {
    throw new Error("the MANAGE-level record fixture is missing");
  }

  test.afterEach(async ({ page }) => {
    // Hand the session back to its own record even when an assertion above
    // failed: this jar is this spec's, but a switched row left behind would
    // make its own next run start somewhere it did not choose.
    await page.request
      .post("/api/account/switch", { data: { accountId: null } })
      .catch(() => {});
  });

  test("cannot generate on a record it may only read, and is not offered the control", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await openOwnRecord(page);

    // Positive control: a record the same delegate MANAGES. Everything except
    // the access level is identical to the refusal below.
    await enterRecord(page, manageRecord.username);
    await expect(
      page.locator('[data-slot="shared-record-banner"]'),
    ).toHaveAttribute("data-access-level", "manage");
    const managed = await attemptReport(page, SELECTION);
    expect(managed.status).toBe(200);
    expect(managed.contentType).toContain("application/pdf");
    expect(managed.magic).toBe("%PDF-");
    await leaveRecord(page);

    await enterRecord(page, readRecord.username);
    const banner = page.locator('[data-slot="shared-record-banner"]');
    await expect(banner).toHaveAttribute("data-record-kind", "shared");
    // The banner carries the PRESENTATION of the grant, and a READ grant
    // presents as "view" — one level below the "view-and-add" a WRITE grant
    // shows and two below the "manage" this route requires.
    await expect(banner).toHaveAttribute("data-access-level", "view");

    // The control is not offered: the health-record page inside a shared record
    // is the refusal panel, not the export card.
    await openGesundheitsakte(page);
    await expect(page.getByTestId("health-record-export-panel")).toHaveCount(0);
    await expect(page.getByTestId("health-record-generate")).toHaveCount(0);

    // And the route refuses the request the absent control would have sent.
    const shared = await attemptReport(page, SELECTION);
    expect(shared.status).toBe(403);
    expect(shared.errorCode).toBe("sharing.access.denied");
    expect(shared.contentType).toContain("json");

    await leaveRecord(page);
  });
});
