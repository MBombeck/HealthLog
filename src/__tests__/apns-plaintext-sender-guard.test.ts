/**
 * Only the APNs channel calls the plaintext APNs sender.
 *
 * `sendViaApns` sends the alert text in the clear over this server's own
 * APNs key. A device with a push key must get its alerts sealed, over the
 * server's key or over the relay, and the one place that decides which device
 * gets which is `sendApnsChannel` (`src/lib/push-relay/apns-channel.ts`).
 * The two test pushes called the plaintext sender directly and so sent their
 * text in the clear to devices that should only ever get sealed pushes.
 *
 * Every other caller goes through the channel. The sweep reads code with
 * comments stripped, skips tests and mocks, and asserts a floor so a matcher
 * that finds nothing fails.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { scanSourceMatches } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** The sender's own module and the channel in front of it. */
const ALLOWED = [
  "lib/notifications/senders/apns.ts",
  "lib/push-relay/apns-channel.ts",
];

describe("the plaintext APNs sender", () => {
  it("is called only by the APNs channel", () => {
    const matches = scanSourceMatches(SRC, /\bsendViaApns\b/g, {
      fileFloor: 1500,
      matchFloor: 3,
      stripComments: true,
      include: (rel) =>
        !rel.includes("/__tests__/") &&
        !rel.includes("/__mocks__/") &&
        !/\.test\.tsx?$/.test(rel),
    });
    const files = [...new Set(matches.map((m) => m.file))].sort();
    expect(files).toEqual(ALLOWED);
  });
});
