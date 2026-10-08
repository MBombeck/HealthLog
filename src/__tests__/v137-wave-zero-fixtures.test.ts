import { describe, expect, it } from "vitest";

import {
  ADMITTED_MUTATING_HANDLERS,
  SHARING_DOMAINS,
} from "../../tests/fixtures/v137/sharing-matrix";
import { SECURITY_PRINCIPALS } from "../../tests/fixtures/v137/security-principals";
import { LEGACY_ACCOUNT_PAYLOADS } from "../../tests/fixtures/v137/legacy-account-payloads";
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_DELIVERY_MATRIX,
} from "../../tests/fixtures/v137/notification-matrix";

describe("sharing and handler inventories", () => {
  it("freezes the exact sharing-domain vocabulary", () => {
    expect(SHARING_DOMAINS).toEqual([
      "measurements",
      "medications",
      "labs",
      "profile",
      "illness",
      "mind",
      "cycle",
      "documents",
    ]);
  });

  it("keeps every admitted mutation uniquely addressable and fully controlled", () => {
    expect(ADMITTED_MUTATING_HANDLERS).toHaveLength(90);
    expect(
      new Set(
        ADMITTED_MUTATING_HANDLERS.map(
          ({ route, action }) => `${route}#${action}`,
        ),
      ).size,
    ).toBe(ADMITTED_MUTATING_HANDLERS.length);

    for (const handler of ADMITTED_MUTATING_HANDLERS) {
      expect(handler.ownRecord.expected).toBe("allow");
      expect(handler.deniedLevel.expected).toBe("deny");
      expect(handler.admittedLevel.expected).toBe("allow");
      expect(handler.actorAttribution.field).toBe("actorUserId");
      expect(handler.resultingEffect.expected).toBe("applied-once");
      expect(handler.encryptedFieldCarveOut).toBe(
        "never-assert-decrypted-field-content",
      );
    }
  });
});

describe("security principals and compatibility", () => {
  it("keeps actor, record, recipient, origin, grant, and job identities distinct", () => {
    const { activeDelegation, revokedDelegation } = SECURITY_PRINCIPALS;

    expect(new Set(Object.values(activeDelegation.identities)).size).toBe(3);
    expect(activeDelegation.origin).toBe("delegated-request");
    expect(activeDelegation.grant.state).toBe("active");
    expect(revokedDelegation.grant.state).toBe("revoked");
    expect(activeDelegation.job.id).not.toBe(revokedDelegation.job.id);
  });

  it("covers every guardian, profile, and delivery channel exactly once", () => {
    expect(NOTIFICATION_CHANNELS).toEqual([
      "apns",
      "web-push",
      "telegram",
      "ntfy",
    ]);
    expect(NOTIFICATION_DELIVERY_MATRIX).toHaveLength(16);
    expect(
      new Set(
        NOTIFICATION_DELIVERY_MATRIX.map(
          ({ channel, recipientUserId, recordUserId }) =>
            `${recordUserId}:${recipientUserId}:${channel}`,
        ),
      ).size,
    ).toBe(NOTIFICATION_DELIVERY_MATRIX.length);
    expect(
      NOTIFICATION_DELIVERY_MATRIX.every(
        ({ interactive, recipientUserId, recordUserId }) =>
          !interactive && String(recipientUserId) !== String(recordUserId),
      ),
    ).toBe(true);
  });

  it("retains legacy access compatibility and fails closed for scoped payloads", () => {
    expect(LEGACY_ACCOUNT_PAYLOADS.map(({ name }) => name)).toEqual([
      "whole-read",
      "whole-write",
      "manage-as-write",
      "scoped-fail-closed",
    ]);
    expect(LEGACY_ACCOUNT_PAYLOADS[2]).toMatchObject({
      access: "write",
      level: "manage",
    });
    expect(LEGACY_ACCOUNT_PAYLOADS[3]?.legacyDecoder).toBe("deny");
  });
});
