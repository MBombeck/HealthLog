/**
 * The relay's Wallet endpoints as this server calls them: the exact bodies,
 * through the one signed door (`relayCall`), and every refusal turned into
 * "unavailable, retry later" rather than an error. The response shapes are
 * checked by `parseRelayBody` before anything here reads them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const relayCall = vi.fn();
const loadRegistration = vi.fn();
vi.mock("@/lib/push-relay/registration", () => ({
  relayCall: (...args: unknown[]) => relayCall(...args),
  loadRegistration: (...args: unknown[]) => loadRegistration(...args),
}));
vi.mock("@/lib/push-relay/config", () => ({
  relayConfig: () => ({ available: true, host: "push.example.test" }),
}));

import { parseRelayBody } from "@/lib/push-relay/responses";
import {
  notifyWalletPasses,
  signManifestViaRelay,
  WALLET_NOTIFY_PATH,
  WALLET_SIGN_PATH,
} from "@/lib/push-relay/wallet";

const ROW = { id: "reg", instanceId: "inst", state: "ok" };
const MANIFEST = new TextEncoder().encode(
  '{"pass.json":"' + "a".repeat(40) + '"}',
);
const SIGNATURE = Buffer.concat([
  Buffer.from([0x30, 0x82]),
  Buffer.alloc(40, 7),
]);
const OK_BODY = {
  signature: SIGNATURE.toString("base64url"),
  passTypeIdentifier: "pass.dev.healthlog.emergency",
  teamIdentifier: "ABCDE12345",
  signerSubjectO: "HealthLog",
  certNotAfterDay: 20800,
};
const TOKEN = "ab".repeat(32);

beforeEach(() => {
  relayCall.mockReset();
  loadRegistration.mockReset();
  loadRegistration.mockResolvedValue(ROW);
});

describe("signManifestViaRelay", () => {
  it("sends the manifest bytes only, base64url, and reads the signature", async () => {
    relayCall.mockResolvedValue({
      kind: "response",
      status: 200,
      body: OK_BODY,
      retryAfter: null,
    });
    const signed = await signManifestViaRelay(MANIFEST);
    expect(relayCall).toHaveBeenCalledTimes(1);
    const [row, method, path, payload] = relayCall.mock.calls[0];
    expect(row).toBe(ROW);
    expect([method, path]).toEqual(["POST", WALLET_SIGN_PATH]);
    expect(payload).toEqual({
      v: 1,
      manifest: Buffer.from(MANIFEST).toString("base64url"),
    });
    expect(Object.keys(payload as object).sort()).toEqual(["manifest", "v"]);
    expect(signed).toMatchObject({
      ok: true,
      passTypeIdentifier: "pass.dev.healthlog.emergency",
      teamIdentifier: "ABCDE12345",
    });
    if (signed.ok) {
      expect(Buffer.from(signed.signature).equals(SIGNATURE)).toBe(true);
    }
  });

  it("turns every refusal and failure into unavailable with a wait", async () => {
    const answers = [
      [
        { kind: "transport", reason: "relay_signature_invalid" },
        "relay_signature_invalid",
        60,
      ],
      [
        {
          kind: "response",
          status: 503,
          body: { error: "wallet_unavailable", retryAfter: 120 },
          retryAfter: 120,
        },
        "relay_wallet_unavailable",
        120,
      ],
      [
        {
          kind: "response",
          status: 429,
          body: { error: "wallet_quota", retryAfter: 900 },
          retryAfter: 900,
        },
        "relay_wallet_quota",
        900,
      ],
      [
        {
          kind: "response",
          status: 403,
          body: { error: "wallet_blocked" },
          retryAfter: null,
        },
        "relay_wallet_blocked",
        60,
      ],
      [
        {
          kind: "response",
          status: 200,
          body: { ...OK_BODY, signature: "AAAAAAAAAAAAAAAAAAAAAAAA" },
          retryAfter: null,
        },
        "relay_signature_shape",
        60,
      ],
    ] as const;
    for (const [answer, reason, retryAfter] of answers) {
      relayCall.mockResolvedValueOnce(answer);
      expect(await signManifestViaRelay(MANIFEST)).toEqual({
        ok: false,
        reason,
        retryAfter,
      });
    }
  });

  it("does not call a relay this server is not registered at", async () => {
    for (const row of [
      null,
      { ...ROW, instanceId: null },
      { ...ROW, state: "suspended" },
    ]) {
      loadRegistration.mockResolvedValueOnce(row);
      expect(await signManifestViaRelay(MANIFEST)).toMatchObject({
        ok: false,
        reason: "relay_not_registered",
      });
    }
    expect(relayCall).not.toHaveBeenCalled();
  });
});

describe("notifyWalletPasses", () => {
  it("sends refs and tokens and maps each result", async () => {
    relayCall.mockResolvedValue({
      kind: "response",
      status: 200,
      body: {
        results: [
          { ref: "a", result: "accepted" },
          { ref: "b", result: "unregistered" },
          { ref: "zz", result: "accepted" },
        ],
      },
      retryAfter: null,
    });
    const out = await notifyWalletPasses([
      { ref: "a", token: TOKEN },
      { ref: "b", token: TOKEN },
      { ref: "c", token: TOKEN },
    ]);
    const [, method, path, payload] = relayCall.mock.calls[0];
    expect([method, path]).toEqual(["POST", WALLET_NOTIFY_PATH]);
    expect(payload).toEqual({
      items: [
        { ref: "a", token: TOKEN },
        { ref: "b", token: TOKEN },
        { ref: "c", token: TOKEN },
      ],
    });
    expect(Object.fromEntries(out)).toEqual({
      a: "accepted",
      b: "unregistered",
      // No answer for it: try later.
      c: "unavailable",
    });
  });

  it("answers unavailable for all when the relay refuses", async () => {
    relayCall.mockResolvedValue({
      kind: "response",
      status: 503,
      body: { error: "wallet_unavailable" },
      retryAfter: null,
    });
    const out = await notifyWalletPasses([{ ref: "a", token: TOKEN }]);
    expect(Object.fromEntries(out)).toEqual({ a: "unavailable" });
  });

  it("refuses a malformed item before anything is sent", async () => {
    await expect(
      notifyWalletPasses([
        { ref: "a", token: TOKEN },
        { ref: "a", token: TOKEN },
      ]),
    ).rejects.toThrow();
    await expect(
      notifyWalletPasses([{ ref: "a", token: "xyz" }]),
    ).rejects.toThrow();
    await expect(
      notifyWalletPasses(
        Array.from({ length: 51 }, (_, i) => ({ ref: `r${i}`, token: TOKEN })),
      ),
    ).rejects.toThrow();
    expect(relayCall).not.toHaveBeenCalled();
  });
});

describe("the relay's Wallet answers", () => {
  it("are read only when they have the documented shape", () => {
    expect(parseRelayBody("POST", WALLET_SIGN_PATH, 200, OK_BODY)).toEqual(
      OK_BODY,
    );
    for (const bad of [
      { ...OK_BODY, signature: "not base64url!" },
      { ...OK_BODY, passTypeIdentifier: "org.example" },
      { ...OK_BODY, teamIdentifier: "short" },
      { ...OK_BODY, certNotAfterDay: "soon" },
    ]) {
      expect(parseRelayBody("POST", WALLET_SIGN_PATH, 200, bad)).toBe(
        "invalid",
      );
    }
    expect(
      parseRelayBody("POST", WALLET_NOTIFY_PATH, 200, {
        results: [{ ref: "a", result: "accepted" }],
      }),
    ).not.toBe("invalid");
    expect(
      parseRelayBody("POST", WALLET_NOTIFY_PATH, 200, {
        results: [{ ref: "a b", result: "accepted" }],
      }),
    ).toBe("invalid");
  });
});
