import { describe, expect, it } from "vitest";

import { readSource } from "@/__tests__/helpers/source-files";

import { apnsTokenGone } from "../apns-token-gone";

describe("apnsTokenGone", () => {
  it.each([
    [410, "Unregistered"],
    [410, "ExpiredToken"],
    [410, undefined],
    [400, "BadDeviceToken"],
    [400, "DeviceTokenNotForTopic"],
  ])("drops the token on %s %s", (status, reason) => {
    expect(apnsTokenGone(status, reason)).toBe(true);
  });

  it.each([
    [403, "InvalidProviderToken"],
    [403, "ExpiredProviderToken"],
    [403, "BadCertificate"],
    [403, "BadCertificateEnvironment"],
    [403, "Forbidden"],
    [400, "BadTopic"],
    [400, "TopicDisallowed"],
    [400, "BadPayload"],
    [413, "PayloadTooLarge"],
    [429, "TooManyRequests"],
    [429, "TooManyProviderTokenUpdates"],
    [500, "InternalServerError"],
    [503, "ServiceUnavailable"],
    [undefined, undefined],
  ])("keeps the token on %s %s", (status, reason) => {
    expect(apnsTokenGone(status, reason)).toBe(false);
  });
});

describe("one APNs classifier", () => {
  it.each([
    "src/lib/notifications/senders/apns.ts",
    "src/lib/emergency-card/wallet-pass/push-local.ts",
  ])("%s reads Apple's refusals through apnsTokenGone", (file) => {
    const source = readSource(file, "apnsTokenGone(");
    expect(source).not.toMatch(/"BadDeviceToken"|"Unregistered"/);
  });
});
