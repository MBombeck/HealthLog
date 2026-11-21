/**
 * A minimal push relay and APNs, built from the relay specification
 * (`spec/protocol.md`, `spec/statements.md`, `spec/envelope.md` of the relay
 * repository), for the end-to-end tests. It answers the HealthLog server's
 * calls in process, through a replaced `safeFetch`:
 *
 * - every instance request is checked (`hl-relay-v1`: host, instance, method,
 *   path, time, nonce, body hash), registration by its proof of possession;
 * - a binding needs a valid `hl-bind-v1` by the device's binding key;
 * - a push item needs a bound token, an envelope with the right frame for its
 *   class, and for a Live Activity end a valid `hl-activity-v1`;
 * - every response is signed (`hl-relay-resp-v1`) with the vector relay seed
 *   for the request nonce.
 *
 * Accepted pushes land in `apns`, as the fixed template the relay would send,
 * so the fake device can open the envelope. Knobs: `down` (no connection),
 * `forge` (sign with a foreign key), `unavailable` (503 without a hint),
 * `apnsAnswer` per token (`ok`, `unregistered`).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  bodyHashHex,
  fromBase64Url,
  tokenTagHex,
  toBase64Url,
} from "@/lib/push-relay/encoding";
import {
  activityText,
  bindText,
  ed25519PublicOf,
  registerText,
  requestText,
  responseText,
  signText,
  verifyText,
} from "@/lib/push-relay/statements";

/** Wire JSON as the relay protocol carries it; read field by field. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped wire JSON
type Wire = Record<string, any>;

const vectors = JSON.parse(
  readFileSync(
    path.join(
      process.cwd(),
      "src/lib/push-relay/__tests__/fixtures/relay-vectors-v1.json",
    ),
    "utf8",
  ),
);

export const RELAY_HOST = "push.example.org";
export const RELAY_URL = `https://${RELAY_HOST}`;
export const RELAY_SEED = Buffer.from(vectors.keys.relaySeed, "hex");
export const RELAY_PUBLIC_KEY = toBase64Url(ed25519PublicOf(RELAY_SEED));

export interface ApnsDelivery {
  token: string;
  pushClass: string;
  payload: Record<string, unknown>;
  collapse?: string;
}

const ENVELOPE_LENGTH: Record<string, number> = { alert: 1075, silent: 1075 };
const CLASS_BYTE: Record<string, number> = { alert: 1, silent: 2 };

export class FakeRelay {
  instances = new Map<string, Buffer>();
  bindings = new Map<
    string,
    { instanceId: string; bindingKey: string; seq: number }
  >();
  apns: ApnsDelivery[] = [];
  receipts: Array<{ accepted: number; confirmed: number }> = [];
  calls: string[] = [];
  down = false;
  forge = false;
  unavailable = false;
  /** Apply a key rotation, then drop the connection before answering. */
  dropAfterRotate = false;
  apnsAnswer = new Map<string, "ok" | "unregistered">();
  private nextId = 1;

  private sign(nonce: string | null, status: number, body: string): string {
    const seed = this.forge ? Buffer.alloc(32, 0x42) : RELAY_SEED;
    return toBase64Url(
      signText(seed, responseText({ host: RELAY_HOST, nonce, status, body })),
    );
  }

  private reply(nonce: string | null, status: number, value: unknown) {
    const body = value === null ? "" : JSON.stringify(value);
    return new Response(body || null, {
      status,
      headers: { "HL-Relay-Signature": this.sign(nonce, status, body) },
    });
  }

  /** The `safeFetch` replacement. */
  handle = async (
    url: string | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    if (this.down) {
      throw Object.assign(new Error("connect ECONNREFUSED"), {
        kind: "network",
      });
    }
    const target = new URL(url.toString());
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const nonceHeader = headers.get("HL-Nonce");
    const nonce =
      nonceHeader && fromBase64Url(nonceHeader, 16) ? nonceHeader : null;
    const body = typeof init.body === "string" ? init.body : "";
    const pathAndQuery = target.pathname + target.search;
    this.calls.push(`${method} ${pathAndQuery}`);
    if (this.unavailable)
      return this.reply(nonce, 503, { error: "relay_misconfigured" });

    if (method === "POST" && pathAndQuery === "/v1/instances") {
      const req = JSON.parse(body);
      const pk = fromBase64Url(req.publicKey, 32);
      const proof = fromBase64Url(req.proof, 64);
      if (
        !pk ||
        !proof ||
        !verifyText(pk, registerText(RELAY_HOST, pk, req.time), proof)
      ) {
        return this.reply(nonce, 401, { error: "bad_signature" });
      }
      for (const [id, key] of this.instances) {
        if (key.equals(pk))
          return this.reply(nonce, 200, {
            instanceId: id,
            tier: "probation",
            limits: {},
          });
      }
      const id = `6f1c2a4e-1b9d-4c3e-8a7f-${String(this.nextId++).padStart(12, "0")}`;
      this.instances.set(id, pk);
      return this.reply(nonce, 201, {
        instanceId: id,
        tier: "probation",
        limits: {},
      });
    }

    const instanceId = headers.get("HL-Instance") ?? "";
    const key = this.instances.get(instanceId);
    if (!key) return this.reply(nonce, 401, { error: "unknown_instance" });
    const timestamp = Number(headers.get("HL-Timestamp"));
    if (Math.abs(timestamp - Math.floor(Date.now() / 1000)) > 300) {
      return this.reply(nonce, 401, {
        error: "stale_timestamp",
        relayTime: Math.floor(Date.now() / 1000),
      });
    }
    const signature = fromBase64Url(headers.get("HL-Signature") ?? "", 64);
    const text = requestText({
      host: RELAY_HOST,
      instanceId,
      method,
      pathAndQuery,
      timestamp,
      nonce: nonceHeader ?? "",
      body,
    });
    if (!signature || !verifyText(key, text, signature)) {
      return this.reply(nonce, 401, { error: "bad_signature" });
    }
    if (bodyHashHex(body) !== text.split("\n").pop()) {
      return this.reply(nonce, 401, { error: "bad_signature" });
    }

    if (method === "POST" && pathAndQuery === "/v1/instances/self/rotate") {
      const req = JSON.parse(body);
      const pk = fromBase64Url(req.publicKey, 32);
      const proof = fromBase64Url(req.proof, 64);
      if (
        !pk ||
        !proof ||
        !verifyText(pk, registerText(RELAY_HOST, pk, req.time), proof)
      ) {
        return this.reply(nonce, 422, { error: "invalid_item" });
      }
      for (const k of this.instances.values()) {
        if (k.equals(pk))
          return this.reply(nonce, 409, { error: "key_in_use" });
      }
      this.instances.set(instanceId, pk);
      if (this.dropAfterRotate) {
        this.dropAfterRotate = false;
        throw Object.assign(new Error("socket hang up"), { kind: "network" });
      }
      return this.reply(nonce, 200, {
        instanceId,
        tier: "probation",
        limits: {},
      });
    }
    if (method === "DELETE" && pathAndQuery === "/v1/instances/self") {
      this.instances.delete(instanceId);
      for (const [t, b] of this.bindings)
        if (b.instanceId === instanceId) this.bindings.delete(t);
      return this.reply(nonce, 204, null);
    }
    if (method === "POST" && pathAndQuery === "/v1/bindings")
      return this.bind(nonce, instanceId, JSON.parse(body));
    if (method === "DELETE" && pathAndQuery === "/v1/bindings") {
      const { token } = JSON.parse(body);
      if (this.bindings.get(token)?.instanceId === instanceId)
        this.bindings.delete(token);
      return this.reply(nonce, 204, null);
    }
    if (method === "POST" && pathAndQuery === "/v1/push")
      return this.push(nonce, instanceId, JSON.parse(body));
    if (method === "POST" && pathAndQuery === "/v1/receipts") {
      this.receipts.push(JSON.parse(body));
      return this.reply(nonce, 204, null);
    }
    if (method === "GET" && pathAndQuery === "/v1/status") {
      return this.reply(nonce, 200, {
        state: "ok",
        tier: "probation",
        notice: null,
        relayTime: Math.floor(Date.now() / 1000),
      });
    }
    return this.reply(nonce, 404, { error: "not_found" });
  };

  private bind(nonce: string | null, instanceId: string, req: Wire) {
    const st = req.statement;
    if (st.instanceId !== instanceId)
      return this.reply(nonce, 403, { error: "binding_refused" });
    if (st.tokenTag !== tokenTagHex(req.token))
      return this.reply(nonce, 422, { error: "invalid_item" });
    const ok = verifyText(
      fromBase64Url(req.bindingKey, 32) as Buffer,
      bindText({ host: RELAY_HOST, ...st }),
      fromBase64Url(req.signature, 64) as Buffer,
    );
    if (!ok) return this.reply(nonce, 403, { error: "binding_refused" });
    const existing = this.bindings.get(req.token);
    if (existing && existing.bindingKey !== req.bindingKey) {
      return this.reply(nonce, 409, {
        error: "binding_conflict",
        reason: "challenge_sent",
      });
    }
    this.bindings.set(req.token, {
      instanceId,
      bindingKey: req.bindingKey,
      seq: st.seq,
    });
    return this.reply(nonce, existing ? 200 : 201, { state: "provisional" });
  }

  private push(
    nonce: string | null,
    instanceId: string,
    req: { items: Array<Wire> },
  ) {
    const results = req.items.map((item) => {
      const binding = this.bindings.get(item.token);
      if (!binding || binding.instanceId !== instanceId) {
        return { ref: item.ref, status: 404, error: "binding_unknown" };
      }
      if (item.class === "liveactivity") {
        const st = item.activity.statement;
        const ok =
          item.activity.bindingKey === binding.bindingKey &&
          st.instanceId === instanceId &&
          st.tokenTag === tokenTagHex(item.token) &&
          st.laTokenTag === tokenTagHex(item.activity.token) &&
          verifyText(
            fromBase64Url(binding.bindingKey, 32) as Buffer,
            activityText({ host: RELAY_HOST, ...st }),
            fromBase64Url(item.activity.signature, 64) as Buffer,
          );
        if (!ok)
          return { ref: item.ref, status: 403, error: "activity_refused" };
        this.apns.push({
          token: item.activity.token,
          pushClass: "liveactivity",
          payload: { aps: { event: "end" } },
        });
        return { ref: item.ref, status: 200, result: "accepted" };
      }
      const env = fromBase64Url(item.envelope ?? "");
      if (
        !env ||
        env.length !== ENVELOPE_LENGTH[item.class] ||
        env[0] !== 1 ||
        env[1] !== 1 ||
        env[2] !== CLASS_BYTE[item.class] ||
        (item.class === "alert" &&
          !/^[A-Za-z0-9_-]{22}$/.test(item.collapse ?? ""))
      ) {
        return { ref: item.ref, status: 422, error: "invalid_item" };
      }
      if (this.apnsAnswer.get(item.token) === "unregistered") {
        this.bindings.delete(item.token);
        return { ref: item.ref, status: 410, error: "unregistered" };
      }
      const payload =
        item.class === "alert"
          ? {
              aps: {
                alert: { "loc-key": "HL_RELAY_ALERT" },
                "mutable-content": 1,
                sound: "default",
              },
              e: item.envelope,
            }
          : { aps: { "content-available": 1 }, e: item.envelope };
      this.apns.push({
        token: item.token,
        pushClass: item.class,
        payload,
        collapse: item.collapse,
      });
      return { ref: item.ref, status: 200, result: "accepted" };
    });
    return this.reply(nonce, 200, {
      results,
      notice: null,
      relayTime: Math.floor(Date.now() / 1000),
    });
  }
}

/** Wait until `predicate` holds, polling; throws after `timeoutMs`. */
export async function eventually(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 8_000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs)
      throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 100));
  }
}
