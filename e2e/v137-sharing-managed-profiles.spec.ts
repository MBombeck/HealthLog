import type { Page } from "@playwright/test";

import { expect, test } from "./setup/test";
import {
  E2E_LEVEL_RECORDS,
  E2E_SCOPE_DELEGATE,
  E2E_SCOPE_RECORDS,
  GUARDIAN_STORAGE_STATE_PATH,
  SCOPE_DELEGATE_STORAGE_STATE_PATH,
} from "./setup/test-helpers";
import {
  clearGuardianProfiles,
  refreshGuardianStepUp,
} from "./setup/managed-profile-fixture";

const DOMAIN_READS = {
  measurements: "/api/measurements",
  medications: "/api/medications",
  labs: "/api/labs",
  profile: "/api/profile/summary",
  illness: "/api/illness/episodes",
  mind: "/api/mood-entries",
  cycle: "/api/cycle/calendar",
  documents: "/api/documents/inbound",
} as const;

/**
 * v1.37.0 — the record-session assertion the app is currently sending.
 *
 * The two API probes in this file are deliberate: they check a status code the
 * UI does not surface (a MANAGE-only generated read) and a payload the UI
 * paginates. But a bare `fetch` inside `page.evaluate` carries no
 * record-session headers, and the fence refuses an unasserted request on any
 * session that has been inside a shared record — so the probes started failing
 * with 403 for a reason that had nothing to do with what they test.
 *
 * They are NOT an old-bundle simulation and must not become one: that case is
 * covered deliberately in `src/__tests__/record-session-fence-compat.test.ts`
 * and `tests/integration/record-session-fence.test.ts`, where the 403 and the
 * recovery are the subject. Here the subject is the grant level, so the probe
 * asserts exactly what the app beside it asserts — copied off a real app
 * request rather than computed, so it cannot drift from what the client
 * actually believes.
 */
function trackFenceAssertion(page: Page): () => {
  "x-healthlog-record-epoch": string;
  "x-healthlog-record-scope": string;
} {
  // The HIGHEST epoch seen, not the most recent one observed.
  //
  // The counter is monotonic, and requests do not arrive in the order they
  // were issued: a request from the page before a switch can be seen after one
  // from the page after it, and last-writer-wins then leaves the probe holding
  // a context the session has already left — a 409, intermittently, on a test
  // about grant levels. Taking the maximum removes the ordering question
  // rather than trying to win it.
  let latest = { epoch: "bootstrap", scope: "bootstrap", seen: -1 };
  page.on("request", (request) => {
    const headers = request.headers();
    const epoch = headers["x-healthlog-record-epoch"];
    const scope = headers["x-healthlog-record-scope"];
    if (epoch === undefined || scope === undefined) return;
    if (!/^\d+$/.test(epoch)) return;
    const value = Number(epoch);
    if (value < latest.seen) return;
    latest = { epoch, scope, seen: value };
  });
  return () => ({
    "x-healthlog-record-epoch": latest.epoch,
    "x-healthlog-record-scope": latest.scope,
  });
}

async function openSwitcher(page: Page) {
  await page.getByRole("button", { name: "User menu" }).first().click();
  await page.locator('[data-slot="account-switcher-trigger"]').click();
  await expect(
    page.locator('[data-slot="account-switcher-menu"]'),
  ).toBeVisible();
}

/**
 * Run `act` and wait for the document it replaces to be gone.
 *
 * Entering or leaving a record is a server write followed by
 * `window.location.assign`, so the click that starts it returns long before the
 * document it produces exists. Everything a test does next races the app's own
 * navigation, and both ways of losing that race are silent:
 *
 *   - a `page.goto` issued into the gap is cancelled when the assign commits,
 *     which Chromium reports as `net::ERR_ABORTED`;
 *   - or the goto wins, and the page it lands on belongs to the CALLER'S OWN
 *     record, where a route that is ungranted in somebody else's record is
 *     simply granted. Measured: `/coach` opened in that gap issued all four of
 *     the protected reads the test asserts never happen. The assertion was
 *     reading the wrong record, and it could as easily have passed there.
 *
 * Neither is visible in the DOM the click leaves behind, which is why waiting
 * on the banner cannot settle it — the pre-navigation document already shows
 * whatever the next assertion looks for, so the wait returns immediately and
 * proves nothing. A marker on `window` can settle it, because a document
 * replacement is the one thing that destroys it, and no amount of re-rendering
 * inside the old document will.
 *
 * If the navigation never happens the wait fails, which is the right outcome:
 * a switch that did not land is a failure and not something to paper over.
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

async function openRecord(page: Page, username: string) {
  await page.goto("/");
  await openSwitcher(page);

  const entry = page.locator(
    `[data-slot="account-switcher-entry"][data-account-username="${username}"]`,
  );
  await expect(entry).toHaveCount(1);
  const accountId = await entry.getAttribute("data-account-id");
  if (accountId === null) {
    throw new Error(`Account switcher entry for ${username} has no account id`);
  }
  const accessLevel = await entry.getAttribute("data-access-level");
  const recordKind = await entry.getAttribute("data-record-kind");
  await withDocumentReplacement(page, () => entry.click());
  // The switch landed AND the record it landed in is the one on screen. Callers
  // may navigate away immediately after this, and until both are true there is
  // no record to navigate away from.
  await expect(page.locator('[data-slot="shared-record-banner"]')).toBeVisible({
    timeout: 30_000,
  });
  return { accountId, accessLevel, recordKind };
}

/**
 * Leave the record and prove the own-record shell is back.
 *
 * Leaving replaces the document, and the protected shell renders its
 * hydration gate — no nav, no banner, no page body — until `/api/auth/me`
 * resolves. "The banner is gone" is true of that gate as well, so on its own
 * it is satisfied by the document on its way out and is not a wait at all.
 * The top bar only exists past the gate, so it is the anchor the absence
 * hangs on.
 */
async function leaveRecord(page: Page) {
  await withDocumentReplacement(page, () =>
    page.locator('[data-slot="shared-record-banner-exit"]').click(),
  );
  await expect(
    page.locator('[data-slot="record-scope-hydration-gate"]'),
  ).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('[data-slot="top-bar"]')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('[data-slot="shared-record-banner"]')).toHaveCount(
    0,
    { timeout: 30_000 },
  );
}

function withDivergentActiveAccountAccess(body: unknown): unknown {
  if (body === null || typeof body !== "object") {
    throw new Error("Expected an object from /api/auth/me");
  }

  const envelope = body as { data?: unknown };
  const payload = "data" in envelope ? envelope.data : envelope;
  if (payload === null || typeof payload !== "object") {
    throw new Error("Expected an auth payload from /api/auth/me");
  }

  const auth = payload as {
    accountAccess?: {
      active?: {
        access?: unknown;
        level?: unknown;
        canWrite?: unknown;
      } | null;
    };
  };
  if (!auth.accountAccess?.active) {
    throw new Error("Expected a switched account-access payload");
  }

  const corrupted = {
    ...auth,
    accountAccess: {
      ...auth.accountAccess,
      active: {
        ...auth.accountAccess.active,
        access: "write",
        level: "write",
        canWrite: true,
      },
    },
  };
  return "data" in envelope ? { ...envelope, data: corrupted } : corrupted;
}

test.describe.serial("scoped sharing browser journeys", () => {
  test.use({ storageState: SCOPE_DELEGATE_STORAGE_STATE_PATH });

  for (const record of E2E_SCOPE_RECORDS) {
    test(`opens only the ${record.domain} record doorway`, async ({ page }) => {
      await page.goto("/");
      await openSwitcher(page);

      const entry = page.locator(
        `[data-slot="account-switcher-entry"][data-account-username="${record.username}"]`,
      );
      await expect(entry).toHaveCount(1);

      // The labs doorway must not pull the OCR capability probe: OCR is an
      // owner surface and a scoped READ grant does not reach it.
      //
      // Proved with a listener rather than `waitForRequest(…, { timeout })`,
      // and the difference is not stylistic. A timed wait is an instrument
      // that FAILS by its own mechanics: the rejection it produces is the
      // pass condition, so it has to be created early and awaited late, and in
      // between it is an unhandled rejection that lands on whichever test
      // happens to be finishing. Its window is wrong too — the 500 ms starts
      // before the switch is even clicked, so on a slow runner it can expire
      // before the labs page has loaded, which is the one moment it exists to
      // watch.
      //
      // A listener has no timer to lose. It covers everything from before the
      // click to after the record read has landed, which is strictly more than
      // 500 ms, and it is asserted below with a paired positive control: the
      // domain's own read must appear in the same set, so a matcher that
      // stopped seeing requests fails instead of reporting an absence.
      const seenPaths = new Set<string>();
      page.on("request", (request) => {
        if (request.method() !== "GET") return;
        seenPaths.add(new URL(request.url()).pathname);
      });

      const read = page.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          new URL(response.url()).pathname === DOMAIN_READS[record.domain],
      );
      await entry.click();

      await expect(page).toHaveURL(new RegExp(`${record.href}$`));
      await expect(
        page.locator('[data-slot="shared-record-banner"]'),
      ).toContainText(record.username);
      await expect(
        page.locator(`a[href="${record.href}"]`).first(),
      ).toBeVisible();
      await expect(
        page.locator('[data-slot="shared-record-unavailable"]'),
      ).toHaveCount(0);
      await read;

      // The positive control first: if this path is missing the listener saw
      // nothing useful and the absence below would be a statement about the
      // matcher rather than about the product.
      expect(
        [...seenPaths],
        `the ${record.domain} read never reached the request listener`,
      ).toContain(DOMAIN_READS[record.domain]);
      if (record.domain === "labs") {
        expect(
          [...seenPaths],
          "a scoped labs grant pulled the owner-only OCR capability probe",
        ).not.toContain("/api/labs/ocr/capability");
      }

      await leaveRecord(page);
    });
  }

  test("refuses a malformed switched payload before target or owner reads mount", async ({
    page,
  }) => {
    await page.goto("/");
    await openSwitcher(page);

    const entry = page.locator(
      '[data-slot="account-switcher-entry"][data-account-username="e2e-scope-labs"]',
    );
    await expect(entry).toHaveCount(1);

    // The switch normally writes this mirror before its full reload. Remove it
    // in the new document so the global preloaders cannot guess an own-record
    // scope while `/api/auth/me` is still deciding whether the target is safe.
    await page.addInitScript(() => {
      localStorage.removeItem("healthlog-record-scope");
    });

    let corruptAuthPayload = true;
    await page.route("**/api/auth/me", async (route) => {
      // The switch this test drives ends in a full reload, and the reload
      // cancels whatever `/api/auth/me` call is in flight. Playwright then
      // considers the route handled, and the `fulfill` below lands on it with
      // "Route is already handled!" — a failure of the teardown, not of the
      // thing under test, and one that turns the whole shard red under
      // `failOnFlakyTests`.
      //
      // Same guard as `v137-record-session-fence.spec.ts` and the a11y sibling
      // of this file. The fetch is guarded too: a request cancelled mid-flight
      // rejects there rather than at the fulfill.
      let response;
      try {
        response = await route.fetch();
      } catch {
        return;
      }
      if (!corruptAuthPayload) {
        await route.fulfill({ response }).catch(() => {});
        return;
      }
      await route
        .fulfill({
          response,
          json: withDivergentActiveAccountAccess(await response.json()),
        })
        .catch(() => {});
    });

    const ownerOnlyReads: string[] = [];
    const trackOwnerOnlyRead = (request: {
      method(): string;
      url(): string;
    }) => {
      if (request.method() !== "GET") return;
      const path = new URL(request.url()).pathname;
      if (
        [
          "/api/labs/ocr/capability",
          "/api/insights/coach/nudge-status",
          "/api/coach/about-me/questions",
          "/api/auth/me/notification-prefs",
        ].includes(path)
      ) {
        ownerOnlyReads.push(path);
      }
    };
    page.on("request", trackOwnerOnlyRead);
    const targetPreloads: string[] = [];
    const trackTargetPreload = (request: {
      method(): string;
      url(): string;
    }) => {
      if (request.method() !== "GET") return;
      const path = new URL(request.url()).pathname;
      if (
        [
          "/api/dashboard/snapshot",
          "/api/medications",
          "/api/medications/compliance",
        ].includes(path)
      ) {
        targetPreloads.push(path);
      }
    };
    page.on("request", trackTargetPreload);
    try {
      await entry.click();

      await expect(page).toHaveURL(/\/labs$/);
      await expect(
        page.locator('[data-slot="invalid-record-access-refusal"]'),
      ).toBeVisible();
      await expect(
        page.locator('[data-slot="shared-record-unavailable-leave"]'),
      ).toBeVisible();
      await expect(page.locator('[data-tour-id="labs-hero"]')).toHaveCount(0);
      await expect(
        page.locator('[data-slot="shared-record-banner"]'),
      ).toHaveCount(0);

      // Both global preloader routes must remain inert while the malformed
      // response is refused, even though the scope mirror was intentionally
      // cleared before each reload.
      await page.goto("/");
      await expect(
        page.locator('[data-slot="invalid-record-access-refusal"]'),
      ).toBeVisible();
      await page.goto("/medications");
      await expect(
        page.locator('[data-slot="invalid-record-access-refusal"]'),
      ).toBeVisible();
      expect(ownerOnlyReads).toEqual([]);
      expect(targetPreloads).toEqual([]);

      // Leave the refused record, then demand fresh own-record reads. This
      // catches a response that was parked under the owner hash while the
      // refusal was on screen and would otherwise paint without a new request.
      corruptAuthPayload = false;
      const freshDashboard = page.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          new URL(response.url()).pathname === "/api/dashboard/snapshot",
      );
      await page
        .locator('[data-slot="shared-record-unavailable-leave"]')
        .click();
      await expect(page).toHaveURL(/\/$/);
      await freshDashboard;

      const freshMedications = page.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          new URL(response.url()).pathname === "/api/medications",
      );
      await page.goto("/medications");
      await freshMedications;
    } finally {
      page.off("request", trackOwnerOnlyRead);
      page.off("request", trackTargetPreload);
      await page.unroute("**/api/auth/me");
    }
  });

  test("[J1-adult-levels-lifecycle] keeps an adult READ grant read-only and outside Settings", async ({
    page,
  }) => {
    const record = E2E_LEVEL_RECORDS.find(
      (candidate) => candidate.access === "READ",
    );
    if (!record) throw new Error("READ fixture is missing");

    const { accessLevel, recordKind } = await openRecord(page, record.username);
    expect(accessLevel).toBe("view");
    expect(recordKind).toBe("shared");

    const banner = page.locator('[data-slot="shared-record-banner"]');
    await expect(banner).toHaveAttribute("data-access-level", "view");
    await expect(banner).toHaveAttribute("data-record-kind", "shared");
    await expect(banner).toContainText(record.username);

    await page.goto("/measurements");
    // Two gates stand between the navigation and the page: the shell's own
    // hold on `/api/auth/me`, and the route's own `PageAuthGate`. Both paint
    // a page with no header action on it, so the absence has to hang on the
    // header the button would have sat in. The hero title renders in the same
    // `PageHeader` whose `actions` slot the button fills, and only in the
    // settled branch, so it says the header really rendered without the
    // button rather than not having rendered yet.
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator('[data-tour-id="measurements-hero"]'),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator('[data-slot="measurement-add"]')).toHaveCount(0);

    await page.goto("/settings/account");
    await expect(
      page.locator('[data-slot="shared-record-unavailable"]'),
    ).toBeVisible();
    await leaveRecord(page);
  });

  test("[J1-adult-levels-lifecycle] lets an adult WRITE grant add only to the selected record", async ({
    page,
  }) => {
    const record = E2E_LEVEL_RECORDS.find(
      (candidate) => candidate.access === "WRITE",
    );
    if (!record) throw new Error("WRITE fixture is missing");

    const { accountId, accessLevel, recordKind } = await openRecord(
      page,
      record.username,
    );
    expect(accessLevel).toBe("view-and-add");
    expect(recordKind).toBe("shared");
    const banner = page.locator('[data-slot="shared-record-banner"]');
    await expect(banner).toHaveAttribute("data-account-id", accountId);
    await expect(banner).toHaveAttribute("data-access-level", "view-and-add");
    await expect(banner).toHaveAttribute("data-record-kind", "shared");

    await page.goto("/measurements");
    await expect(page.locator('[data-slot="measurement-add"]')).toBeVisible();
    const post = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/measurements",
    );
    await page.locator('[data-slot="measurement-add"]').click();
    await page.locator("#sys").fill("124");
    await page.locator("#dia").fill("78");
    await page.getByRole("button", { name: /^save$/i }).click();
    expect((await post).status()).toBeLessThan(300);

    // Read the value back THROUGH THE APP rather than with a hand-rolled
    // probe.
    //
    // The probe copied the fence headers off a live request so it would not be
    // refused — and then raced them: requests do not arrive in the order they
    // were issued, so it could pick up a context the session had already left
    // and answer 409 on a test about grant levels. Copying the app's state to
    // stand beside the app is the wrong shape; asking the app is the right one,
    // and it is also closer to what this test claims — that the reading landed
    // in the SELECTED record and is visible there.
    await page.reload();
    await expect(page.locator('[data-slot="measurement-add"]')).toBeVisible();
    await expect(page.getByText("124", { exact: false }).first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(banner).toHaveAttribute("data-account-id", accountId);

    await page.goto("/settings/account");
    await expect(
      page.locator('[data-slot="shared-record-unavailable"]'),
    ).toBeVisible();
    await leaveRecord(page);
  });

  test("[J2-manage-edits-without-settings] opens MANAGE-only generated reads without opening adult Settings", async ({
    page,
  }) => {
    const fenceHeaders = trackFenceAssertion(page);
    const record = E2E_LEVEL_RECORDS.find(
      (candidate) =>
        candidate.access === "MANAGE" && candidate.recordKind === "shared",
    );
    if (!record) throw new Error("adult MANAGE fixture is missing");

    const { accessLevel, recordKind } = await openRecord(page, record.username);
    expect(accessLevel).toBe("manage");
    expect(recordKind).toBe("shared");
    const banner = page.locator('[data-slot="shared-record-banner"]');
    await expect(banner).toHaveAttribute("data-access-level", "manage");
    await expect(banner).toHaveAttribute("data-record-kind", "shared");

    await page.goto("/");
    await expect(banner).toHaveAttribute("data-access-level", "manage");
    const generatedRead = await page.evaluate(async (headers) => {
      const response = await fetch("/api/dashboard/summary", { headers });
      return response.status;
    }, fenceHeaders());
    expect(generatedRead).toBeLessThan(300);
    await expect(
      page.locator('[data-slot="shared-record-unavailable"]'),
    ).toHaveCount(0);

    await page.goto("/settings/account");
    await expect(
      page.locator('[data-slot="shared-record-unavailable"]'),
    ).toBeVisible();
    await leaveRecord(page);
  });

  test("[J2-manage-edits-without-settings] keeps managed Settings on the active record and integrations status-only", async ({
    page,
  }) => {
    const record = E2E_LEVEL_RECORDS.find(
      (candidate) => candidate.recordKind === "managed",
    );
    if (!record) throw new Error("managed record fixture is missing");

    const { accountId, accessLevel, recordKind } = await openRecord(
      page,
      record.username,
    );
    expect(accessLevel).toBe("manage");
    expect(recordKind).toBe("managed");
    const banner = page.locator('[data-slot="shared-record-banner"]');
    await expect(banner).toHaveAttribute("data-account-id", accountId);
    await expect(banner).toHaveAttribute("data-access-level", "manage");
    await expect(banner).toHaveAttribute("data-record-kind", "managed");

    await page.goto("/settings/account");
    const profile = page.locator('[data-record-settings-family="profile"]');
    await expect(profile).toBeVisible();
    await expect(profile).toHaveAttribute("data-record-id", accountId);

    const integrationRead = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname ===
          "/api/record-settings/integrations",
    );
    await page.goto("/settings/integrations");
    const integrationResponse = await integrationRead;
    expect(integrationResponse.status()).toBeLessThan(300);
    const integrationPayload = (await integrationResponse.json()) as {
      data?: { recordId?: string };
    };
    expect(integrationPayload.data?.recordId).toBe(accountId);
    // The loading branch of this card emits the same family attribute with
    // `aria-busy="true"` on it, and a skeleton holds zero controls — so the
    // read-only claim below passes against a card that never arrived. The
    // settled card is the one that labels itself by its own title id, so the
    // locator names that instead of the family alone.
    const integrations = page.locator(
      '[data-record-settings-family="integrations"][aria-labelledby="managed-integration-status-title"]',
    );
    await expect(integrations).toBeVisible();
    await expect(integrations).toHaveAttribute("data-record-id", accountId);
    await expect(
      integrations.locator("button, input, select, textarea"),
    ).toHaveCount(0);

    await page.goBack();
    await expect(profile).toHaveAttribute("data-record-id", accountId);
    await page.goForward();
    await expect(integrations).toHaveAttribute("data-record-id", accountId);
    await expect(banner).toHaveAttribute("data-account-id", accountId);

    await leaveRecord(page);
    await page.goto("/measurements");
    await expect(banner).toHaveCount(0);
  });

  test("[J1-adult-levels-lifecycle] refuses direct ungranted routes before coach reads start", async ({
    page,
  }) => {
    await openRecord(page, "e2e-scope-measurements");
    const protectedCoachReads: string[] = [];
    const trackCoachRead = (request: { url(): string }) => {
      const path = new URL(request.url()).pathname;
      if (
        [
          "/api/insights/coach/nudge-status",
          "/api/coach/about-me/questions",
          "/api/auth/me/notification-prefs",
        ].includes(path)
      ) {
        protectedCoachReads.push(path);
      }
    };
    page.on("request", trackCoachRead);
    try {
      await page.goto("/coach");
      await expect(
        page.locator('[data-slot="shared-record-unavailable"]'),
      ).toBeVisible();
      expect(protectedCoachReads).toEqual([]);

      await page.goto("/settings/access");
      await expect(
        page.locator('[data-slot="shared-record-unavailable"]'),
      ).toBeVisible();
      expect(protectedCoachReads).toEqual([]);
    } finally {
      page.off("request", trackCoachRead);
    }
    await leaveRecord(page);
  });
});

/**
 * [J3-managed-profile-lifecycle] — the half of the release goal that had no
 * browser at all until this plan.
 *
 * The routes have shipped with integration coverage since the profile family
 * landed, and nothing under `src/components` or `src/app` called any of them.
 * These two tests are the person's side of it: an adult with no managed profile
 * creates one, finds it in the switcher, enters it, leaves it, invites a second
 * Guardian and is told — before acting rather than by a refusal afterwards —
 * that the invitation does not count until it is accepted.
 *
 * Its own session jar and its own account, because this is the only account in
 * the suite with a second factor enrolled: every route here resolves
 * `requireFreshMfa`, which refuses an unenrolled account outright.
 */
test.describe.serial("managed profile browser journey", () => {
  test.use({ storageState: GUARDIAN_STORAGE_STATE_PATH });

  const PROFILE_NAME = "E2E managed record";

  test.beforeEach(async () => {
    await clearGuardianProfiles();
    await refreshGuardianStepUp();
  });

  test.afterAll(async () => {
    await clearGuardianProfiles();
  });

  async function createProfile(page: Page): Promise<void> {
    await page.goto("/settings/access");
    const card = page.locator('[data-slot="managed-profile-card"]');
    await expect(card).toBeVisible();
    await card.locator('[data-slot="managed-profile-name"]').fill(PROFILE_NAME);
    await card.locator('[data-slot="managed-profile-create-submit"]').click();
    await expect(
      card.locator('[data-slot="managed-profile-created"]'),
    ).toBeVisible();
  }

  test("[J3-managed-profile-lifecycle] creates a record with no login and reaches it from the switcher", async ({
    page,
  }) => {
    await createProfile(page);

    // The row appears without a reload, which is the account-payload
    // invalidation doing its job rather than a lucky refetch.
    const row = page.locator('[data-slot="managed-profile-row"]');
    await expect(row).toHaveCount(1);
    const profileId = await row.getAttribute("data-managed-profile-id");
    expect(profileId).not.toBeNull();

    // The switcher lists it as a managed record. Asserted on the stable
    // attribute rather than on the label, so the copy stays free to change.
    await openSwitcher(page);
    const entry = page.locator(
      `[data-slot="account-switcher-entry"][data-account-id="${profileId}"]`,
    );
    await expect(entry).toHaveCount(1);
    await expect(entry).toHaveAttribute("data-record-kind", "managed");
    await entry.click();

    // Inside it, the banner says which kind of record this is.
    const banner = page.locator('[data-slot="shared-record-banner"]');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute("data-record-kind", "managed");
    // The WORDING, not only the attribute, and this is the one place in the
    // suite where pinning copy is the right call rather than the lazy one: the
    // claim is that the banner NAMES it as a managed record, and the attribute
    // is not what a person reads. `recordKindLabel`'s ternary chooses between
    // two sentences that mean different things, and inverting it left every
    // attribute assertion green while telling a Guardian they were inside an
    // ordinary shared record. The pure function is pinned in
    // `src/components/layout/__tests__/shared-record-banner-label.test.tsx`;
    // this line proves the rendered banner really calls it.
    await expect(
      page.locator('[data-slot="shared-record-banner-context"]'),
    ).toContainText("Managed profile");

    // And back out, with the record still on the list.
    //
    // `leaveRecord` now waits for the app's own reload to land before it
    // returns, so the `goto` below is no longer issued into that gap — see
    // `withDocumentReplacement`. The retry stays: the claim here is that the
    // record survives the round trip, not that one navigation attempt wins,
    // and a loop that has nothing left to absorb costs a single pass.
    await leaveRecord(page);
    await expect(async () => {
      await page.goto("/settings/access");
      await expect(
        page.locator(
          `[data-slot="managed-profile-row"][data-managed-profile-id="${profileId}"]`,
        ),
      ).toHaveCount(1);
    }).toPass({ timeout: 15_000 });
  });

  test("[J3-managed-profile-lifecycle] states the last-guardian floor before an invitation is accepted", async ({
    page,
  }) => {
    await createProfile(page);

    const guardians = page.locator('[data-slot="managed-profile-guardians"]');
    await expect(guardians).toBeVisible();

    // One guardian, and it is the creator: no access here can be ended, and
    // the card says so rather than offering a control that would 404.
    await expect(
      guardians.locator('[data-slot="managed-profile-guardian"]'),
    ).toHaveCount(1);
    await expect(
      guardians.locator('[data-slot="managed-profile-guardian-remove"]'),
    ).toHaveCount(0);
    await expect(
      guardians.locator('[data-slot="managed-profile-sole-guardian"]'),
    ).toBeVisible();

    // Invite a second guardian.
    await guardians
      .locator('[data-slot="managed-profile-guardian-identifier"]')
      .fill(E2E_SCOPE_DELEGATE.username);
    await guardians
      .locator('[data-slot="managed-profile-guardian-submit"]')
      .click();
    await expect(
      guardians.locator('[data-slot="managed-profile-guardian-invited"]'),
    ).toBeVisible();

    // The roster shows them, and shows them as PENDING — which is the release
    // goal's sentence in the only form a browser can falsify: the invitation
    // reached the server, came back as a grant that confers nothing yet, and
    // the panel says which of the two states it is in. Delete the invitation
    // feature and this line goes red.
    await expect(
      guardians.locator(
        '[data-slot="managed-profile-guardian"][data-guardian-state="PENDING"]',
      ),
    ).toHaveCount(1);

    // And the floor is unchanged BECAUSE of that state: the sole-guardian
    // sentence is still on screen with a second person already invited.
    //
    // The `managed-profile-pending-note` line that used to sit here was
    // removed rather than kept. That node renders unconditionally inside the
    // invite form, so the assertion passed with the invitation feature deleted
    // — it proved the copy exists, which is a claim about a string and not
    // about anything the journey did. The note's own leg lives in
    // `managed-profile-affordances.test.tsx`, where deleting the node makes it
    // fail; here it would only have been a second look at the same string.
    await expect(
      guardians.locator('[data-slot="managed-profile-sole-guardian"]'),
    ).toBeVisible();
  });
});
