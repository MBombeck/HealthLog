/**
 * The admin notification test toast names each failing channel's cause
 * (review L5): the code the route sends is translated and the status is
 * shown, so the per-channel fields in the response have a reader.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { describeChannelTestFailures } from "../notification-test-failures";

const MESSAGES: Record<string, string> = {
  "settings.testConnection.errors.upstream_rejected":
    "The other end refused the message",
  "settings.testConnection.errors.credentials_rejected": "Credentials rejected",
  "admin.notificationTestFailed": "Failed to send test notification",
};
const t = (key: string) => MESSAGES[key] ?? key;

describe("describeChannelTestFailures", () => {
  it("lists only failing channels, with the translated cause and the status", () => {
    expect(
      describeChannelTestFailures(
        [
          { channel: "APNS", success: true },
          {
            channel: "WEBHOOK",
            success: false,
            error: "The webhook answered HTTP 400.",
            errorCode: "upstream_rejected",
            upstreamStatus: 400,
          },
          {
            channel: "EMAIL",
            success: false,
            error: "The mail server rejected the credentials (SMTP 535).",
            errorCode: "credentials_rejected",
            smtpCode: 535,
          },
        ],
        t,
      ),
    ).toEqual([
      "Webhook: The other end refused the message (HTTP 400)",
      "Email: Credentials rejected (SMTP 535)",
    ]);
  });

  it("falls back to the route's sentence when there is no known code", () => {
    expect(
      describeChannelTestFailures(
        [
          {
            channel: "NTFY",
            success: false,
            error: "SYSTEM_ALERT disabled in settings",
          },
          { channel: "MYSTERY", success: false, errorCode: "unlisted" },
        ],
        t,
      ),
    ).toEqual([
      "ntfy: SYSTEM_ALERT disabled in settings",
      "MYSTERY: Failed to send test notification",
    ]);
  });

  it("is what the admin toast renders", () => {
    const src = readFileSync(
      join(process.cwd(), "src/components/admin/notification-health-card.tsx"),
      "utf8",
    );
    expect(src).toMatch(/describeChannelTestFailures\(data\?\.results/);
    expect(src).toMatch(/description:/);
  });
});
