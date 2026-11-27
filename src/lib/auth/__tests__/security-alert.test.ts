import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchNotification = vi.fn();
const findUnique = vi.fn();

vi.mock("@/lib/notifications/dispatcher", () => ({
  dispatchNotification: (...args: unknown[]) => dispatchNotification(...args),
}));
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}));

vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: async () => "Europe/Berlin",
}));

import { sendSecurityAlert } from "@/lib/auth/security-alert";

describe("sendSecurityAlert", () => {
  beforeEach(() => {
    dispatchNotification.mockReset();
    dispatchNotification.mockResolvedValue({ dispatched: true });
    findUnique.mockReset();
    findUnique.mockResolvedValue({ locale: "de" });
  });

  it.each([
    ["passkey_added", "Passkey hinzugefügt"],
    ["passkey_removed", "Passkey entfernt"],
    ["token_revoked", "Zugriffstoken widerrufen"],
    ["refresh_reuse", "Ein Gerät wurde abgemeldet"],
    ["device_reassigned", "Ein Gerät gehört jetzt zu einem anderen Konto"],
  ] as const)(
    "sends %s as an urgent SECURITY_ALERT in the account's locale",
    async (kind, title) => {
      await expect(sendSecurityAlert("u1", kind)).resolves.toBe(true);
      expect(dispatchNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "SECURITY_ALERT",
          userId: "u1",
          title,
          urgent: true,
          metadata: { securityKind: kind },
        }),
      );
      const message = dispatchNotification.mock.calls[0]![0].message;
      expect(message).not.toMatch(/notifications\.security/);
    },
  );

  it("fills the new-device placeholders", async () => {
    findUnique.mockResolvedValue({ locale: "en" });
    await sendSecurityAlert("u1", "new_device", {
      device: "Safari on macOS",
      location: "Berlin",
    });
    expect(dispatchNotification.mock.calls[0]![0].message).toContain(
      "Safari on macOS (Berlin)",
    );
  });

  it("writes the due date of a second factor in the account's language and zone", async () => {
    // 23:30 UTC on the 9th is already the 10th in Berlin.
    await sendSecurityAlert(
      "u1",
      "mfa_due",
      {},
      new Date("2026-12-09T23:30:00Z"),
    );
    const sent = dispatchNotification.mock.calls[0]![0];
    expect(sent.title).toBe("Zweiter Anmeldefaktor nötig");
    expect(sent.message).toContain("10. Dezember 2026");
    expect(sent.metadata).toEqual({ securityKind: "mfa_due" });
  });

  it("is settled when no channel wants it, unsettled when every channel failed", async () => {
    dispatchNotification.mockResolvedValueOnce({
      dispatched: false,
      channelsAttempted: 0,
    });
    await expect(sendSecurityAlert("u1", "passkey_added")).resolves.toBe(true);
    dispatchNotification.mockResolvedValueOnce({
      dispatched: false,
      channelsAttempted: 2,
    });
    await expect(sendSecurityAlert("u1", "passkey_added")).resolves.toBe(false);
  });

  it("never throws when the dispatcher fails", async () => {
    dispatchNotification.mockRejectedValue(new Error("down"));
    await expect(sendSecurityAlert("u1", "passkey_added")).resolves.toBe(false);
  });
});
