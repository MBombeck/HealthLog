/**
 * The relay client acts only on responses a pinned relay key signed for this
 * very request, and corrects its clock once after `stale_timestamp`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/safe-fetch", () => ({ safeFetch: fetchMock }));

import {
  registerInstance,
  registrationBody,
  signedRelayCall,
  verifyRelayResponse,
} from "@/lib/push-relay/client";
import { relayConfig } from "@/lib/push-relay/config";
import { fromBase64Url } from "@/lib/push-relay/encoding";
import { relayInviteSchema } from "@/lib/push-relay/invite";
import {
  ed25519PublicOf,
  registerText,
  requestText,
  responseText,
  signText,
  verifyText,
} from "@/lib/push-relay/statements";

const vectors = JSON.parse(
  readFileSync(
    path.join(__dirname, "fixtures", "relay-vectors-v1.json"),
    "utf8",
  ),
);
const keys = vectors.keys as Record<string, string>;
const relaySeed = Buffer.from(keys.relaySeed, "hex");
const instanceSeed = Buffer.from(keys.instanceSeed, "hex");
const config = relayConfig({
  PUSH_RELAY_URL: "https://push.example.org",
  PUSH_RELAY_KEYS: ed25519PublicOf(relaySeed).toString("base64url"),
});
const identity = {
  instanceId: keys.instanceId,
  instanceSeed,
  clockOffsetSeconds: 0,
};

/** A relay answer signed by `seed` for the nonce of the request it answers. */
function signedAnswer(
  url: string,
  init: RequestInit,
  status: number,
  body: unknown,
  seed: Buffer = relaySeed,
  nonceOverride?: string | null,
  extraHeaders: Record<string, string> = {},
  pathOverride?: string,
) {
  const text = body === null ? "" : JSON.stringify(body);
  const nonce =
    nonceOverride === undefined
      ? (new Headers(init.headers).get("HL-Nonce") as string)
      : nonceOverride;
  const target = new URL(url);
  const signature = signText(
    seed,
    responseText({
      host: "push.example.org",
      method: init.method ?? "GET",
      pathAndQuery: pathOverride ?? target.pathname + target.search,
      nonce,
      status,
      body: text,
    }),
  ).toString("base64url");
  return new Response(text || null, {
    status,
    headers: { "HL-Relay-Signature": signature, ...extraHeaders },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("relay client", () => {
  it("signs the request over host, instance, method, path, time, nonce and body", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) =>
      signedAnswer(url, init, 200, { results: [] }),
    );
    const result = await signedRelayCall(config, identity, "POST", "/v1/push", {
      items: [],
    });
    expect(result.kind).toBe("response");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const h = new Headers(init.headers);
    const text = requestText({
      host: "push.example.org",
      instanceId: keys.instanceId,
      method: "POST",
      pathAndQuery: "/v1/push",
      timestamp: Number(h.get("HL-Timestamp")),
      nonce: h.get("HL-Nonce") as string,
      body: init.body as string,
    });
    expect(
      verifyText(
        ed25519PublicOf(instanceSeed),
        text,
        fromBase64Url(h.get("HL-Signature") as string, 64) as Buffer,
      ),
    ).toBe(true);
    expect(h.get("HL-Client")).toMatch(/^healthlog\/\d+\.\d+\.\d+$/);
  });

  it("treats an unsigned, foreign-signed or replayed answer as a transport error", async () => {
    const other = Buffer.alloc(32, 9);
    for (const answer of [
      () =>
        new Response(JSON.stringify({ error: "unregistered" }), {
          status: 410,
        }),
      (url: string, init: RequestInit) =>
        signedAnswer(url, init, 410, { error: "unregistered" }, other),
      (url: string, init: RequestInit) =>
        signedAnswer(
          url,
          init,
          410,
          { error: "unregistered" },
          relaySeed,
          "T09PT09PT09PT09PT09PTw",
        ),
    ]) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(async (url: string, init: RequestInit) =>
        answer(url, init),
      );
      const result = await signedRelayCall(
        config,
        identity,
        "GET",
        "/v1/status",
        undefined,
      );
      expect(result).toEqual({
        kind: "transport",
        reason: "relay_signature_invalid",
      });
    }
  });

  it("retries once with the relay's clock after stale_timestamp", async () => {
    const relayTime = Math.floor(Date.now() / 1000) + 1000;
    const offsets: number[] = [];
    fetchMock
      .mockImplementationOnce(async (url: string, init: RequestInit) =>
        signedAnswer(url, init, 401, { error: "stale_timestamp", relayTime }),
      )
      .mockImplementationOnce(async (url: string, init: RequestInit) =>
        signedAnswer(url, init, 200, { state: "ok" }),
      );
    const result = await signedRelayCall(
      config,
      identity,
      "GET",
      "/v1/status",
      undefined,
      (o) => {
        offsets.push(o);
      },
    );
    expect(result.kind === "response" && result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = new Headers(
      (fetchMock.mock.calls[1][1] as RequestInit).headers,
    );
    expect(
      Math.abs(Number(second.get("HL-Timestamp")) - relayTime),
    ).toBeLessThan(5);
    expect(offsets).toHaveLength(1);
  });

  it("verifies the vector response signatures", () => {
    const config = {
      host: "push.healthlog.dev",
      identityKeys: [ed25519PublicOf(relaySeed)],
    };
    const v = vectors.statements.find(
      (s: { name: string }) => s.name === "response",
    );
    const request = {
      method: "POST",
      pathAndQuery: "/v1/push",
      nonce: keys.nonce,
    };
    expect(
      verifyRelayResponse(
        config,
        request,
        200,
        Buffer.from(v.body),
        v.signature,
      ),
    ).toBe(true);
    expect(
      verifyRelayResponse(
        config,
        request,
        410,
        Buffer.from(v.body),
        v.signature,
      ),
    ).toBe(false);
    expect(
      verifyRelayResponse(
        config,
        { ...request, pathAndQuery: "/v1/receipts" },
        200,
        Buffer.from(v.body),
        v.signature,
      ),
    ).toBe(false);
    const app = vectors.statements.find(
      (s: { name: string }) => s.name === "responseAppEndpoint",
    );
    expect(
      verifyRelayResponse(
        config,
        {
          method: "DELETE",
          pathAndQuery: "/v1/bindings/self",
          nonce: keys.nonce,
        },
        204,
        Buffer.alloc(0),
        app.signature,
      ),
    ).toBe(true);
  });

  it("treats an answer for another path, or bound to no nonce, as no answer", async () => {
    for (const answer of [
      (url: string, init: RequestInit) =>
        signedAnswer(
          url,
          init,
          200,
          { state: "ok" },
          relaySeed,
          undefined,
          {},
          "/v1/push",
        ),
      (url: string, init: RequestInit) =>
        signedAnswer(url, init, 200, { state: "ok" }, relaySeed, null),
    ]) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(async (url: string, init: RequestInit) =>
        answer(url, init),
      );
      expect(
        await signedRelayCall(config, identity, "GET", "/v1/status", undefined),
      ).toEqual({ kind: "transport", reason: "relay_signature_invalid" });
    }
  });

  it("takes the retry hint only from the signed body, capped at a day", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) =>
      signedAnswer(
        url,
        init,
        429,
        { error: "instance_rate", scope: "instance" },
        relaySeed,
        undefined,
        {
          "Retry-After": "999999",
        },
      ),
    );
    const unsignedHint = await signedRelayCall(
      config,
      identity,
      "GET",
      "/v1/status",
      undefined,
    );
    expect(
      unsignedHint.kind === "response" && unsignedHint.retryAfter,
    ).toBeNull();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init: RequestInit) =>
      signedAnswer(url, init, 429, {
        error: "instance_rate",
        retryAfter: 10_000_000,
      }),
    );
    const signedHint = await signedRelayCall(
      config,
      identity,
      "GET",
      "/v1/status",
      undefined,
    );
    expect(signedHint.kind === "response" && signedHint.retryAfter).toBe(
      86_400,
    );
  });

  it("refuses a body over 256 KiB, and a signed body that breaks its schema", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) =>
      signedAnswer(url, init, 200, {
        results: [],
        filler: "x".repeat(300_000),
      }),
    );
    expect(
      await signedRelayCall(config, identity, "POST", "/v1/push", {
        items: [],
      }),
    ).toEqual({ kind: "transport", reason: "relay_body_too_large" });
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init: RequestInit) =>
      signedAnswer(url, init, 200, {
        instanceId: "not-a-uuid",
        tier: "x".repeat(500),
      }),
    );
    expect(
      await signedRelayCall(
        config,
        identity,
        "POST",
        "/v1/instances/self/rotate",
        {},
      ),
    ).toEqual({ kind: "transport", reason: "relay_body_invalid" });
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init: RequestInit) =>
      signedAnswer(url, init, 403, {
        error: "instance_suspended",
        reason: "y".repeat(300),
      }),
    );
    expect(
      await signedRelayCall(config, identity, "GET", "/v1/status", undefined),
    ).toEqual({ kind: "transport", reason: "relay_body_invalid" });
  });
});

describe("registration body", () => {
  const invite = "Q2xhc3NpY0ludml0ZUNvZGVz";

  it("carries the proof of possession and leaves `invite` out without a code", () => {
    const body = JSON.parse(registrationBody(config, instanceSeed, 1795000000));
    expect(Object.keys(body).sort()).toEqual([
      "client",
      "proof",
      "publicKey",
      "time",
    ]);
    const publicKey = ed25519PublicOf(instanceSeed);
    expect(body.publicKey).toBe(publicKey.toString("base64url"));
    expect(
      verifyText(
        publicKey,
        registerText("push.example.org", publicKey, 1795000000),
        fromBase64Url(body.proof, 64) as Buffer,
      ),
    ).toBe(true);
  });

  it("adds the invite code as `invite`, outside the signed proof text", () => {
    const plain = JSON.parse(
      registrationBody(config, instanceSeed, 1795000000),
    );
    const body = JSON.parse(
      registrationBody(config, instanceSeed, 1795000000, invite),
    );
    expect(body).toEqual({ ...plain, invite });
  });

  it("sends the code on the wire with the registration", async () => {
    fetchMock.mockImplementation(async (url: string, init: RequestInit) =>
      signedAnswer(url, init, 403, { error: "invite_required" }),
    );
    const result = await registerInstance(
      config,
      instanceSeed,
      0,
      undefined,
      invite,
    );
    expect(result).toMatchObject({ kind: "response", status: 403 });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string).invite).toBe(invite);
  });

  it("accepts exactly 24 base64url characters as a code", () => {
    expect(relayInviteSchema.safeParse(invite).success).toBe(true);
    for (const bad of [
      "",
      invite.slice(1),
      `${invite}A`,
      `${invite.slice(1)}+`,
      `${invite.slice(1)}=`,
      `${invite.slice(1)} `,
    ]) {
      expect(relayInviteSchema.safeParse(bad).success).toBe(false);
    }
  });
});
