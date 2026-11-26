import { describe, expect, it } from "vitest";

import { dropInvalidLiveActivityFields } from "../live-activity-fields";
import type { IgnoredDeviceField } from "@/lib/push-relay/device-registration";

const start = (token: string) => ({
  token,
  statement: {
    instanceId: "0b5f3d4e-1c2a-4b6d-8e9f-0a1b2c3d4e5f",
    tokenTag: "0".repeat(32),
    laTokenTag: "1".repeat(32),
    iat: 1_800_000_000,
  },
  signature: "A".repeat(86),
});

function drop(body: Record<string, unknown>) {
  const ignored: IgnoredDeviceField[] = [];
  const out = dropInvalidLiveActivityFields(body, ignored) as Record<
    string,
    unknown
  >;
  return { out, ignored };
}

describe("dropInvalidLiveActivityFields", () => {
  it("keeps tokens of 256 and 512 hex characters", () => {
    const body = {
      token: "device",
      liveActivityPushToken: "cd".repeat(256),
      liveActivityStart: start("ef".repeat(128)),
      liveActivityTokens: [{ token: "12".repeat(128), medicationId: "m" }],
    };
    const { out, ignored } = drop(body);
    expect(ignored).toEqual([]);
    expect(out).toEqual(body);
  });

  it("leaves out only the fields it cannot take, and names each", () => {
    const { out, ignored } = drop({
      token: "device",
      apnsToken: "ab".repeat(32),
      liveActivityPushToken: "not hex",
      liveActivityStart: start("ef".repeat(300)),
      liveActivityTokens: [
        { token: "12".repeat(32), medicationId: "m1" },
        { token: "zz", medicationId: "m2" },
      ],
    });
    expect(ignored.map((f) => f.field)).toEqual([
      "liveActivityPushToken",
      "liveActivityStart",
      "liveActivityTokens[1]",
    ]);
    expect(
      ignored.every((f) => f.code === "devices.register.invalid_field"),
    ).toBe(true);
    expect(out).toEqual({
      token: "device",
      apnsToken: "ab".repeat(32),
      liveActivityTokens: [{ token: "12".repeat(32), medicationId: "m1" }],
    });
  });

  it("leaves a list longer than 8 out whole, and keeps null clears", () => {
    const { out, ignored } = drop({
      liveActivityPushToken: null,
      liveActivityStart: null,
      liveActivityTokens: Array.from({ length: 9 }, () => ({
        token: "12".repeat(32),
        medicationId: "m",
      })),
    });
    expect(ignored.map((f) => f.field)).toEqual(["liveActivityTokens"]);
    expect(out).toEqual({
      liveActivityPushToken: null,
      liveActivityStart: null,
    });
  });
});
