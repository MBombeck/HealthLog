/**
 * Structural guard: a push service's "gone" verdict deletes a registration
 * only through the breaker (`lib/notifications/gone-registrations.ts`).
 *
 * A wrong APNs topic or bundle id makes Apple call every device token gone.
 * Every path that took the verdict at its word deleted the rows it was handed,
 * so a configuration slip emptied the device table one push at a time. The
 * breaker holds deletions once too many registrations go at once; it only
 * works if no verdict reaches a delete around it. So:
 *
 * 1. The files that delete a push registration (a device row, a Live Activity
 *    token, a Web Push subscription, a device's push-to-start token, a Wallet
 *    pass registration) are a
 *    closed list, each with the reason it deletes. A new one fails here and
 *    has to say whether it acts on a verdict.
 * 2. Every file that reads a gone verdict (`shouldDisable`, a relay
 *    `unregistered` / `activity_gone`, `Unregistered`, a 410) hands it to
 *    `forgetGoneRegistrations`, or is listed as a reader that deletes nothing.
 *
 * Limits, stated plainly. The matchers are textual and whitespace-tolerant; a
 * delete spelt as raw SQL, or through a delegate held in a variable, is
 * invisible to them. Every matcher asserts a non-zero match count, so a
 * matcher that stopped matching fails rather than passes. The behaviour is
 * proven in `tests/integration/push-gone-breaker.test.ts`.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

const REGISTRATION_DELETE =
  /\b(?:device|liveActivityToken|pushSubscription|walletPassRegistration)\s*\.\s*delete(?:Many)?\s*\(|\bdeleteDeviceRows(?:In)?\s*\(|\bdeviceDeleteWrites\s*\(|\bliveActivityPushToken\s*:\s*null\b/;
const GONE_VERDICT =
  /\bshouldDisable\b|\bactivityGone\b|["']Unregistered["']|["']unregistered["']|\bactivity_gone\b|===\s*410\b/;
const BREAKER = /\bforgetGoneRegistrations\s*\(/;

const BREAKER_MODULE = "lib/notifications/gone-registrations.ts";

/** Every file that deletes a push registration, and why. */
const DELETERS: Record<string, string> = {
  [BREAKER_MODULE]: "the breaker: every gone verdict deletes here",
  "lib/devices/delete-devices.ts":
    "the device-row seam with its relay unbind; the breaker calls it",
  "lib/devices/revoke.ts": "session revoke takes the session's device",
  "lib/devices/signed-out-push.ts": "sign-out drops the device's push state",
  "app/api/devices/route.ts":
    "device registration: takeover, duplicate install, unregister",
  "app/api/notifications/web-push/route.ts":
    "the browser unsubscribes its own subscription",
  "lib/export/notification-channels-backup.ts":
    "a restore replaces the channels it restores",
  "lib/notifications/live-activity-answered.ts":
    "an ended Activity's token addresses nothing; an end answered gone ended it too",
  "lib/push-relay/live-activity-relay-end.ts":
    "an Activity the relay ended or found gone on its end; update verdicts go through the breaker in live-activity.ts",
  "lib/push-relay/live-activity-report.ts":
    "the app's posted set of Activities replaces the stored one",
  "lib/emergency-card/wallet-pass/web-service.ts":
    "Wallet unregisters a device, or a new registration replaces the oldest past the cap",
};

/** Files that read a gone verdict and delete nothing themselves, and why. */
const VERDICT_READERS: Record<string, string> = {
  "lib/notifications/retry-policy.ts": "classifies a 410 for the retry policy",
  "lib/notifications/test-delivery-failure.ts":
    "explains a failed test push to the user",
  "lib/notifications/live-activity-end.ts":
    "an end answered gone counts as ended; the Activity is over either way",
  "lib/push-relay/medication-pushes.ts":
    "an end answered activity_gone counts as ended",
  "lib/notifications/senders/apns-token-gone.ts":
    "the one reading of an APNs refusal; its callers act on it",
  "lib/emergency-card/wallet-pass/push-local.ts":
    "classifies Apple's answer to a Wallet push for push.ts",
  "lib/push-relay/wallet.ts": "reads the relay's answer to a Wallet push",
};

function code(file: string): string {
  return stripComments(readSourceText(join(SRC, file)));
}

const files = walkSourceFiles(SRC, { floor: 3000 }).filter(
  (file) => !/__tests__|\.test\.|^generated\//.test(file),
);
const deleters = files.filter((file) => REGISTRATION_DELETE.test(code(file)));
const readers = files.filter((file) => GONE_VERDICT.test(code(file)));

describe("push registrations go through the breaker on a gone verdict", () => {
  it("deletes push registrations only in the listed files", () => {
    expect(deleters.length).toBeGreaterThanOrEqual(5);
    expect([...deleters].sort()).toEqual(Object.keys(DELETERS).sort());
  });

  it("hands every gone verdict to the breaker", () => {
    // APNs alert + silent, the relay's direct and batched answers, Web Push.
    const viaBreaker = readers.filter((file) => BREAKER.test(code(file)));
    expect(viaBreaker.length).toBeGreaterThanOrEqual(5);
    expect(
      readers.filter(
        (file) => !BREAKER.test(code(file)) && !(file in VERDICT_READERS),
      ),
    ).toEqual([]);
  });

  it("lets no listed verdict reader delete a registration", () => {
    expect(
      Object.keys(VERDICT_READERS).filter((file) => deleters.includes(file)),
    ).toEqual([]);
  });

  it("lists no reader that no longer reads a verdict", () => {
    expect(
      Object.keys(VERDICT_READERS).filter((file) => !readers.includes(file)),
    ).toEqual([]);
  });

  it("keeps the delete calls of the breaker behind its own check", () => {
    const breaker = code(BREAKER_MODULE);
    expect(breaker).toMatch(/\badmitGone\s*\(/);
    expect(breaker).toMatch(REGISTRATION_DELETE);
  });
});
