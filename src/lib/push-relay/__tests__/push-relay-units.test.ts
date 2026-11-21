/**
 * The pure parts of the push relay client: plaintext and padding, the
 * breaker, sender-key publication and collapse ids, the binding check, and
 * which dispatcher alerts may travel over the relay.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { BUCKET } from "@/lib/push-relay/hpke";
import {
  buildPlaintext,
  newUlid,
  padPlaintext,
} from "@/lib/push-relay/plaintext";
import {
  afterSignedResponse,
  afterTransportFailure,
  isCircuitOpen,
  isTransportLikeStatus,
  probeDue,
} from "@/lib/push-relay/circuit";
import {
  collapseIdFor,
  publishedSenderKeys,
  senderKeyDue,
} from "@/lib/push-relay/sender-keys";
import {
  checkBindingStatement,
  stateAfterBind,
} from "@/lib/push-relay/binding";
import { alertMessage, relayCarries } from "@/lib/push-relay/apns-channel";
import { relayConfig } from "@/lib/push-relay/config";

const vectors = JSON.parse(
  readFileSync(
    path.join(__dirname, "fixtures", "relay-vectors-v1.json"),
    "utf8",
  ),
);
const keys = vectors.keys as Record<string, string>;

describe("plaintext", () => {
  it("makes a 26-character Crockford ULID that sorts by time", () => {
    const a = newUlid(1_795_000_000_000);
    const b = newUlid(1_795_000_001_000);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
  });

  it("clamps the lifetime to the class maximum", () => {
    const p = buildPlaintext({
      pushClass: "silent",
      type: "MEDICATION_INTAKE_SYNC",
      lifetimeSeconds: 99_999,
      nowMs: 1_795_000_000_000,
    });
    expect(p.exp - p.iat).toBe(3600);
  });

  it("shortens visible text to fit the bucket and pads with zeros", () => {
    const p = buildPlaintext({
      pushClass: "alert",
      type: "X",
      lifetimeSeconds: 60,
      text: { title: "ä".repeat(400), body: "ü".repeat(400) },
    });
    const { padded, plaintext } = padPlaintext("alert", p);
    expect(padded.length).toBe(BUCKET.alert);
    const len = padded.readUInt16BE(0);
    expect(len).toBeLessThanOrEqual(BUCKET.alert - 2);
    expect(padded.subarray(2 + len).every((b) => b === 0)).toBe(true);
    const decoded = JSON.parse(padded.subarray(2, 2 + len).toString("utf8"));
    expect(decoded).toEqual(plaintext);
    expect((plaintext.n?.title?.length ?? 0) < 400).toBe(true);
  });
});

describe("breaker", () => {
  const closed = {
    circuitFailures: 0,
    circuitOpenedAt: null,
    nextProbeAt: null,
  };
  const now = new Date("2026-12-01T08:00:00Z");

  it("opens on the third transport failure in a row, not before", () => {
    const one = afterTransportFailure(closed, now);
    const two = afterTransportFailure(one, now);
    expect(isCircuitOpen(two)).toBe(false);
    const three = afterTransportFailure(two, now);
    expect(isCircuitOpen(three)).toBe(true);
    expect(three.nextProbeAt?.getTime()).toBe(now.getTime() + 60_000);
    expect(probeDue(three, now)).toBe(false);
    expect(probeDue(three, new Date(now.getTime() + 60_000))).toBe(true);
    expect(isCircuitOpen(afterSignedResponse())).toBe(false);
  });

  it("slows the probe after fifteen minutes", () => {
    const open = { circuitFailures: 3, circuitOpenedAt: now, nextProbeAt: now };
    const later = new Date(now.getTime() + 16 * 60_000);
    const next = afterTransportFailure(open, later);
    expect(next.nextProbeAt?.getTime()).toBe(later.getTime() + 5 * 60_000);
  });

  it("counts only unexplained gateway failures as transport failures", () => {
    expect(
      isTransportLikeStatus(503, null, { error: "relay_misconfigured" }),
    ).toBe(true);
    expect(isTransportLikeStatus(503, 30, null)).toBe(false);
    expect(isTransportLikeStatus(503, null, { retryAfter: 5 })).toBe(false);
    expect(isTransportLikeStatus(429, null, null)).toBe(false);
    expect(isTransportLikeStatus(404, null, null)).toBe(false);
  });
});

describe("sender keys", () => {
  const now = new Date("2026-12-01T00:00:00Z");
  const day = 24 * 3600 * 1000;

  it("publishes the previous key for 30 days after a rotation, then drops it", () => {
    const row = {
      senderPublicKey: "cur",
      previousSenderPublicKey: "prev",
      previousRetiredAt: new Date(now.getTime() - 29 * day),
    };
    expect(publishedSenderKeys(row, now)).toEqual([
      { publicKey: "cur", status: "current" },
      { publicKey: "prev", status: "previous" },
    ]);
    expect(
      publishedSenderKeys(
        { ...row, previousRetiredAt: new Date(now.getTime() - 31 * day) },
        now,
      ),
    ).toEqual([{ publicKey: "cur", status: "current" }]);
  });

  it("announces the next key a year less 7 days after the current one", () => {
    const at = (days: number) => ({
      senderCreatedAt: new Date(now.getTime() - days * day),
    });
    expect(senderKeyDue(at(357), now)).toBe(false);
    expect(senderKeyDue(at(358), now)).toBe(true);
    expect(senderKeyDue({ ...at(400), nextSenderPublicKey: "n" }, now)).toBe(
      false,
    );
  });

  it("publishes at most three keys: next, current, previous", () => {
    expect(
      publishedSenderKeys(
        {
          senderPublicKey: "cur",
          nextSenderPublicKey: "nxt",
          previousSenderPublicKey: "prev",
          previousRetiredAt: new Date(now.getTime() - day),
        },
        now,
      ),
    ).toEqual([
      { publicKey: "nxt", status: "next" },
      { publicKey: "cur", status: "current" },
      { publicKey: "prev", status: "previous" },
    ]);
  });

  it("derives a 22-character collapse id that differs per device", () => {
    const secret = Buffer.alloc(32, 7);
    const a = collapseIdFor(secret, "0f".repeat(32), "intake-m1-1");
    const b = collapseIdFor(secret, "1f".repeat(32), "intake-m1-1");
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a).not.toBe(b);
    expect(collapseIdFor(secret, "0f".repeat(32), "intake-m1-1")).toBe(a);
  });
});

describe("binding statement", () => {
  const bind = vectors.statements.find(
    (s: { name: string }) => s.name === "bind",
  );
  const binding = {
    bindingKey: bind.publicKey as string,
    statement: {
      instanceId: keys.instanceId,
      tokenTag: vectors.tokenTags[0].tokenTag as string,
      kind: "device" as const,
      seq: 7,
      iat: vectors.constants.now as number,
    },
    signature: bind.signature as string,
  };
  const config = { host: vectors.constants.host as string };

  it("accepts the vector statement for its instance and token", () => {
    expect(
      checkBindingStatement(
        binding,
        keys.apnsToken,
        { instanceId: keys.instanceId },
        config,
      ),
    ).toBeNull();
  });

  it("refuses another instance, another token, a forged signature, no registration", () => {
    expect(
      checkBindingStatement(
        binding,
        keys.apnsToken,
        { instanceId: "00000000-0000-4000-8000-000000000000" },
        config,
      ),
    ).toBe("instance_mismatch");
    expect(
      checkBindingStatement(
        binding,
        "aa".repeat(32),
        { instanceId: keys.instanceId },
        config,
      ),
    ).toBe("token_mismatch");
    expect(
      checkBindingStatement(
        { ...binding, statement: { ...binding.statement, seq: 8 } },
        keys.apnsToken,
        { instanceId: keys.instanceId },
        config,
      ),
    ).toBe("bad_signature");
    expect(checkBindingStatement(binding, keys.apnsToken, null, config)).toBe(
      "relay_not_offered",
    );
  });

  it("maps every bind answer onto a state, never a deletion", () => {
    expect(stateAfterBind(201, undefined)).toBe("bound");
    expect(stateAfterBind(200, undefined)).toBe("bound");
    expect(stateAfterBind(409, "binding_conflict")).toBe("conflict");
    expect(stateAfterBind(401, "stale_timestamp")).toBe("rebind_needed");
    expect(stateAfterBind(null, null)).toBe("rebind_needed");
    expect(stateAfterBind(403, "binding_refused")).toBe("none");
    expect(stateAfterBind(429, "binding_quota")).toBe("none");
  });
});

describe("what travels over the relay", () => {
  const base = {
    title: "T",
    message: "M",
    metadata: { url: "/x", medicationId: "m1" },
  };

  it("keeps locally planned reminders off the relay", () => {
    for (const eventType of [
      "MOOD_REMINDER",
      "MEASUREMENT_REMINDER",
      "CYCLE_PERIOD_SOON",
      "CYCLE_FERTILE_SOON",
    ]) {
      expect(
        relayCarries({ ...base, eventType }, { medicationDelivery: "server" }),
      ).toBe(false);
    }
  });

  it("carries a medication reminder only to a device that asked for server delivery", () => {
    const p = { ...base, eventType: "MEDICATION_REMINDER" };
    expect(relayCarries(p, { medicationDelivery: null })).toBe(false);
    expect(relayCarries(p, { medicationDelivery: "client" })).toBe(false);
    expect(relayCarries(p, { medicationDelivery: "server" })).toBe(true);
    expect(
      relayCarries(
        { ...base, eventType: "MEDICATION_LOW_STOCK" },
        { medicationDelivery: null },
      ),
    ).toBe(true);
  });

  it("seals no URL and sets Time Sensitive only inside the envelope", () => {
    const m = alertMessage({ ...base, eventType: "MEDICATION_REMINDER" });
    expect(m.data).toEqual({ medicationId: "m1" });
    expect(m.ui?.level).toBe("time-sensitive");
    expect(m.lifetimeSeconds).toBe(15 * 60);
    expect(
      alertMessage({ ...base, eventType: "MEDICATION_LOW_STOCK" }).ui?.level,
    ).toBe("active");
  });

  it("makes a security alert time-sensitive and keeps other urgent types active", () => {
    const security = alertMessage({
      ...base,
      eventType: "SECURITY_ALERT",
      metadata: { securityKind: "passkey_added" },
    });
    expect(security.ui?.level).toBe("time-sensitive");
    expect(security.type).toBe("SECURITY_ALERT");
    expect(security.data).toEqual({ securityKind: "passkey_added" });
    expect(
      alertMessage({ ...base, eventType: "SYSTEM_ALERT", urgent: true }).ui
        ?.level,
    ).toBe("time-sensitive");
    // The receiver accepts time-sensitive only for the listed types.
    expect(
      alertMessage({ ...base, eventType: "SEIZURE_CLUSTER", urgent: true }).ui
        ?.level,
    ).toBe("active");
    expect(
      relayCarries(
        { ...base, eventType: "SECURITY_ALERT" },
        { medicationDelivery: null },
      ),
    ).toBe(true);
  });
});

describe("relay configuration", () => {
  it("is unavailable without pinned keys and refuses plain http", () => {
    expect(relayConfig({}).unavailableReason).toBe("keys_unpinned");
    expect(relayConfig({ PUSH_RELAY_MODE: "off" }).unavailableReason).toBe(
      "mode_off",
    );
    expect(
      relayConfig({
        PUSH_RELAY_URL: "http://relay.example.org",
        PUSH_RELAY_KEYS: "x",
      }).unavailableReason,
    ).toBe("invalid_url");
    const relayKey = vectors.statements.find(
      (s: { name: string }) => s.name === "response",
    ).publicKey;
    const ok = relayConfig({
      PUSH_RELAY_URL: "https://Relay.Example.org/",
      PUSH_RELAY_KEYS: relayKey,
    });
    expect(ok.available).toBe(true);
    expect(ok.host).toBe("relay.example.org");
    expect(ok.origin).toBe("https://relay.example.org");
  });
});
