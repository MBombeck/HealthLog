/**
 * Notification preferences → dispatch decision, the web arm — one journey.
 *
 * The flow this file is checked against, in one script:
 *
 *   1. an account configures two delivery channels on the settings surface —
 *      email switched ON with a recipient, ntfy saved with a public relay and
 *      left OFF;
 *   2. it pairs a phone, so the APNs arm exists in the cascade;
 *   3. a medication whose dose window closed hours ago is created through the
 *      page's own fetch, and the reminder sweep the admin panel drives runs;
 *   4. the dispatch decision is read back off the account's own delivery
 *      ledger: one email attempt, delivered; nothing for the channel that is
 *      switched off; the APNs arm attempted and skipped with its reason;
 *   5. the account then opts into client-managed medication reminders — the
 *      iOS contract — and the same sweep skips the APNs arm for THAT reason
 *      while email still delivers, which is the whole claim of the opt-in.
 *
 * Refusing controls: a channel switched off is never attempted and its own
 * test control is inert; and an ntfy relay URL inside a private range is
 * refused by the save, leaves the stored config untouched, and writes no
 * delivery attempt.
 *
 * Why email is the channel that gets exercised for real, and why nothing else
 * could be: every account-supplied delivery target crosses the SSRF floor
 * (`isPublicUrl` at save time, `safeFetch({ requirePublicHost: true })` with a
 * connect-time address pin at send time), so ntfy, the generic webhook and Web
 * Push all refuse a local stub by design; Telegram and APNs address hard-coded
 * third parties. Email's transport is OPERATOR configuration, so it never
 * crosses that floor — see `e2e/setup/smtp-stub.ts`. The APNs arm therefore
 * cannot deliver here, and the journey does not pretend it can: what it proves
 * about APNs is the DECISION, read from the reason the ledger carries.
 *
 * Every assertion addresses a stable attribute — `data-slot`, `data-state`,
 * a form-control id — or the account's own API responses, never rendered copy:
 * the labels are i18n-driven and this account renders them in English only by
 * cookie.
 */
import type { Page } from "@playwright/test";

import { NOTIFY_STORAGE_STATE_PATH } from "./setup/global-setup";
import { resetNotificationFixture } from "./setup/notification-fixture";
import { startSmtpStub, type SmtpStub } from "./setup/smtp-stub";
import { expect, test } from "./setup/test";

/** The panel has finished its read and the channel cards are mounted. */
const CHANNELS_PANEL = '[data-slot="notification-channels-panel"]';

/** Where the account's email notifications are addressed. */
const EMAIL_RECIPIENT = "notification-journey@healthlog.test";

/**
 * A public relay hostname for the channel that stays switched OFF. It is
 * never dialled — the dispatcher drops a disabled channel before any I/O, and
 * that is precisely the verdict this journey wants — but it has to pass
 * `isPublicUrl` for the save to succeed at all.
 */
const NTFY_SERVER = "https://ntfy.example.com";
const NTFY_TOPIC = "healthlog-e2e-notify";

/** RFC1918. The save refuses it; the refusal is the point. */
const PRIVATE_NTFY_SERVER = "http://192.168.31.7";

/**
 * A 64-character hex APNs token. Hex only — the registration route refuses
 * anything else — and this spec's alone, because a token belongs to exactly
 * one account and re-registering it under another is a 409.
 */
const APNS_TOKEN = `e2e0d15c0de${"0".repeat(53)}`;

/** The medication whose window has closed, so the sweep has something to send. */
const MEDICATION_NAME = "E2E Notification Journey";

interface PushAttempt {
  channel: string;
  eventType: string;
  result: string;
  reason: string | null;
}

interface DiagnosticPayload {
  notificationChannels: Array<{
    type: string;
    enabled: boolean;
    configPresent: boolean;
  }>;
  recentPushAttempts: PushAttempt[];
}

/**
 * Every fetch below rides the PAGE's own `fetch` rather than a shared
 * Playwright request context: a pooled context can hand a POST to a keep-alive
 * socket the server has already closed, and the retry lands as a second write.
 * It also means the cookie, the origin and the CSRF posture are the browser's,
 * which is the arm this journey is about.
 */
async function fromPage<T>(
  page: Page,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; data: T | null }> {
  return page.evaluate(
    async (call: { path: string; method: string; body: string | null }) => {
      const res = await fetch(call.path, {
        method: call.method,
        credentials: "include",
        ...(call.body === null
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: call.body,
            }),
      });
      const envelope = (await res.json()) as { data: unknown };
      return { status: res.status, data: envelope.data };
    },
    {
      path,
      method: init.method ?? "GET",
      body: init.body === undefined ? null : JSON.stringify(init.body),
    },
  ) as Promise<{ status: number; data: T | null }>;
}

/** The admin notification diagnostic — channels and the trailing ledger. */
async function readDiagnostic(page: Page): Promise<DiagnosticPayload> {
  const res = await fromPage<DiagnosticPayload>(
    page,
    "/api/admin/notifications/diagnostic",
  );
  expect(res.status, "the diagnostic answered the admin cookie").toBe(200);
  if (!res.data) throw new Error("diagnostic returned no data");
  return res.data;
}

/**
 * The delivery attempts written since `before` rows existed.
 *
 * The ledger only ever grows and the diagnostic returns it newest-first, so
 * the head of the list is exactly what this dispatch produced. The wait is a
 * poll rather than a sleep because the ledger write is fire-and-forget: the
 * trigger's response can return before the row lands.
 *
 * `expected` is asserted, not merely awaited — an EXTRA attempt is the failure
 * this journey exists to catch (a channel that was switched off delivering
 * anyway), and a poll that stops at "at least" would never see it.
 */
async function attemptsSince(
  page: Page,
  before: number,
  expected: number,
): Promise<PushAttempt[]> {
  await expect
    .poll(async () => (await readDiagnostic(page)).recentPushAttempts.length, {
      message: `the dispatch wrote ${expected} delivery attempt(s)`,
      timeout: 20_000,
    })
    .toBe(before + expected);

  const all = (await readDiagnostic(page)).recentPushAttempts;
  expect(
    all.length,
    "no further attempt arrived after the ledger settled",
  ).toBe(before + expected);
  return all.slice(0, expected);
}

/** How many attempts the ledger already holds. */
async function attemptCount(page: Page): Promise<number> {
  return (await readDiagnostic(page)).recentPushAttempts.length;
}

/**
 * Open the delivery-channels surface and wait until each card has taken its
 * seed from the server.
 *
 * The wait is not cosmetic. Both cards mount BEFORE their query resolves and
 * then copy the server's value into the input once it arrives — the React
 * sync-from-server shape, no effect involved. A value typed into the input
 * before that copy runs is silently replaced by the server's, so the save that
 * follows persists an empty field and the next request is refused for a reason
 * that points nowhere near the test. Waiting for the two reads is what makes
 * the copy already done rather than pending.
 */
async function openChannels(page: Page): Promise<void> {
  const seeded = ["/api/settings/email", "/api/settings/ntfy"].map((endpoint) =>
    page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === endpoint &&
        res.request().method() === "GET",
    ),
  );
  await page.goto("/settings/integrations", { waitUntil: "domcontentloaded" });
  await expect(page.locator(CHANNELS_PANEL)).toBeVisible({ timeout: 30_000 });
  await Promise.all(seeded);
}

/**
 * Type into a channel card's field and confirm the field kept it. The
 * confirmation is the second half of the seed race described on
 * `openChannels`: the read has landed, so nothing is left to overwrite it.
 */
async function fillField(
  page: Page,
  selector: string,
  value: string,
): Promise<void> {
  await page.locator(selector).fill(value);
  await expect(page.locator(selector)).toHaveValue(value);
}

/**
 * Save one channel card's form and hand back the status the settings route
 * answered with. Gated on the card's own PUT rather than on a repaint, so a
 * refusal is read from the wire instead of inferred from what did not change.
 */
async function saveCard(
  page: Page,
  anchor: string,
  endpoint: string,
): Promise<number> {
  const settled = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === endpoint &&
      res.request().method() === "PUT",
  );
  await page
    .locator(
      `${anchor} [data-slot="settings-card-actions"] button[type=submit]`,
    )
    .click();
  return (await settled).status();
}

/** Flip a channel card's enable switch and wait for the route to answer. */
async function toggleCard(
  page: Page,
  switchId: string,
  endpoint: string,
): Promise<number> {
  const settled = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === endpoint &&
      res.request().method() === "PUT",
  );
  await page.locator(switchId).click();
  return (await settled).status();
}

/**
 * Configure both channels the way a person would: email on with a recipient,
 * ntfy saved and left off. Everything here happens on the settings surface.
 */
async function configureChannels(page: Page): Promise<void> {
  await openChannels(page);

  await fillField(page, "#email-recipient", EMAIL_RECIPIENT);
  expect(await saveCard(page, "#email", "/api/settings/email")).toBe(200);
  expect(await toggleCard(page, "#email-toggle", "/api/settings/email")).toBe(
    200,
  );
  await expect(page.locator("#email-toggle")).toHaveAttribute(
    "data-state",
    "checked",
  );

  await fillField(page, "#ntfy-server", NTFY_SERVER);
  await fillField(page, "#ntfy-topic", NTFY_TOPIC);
  expect(await saveCard(page, "#ntfy", "/api/settings/ntfy")).toBe(200);
  await expect(page.locator("#ntfy-toggle")).toHaveAttribute(
    "data-state",
    "unchecked",
  );
}

/**
 * Pair a phone through the device-registration route the native client uses.
 * That registration — and nothing else in the product — is what puts an APNS
 * row in the cascade, so the arm the client-managed opt-in suppresses only
 * exists once this has run.
 */
async function pairPhone(page: Page): Promise<void> {
  const res = await fromPage(page, "/api/devices", {
    method: "POST",
    body: {
      token: APNS_TOKEN,
      bundleId: "dev.healthlog.e2e",
      apnsToken: APNS_TOKEN,
      apnsEnvironment: "sandbox",
    },
  });
  expect(res.status, "the phone registered").toBe(201);
}

/**
 * Pin the account's timezone so its local clock reads midday.
 *
 * The sweep classifies a dose window against the account's OWN wall clock, so
 * a window written as a fixed pair of times is overdue for most of the day and
 * not yet open around midnight. Rather than leave a spec that is honest 1439
 * minutes out of 1440, the account sets the one preference that decides which
 * clock is consulted — through its own profile route, the same PATCH the
 * profile form sends — to a whole-hour zone where "now" is early afternoon.
 * The morning window below is then unambiguously closed, every run.
 */
async function pinAccountClockToMidday(page: Page): Promise<void> {
  const wrapped = (12 - new Date().getUTCHours() + 24) % 24;
  const offsetHours = wrapped > 12 ? wrapped - 24 : wrapped;
  // `Etc/GMT-5` is UTC+5 — the POSIX sign convention is inverted, which is
  // why the zone name is built rather than looked up.
  const zone =
    offsetHours === 0
      ? "Etc/GMT"
      : offsetHours > 0
        ? `Etc/GMT-${offsetHours}`
        : `Etc/GMT+${-offsetHours}`;

  const res = await fromPage<{ timezone: string }>(page, "/api/user/profile", {
    method: "PATCH",
    body: { timezone: zone },
  });
  expect(res.status, "the profile accepted the timezone").toBe(200);
  expect(res.data?.timezone).toBe(zone);
}

/**
 * A medication with a morning window and reminders on. With the account's
 * clock pinned to early afternoon the window is hours closed, which is the
 * state the sweep dispatches for.
 */
async function createOverdueMedication(page: Page): Promise<string> {
  const res = await fromPage<{ id: string }>(page, "/api/medications", {
    method: "POST",
    body: {
      name: MEDICATION_NAME,
      dose: "1 tablet",
      notificationsEnabled: true,
      schedules: [{ windowStart: "08:00", windowEnd: "09:00" }],
    },
  });
  expect(res.status, "the medication was created").toBe(201);
  const id = res.data?.id;
  expect(id, "the create returned an id").toBeTruthy();
  return id as string;
}

interface SweepResult {
  medications: Array<{
    name: string;
    schedules: Array<{ notificationSent: boolean }>;
  }>;
}

/**
 * Run the reminder sweep the admin notifications panel drives. This is the
 * product's own trigger for the medication-reminder dispatch, and it goes
 * through `dispatchNotification` — the cascade, the per-channel preference
 * read and the client-managed gate — rather than calling a sender directly.
 */
async function runReminderSweep(page: Page): Promise<void> {
  const res = await fromPage<SweepResult>(
    page,
    "/api/admin/notifications/reminder-check",
    { method: "POST" },
  );
  expect(res.status, "the sweep ran").toBe(200);
  const mine = res.data?.medications.find((m) => m.name === MEDICATION_NAME);
  expect(mine, "the sweep saw this account's overdue medication").toBeTruthy();
  expect(
    mine?.schedules.some((s) => s.notificationSent),
    "the sweep dispatched for the closed window",
  ).toBe(true);
}

/** Look one channel's attempt out of a dispatch's rows. */
function attemptFor(
  attempts: PushAttempt[],
  channel: string,
): PushAttempt | undefined {
  return attempts.find((a) => a.channel === channel);
}

test.describe("notification preferences drive the dispatch decision", () => {
  test.use({ storageState: NOTIFY_STORAGE_STATE_PATH });

  /**
   * Serial, because every test configures the one account's channels and then
   * counts rows in its ledger. Two of these in flight would be counting each
   * other's deliveries.
   */
  test.describe.configure({ mode: "serial" });

  /**
   * The sweep walks every active medication on the instance and the ledger
   * write that follows is fire-and-forget, so the budget covers a loaded
   * runner rather than the 30 s default.
   */
  test.setTimeout(120_000);

  let smtp: SmtpStub;

  test.beforeAll(async () => {
    smtp = await startSmtpStub();
  });

  test.afterAll(async () => {
    await smtp.close();
  });

  test.beforeEach(async () => {
    await resetNotificationFixture();
    smtp.reset();
  });

  test("the card's own test control delivers on the enabled channel only", async ({
    page,
  }) => {
    await configureChannels(page);

    // The diagnostic agrees with the surface about which channel is on. Both
    // reads are the account's own; neither is the switch it just clicked.
    const channels = (await readDiagnostic(page)).notificationChannels;
    expect(
      channels.find((c) => c.type === "EMAIL"),
      "the email channel is configured and on",
    ).toMatchObject({ enabled: true, configPresent: true });
    expect(
      channels.find((c) => c.type === "NTFY"),
      "the ntfy channel is configured and off",
    ).toMatchObject({ enabled: false, configPresent: true });

    // A channel that is off offers no way to probe it — the refusal is on the
    // surface, before any request is made.
    await expect(
      page.locator(
        '#ntfy [data-slot="settings-card-actions"] button[type=button]',
      ),
    ).toBeDisabled();

    const before = await attemptCount(page);
    const probe = page.waitForResponse(
      (res) => new URL(res.url()).pathname === "/api/settings/email/test",
    );
    await page
      .locator('#email [data-slot="settings-card-actions"] button[type=button]')
      .click();
    expect((await probe).status(), "the probe reached the transport").toBe(200);

    const attempts = await attemptsSince(page, before, 1);
    expect(attempts[0]).toMatchObject({
      channel: "EMAIL",
      result: "ok",
      reason: null,
    });

    // And the transport is a real one: the message left the process and was
    // accepted for the address the settings surface saved.
    expect(smtp.accepted()).toEqual([EMAIL_RECIPIENT]);
  });

  test("a due reminder delivers on the enabled channel and skips the rest", async ({
    page,
  }) => {
    await configureChannels(page);
    await pairPhone(page);
    await pinAccountClockToMidday(page);
    await createOverdueMedication(page);

    const before = await attemptCount(page);
    await runReminderSweep(page);

    // Two arms, and exactly two: the paired phone and the enabled email
    // channel. A third row would mean the switched-off relay was dialled.
    const attempts = await attemptsSince(page, before, 2);
    expect(
      attempts.map((a) => a.channel).sort(),
      "only the channels in the cascade were attempted",
    ).toEqual(["APNS", "EMAIL"]);

    expect(attemptFor(attempts, "EMAIL")).toMatchObject({
      eventType: "MEDICATION_REMINDER",
      result: "ok",
      reason: null,
    });
    expect(smtp.accepted()).toEqual([EMAIL_RECIPIENT]);

    // The APNs arm was reached and refused by the TRANSPORT, not by a
    // preference — this instance has no APNs credentials. That distinction is
    // the baseline the next test moves.
    expect(attemptFor(attempts, "APNS")).toMatchObject({
      eventType: "MEDICATION_REMINDER",
      result: "skipped",
      reason: "apns_not_configured",
    });
  });

  test("the client-managed opt-in suppresses the APNs arm and nothing else", async ({
    page,
  }) => {
    await configureChannels(page);
    await pairPhone(page);
    await pinAccountClockToMidday(page);
    await createOverdueMedication(page);

    // The opt-in the native client sets when it owns the local reminder.
    const patched = await fromPage<{ medication: { clientManaged: boolean } }>(
      page,
      "/api/auth/me/notification-prefs",
      { method: "PATCH", body: { medication: { clientManaged: true } } },
    );
    expect(patched.status, "the preference was accepted").toBe(200);
    expect(patched.data?.medication.clientManaged).toBe(true);

    // Read back through the account's own resolved preferences, not through
    // the value just echoed: the deep-merge is what the dispatcher consults.
    const resolved = await fromPage<{ medication: { clientManaged: boolean } }>(
      page,
      "/api/auth/me/notification-prefs",
    );
    expect(resolved.data?.medication.clientManaged).toBe(true);

    const before = await attemptCount(page);
    await runReminderSweep(page);

    const attempts = await attemptsSince(page, before, 2);

    // Suppressed BEFORE the sender: the reason is the gate's, not the
    // transport's. Same instance, same missing credentials as the previous
    // test — only the preference moved, and the ledger says so.
    expect(attemptFor(attempts, "APNS")).toMatchObject({
      result: "skipped",
      reason: "client_managed",
    });

    // "The APNs leg only" is the published contract, so email still has to
    // deliver. An opt-in that silenced the whole dispatch would pass every
    // APNs assertion above and be the bug.
    expect(attemptFor(attempts, "EMAIL")).toMatchObject({
      eventType: "MEDICATION_REMINDER",
      result: "ok",
      reason: null,
    });
    expect(smtp.accepted()).toEqual([EMAIL_RECIPIENT]);
  });

  /**
   * The web reflection of the opt-in, and the reason it is a test rather than a
   * screenshot: the section reads `notificationPrefs.medication.clientManaged`
   * off `/api/auth/me`, and that payload did not publish it until this branch.
   * The flag was `undefined` for every account, so the chip never rendered and
   * a person whose phone owned the reminders was shown a server-side switch
   * that decided nothing. Both halves are asserted — the chip appears AND the
   * switch row is gone — because either one alone passes on the wrong render.
   */
  test("the client-managed opt-in is visible on the medication it silences", async ({
    page,
  }) => {
    await configureChannels(page);
    await pinAccountClockToMidday(page);
    const medicationId = await createOverdueMedication(page);

    const patched = await fromPage(page, "/api/auth/me/notification-prefs", {
      method: "PATCH",
      body: { medication: { clientManaged: true } },
    });
    expect(patched.status).toBe(200);

    await page.goto(`/medications/${medicationId}`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator('[data-slot="medication-tab-zeitplan"]').click();
    await expect(
      page.locator('[data-slot="notifications-client-managed-chip"]'),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator('[data-slot="notifications-switch-row"]'),
    ).toHaveCount(0);
  });

  test("a relay URL inside a private range is refused and delivers nothing", async ({
    page,
  }) => {
    await configureChannels(page);

    const before = await attemptCount(page);
    await fillField(page, "#ntfy-server", PRIVATE_NTFY_SERVER);
    expect(
      await saveCard(page, "#ntfy", "/api/settings/ntfy"),
      "the save refused the private host",
    ).toBe(422);

    // A refusal that still wrote something would be worse than no refusal:
    // the stored relay is the one the account saved before.
    const stored = await fromPage<{ serverUrl: string; enabled: boolean }>(
      page,
      "/api/settings/ntfy",
    );
    expect(stored.status).toBe(200);
    expect(stored.data).toMatchObject({
      serverUrl: NTFY_SERVER,
      enabled: false,
    });

    // And nothing was dispatched on the way to being refused.
    expect(await attemptCount(page)).toBe(before);
    expect(smtp.accepted()).toEqual([]);
  });
});
