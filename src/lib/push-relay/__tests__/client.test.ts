/**
 * The relay client acts only on responses a pinned relay key signed for this
 * very request, and corrects its clock once after `stale_timestamp`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/safe-fetch", () => ({ safeFetch: fetchMock }));

import { signedRelayCall, verifyRelayResponse } from "@/lib/push-relay/client";
import { relayConfig } from "@/lib/push-relay/config";
import { fromBase64Url } from "@/lib/push-relay/encoding";
import {
  ed25519PublicOf,
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
  init: RequestInit,
  status: number,
  body: unknown,
  seed: Buffer = relaySeed,
  nonceOverride?: string,
) {
  const text = body === null ? "" : JSON.stringify(body);
  const nonce =
    nonceOverride ?? (new Headers(init.headers).get("HL-Nonce") as string);
  const signature = signText(
    seed,
    responseText({ host: "push.example.org", nonce, status, body: text }),
  ).toString("base64url");
  return new Response(text || null, {
    status,
    headers: { "HL-Relay-Signature": signature },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("relay client", () => {
  it("signs the request over host, instance, method, path, time, nonce and body", async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) =>
      signedAnswer(init, 200, { results: [] }),
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
      (init: RequestInit) =>
        signedAnswer(init, 410, { error: "unregistered" }, other),
      (init: RequestInit) =>
        signedAnswer(
          init,
          410,
          { error: "unregistered" },
          relaySeed,
          "T09PT09PT09PT09PT09PTw",
        ),
    ]) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(async (_u: string, init: RequestInit) =>
        answer(init),
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
      .mockImplementationOnce(async (_u: string, init: RequestInit) =>
        signedAnswer(init, 401, { error: "stale_timestamp", relayTime }),
      )
      .mockImplementationOnce(async (_u: string, init: RequestInit) =>
        signedAnswer(init, 200, { state: "ok" }),
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

  it("verifies the vector response signature", () => {
    const v = vectors.statements.find(
      (s: { name: string }) => s.name === "response",
    );
    expect(
      verifyRelayResponse(
        {
          host: "push.healthlog.dev",
          identityKeys: [ed25519PublicOf(relaySeed)],
        },
        keys.nonce,
        200,
        Buffer.from(v.body),
        v.signature,
      ),
    ).toBe(true);
    expect(
      verifyRelayResponse(
        {
          host: "push.healthlog.dev",
          identityKeys: [ed25519PublicOf(relaySeed)],
        },
        keys.nonce,
        410,
        Buffer.from(v.body),
        v.signature,
      ),
    ).toBe(false);
  });
});
