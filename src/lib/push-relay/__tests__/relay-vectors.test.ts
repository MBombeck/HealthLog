/**
 * The relay's golden vectors (`spec/vectors/v1.json` of the relay repository,
 * CC0), copied here and pinned by SHA-256 so a change on either side fails
 * both suites.
 *
 * Seal: the production `sealPadded` must reproduce every positive envelope
 * byte for byte. The vectors are deterministic only because the generator
 * injected its ephemeral key; production code never accepts one, so this file
 * replaces the X25519 key generator of `node:crypto` for the seal call alone.
 *
 * Open: every envelope vector, positive and negative, opens (or fails) with
 * the code it records. Statements: every text this server builds is
 * byte-identical to the vector and signs to the same signature; every
 * negative statement fails.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import * as nodeCrypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    default: actual,
    generateKeyPairSync: vi.fn(actual.generateKeyPairSync),
  };
});

import {
  bodyHashHex,
  fromBase64Url,
  tokenTag,
  tokenTagHex,
  pushKeyId,
} from "@/lib/push-relay/encoding";
import {
  envelopeAad,
  isValidRecipientKey,
  sealPadded,
  x25519PrivateKey,
  x25519RawPublic,
  type EnvelopeClass,
} from "@/lib/push-relay/hpke";
import {
  activityText,
  laConsentText,
  laStartText,
  laWithdrawText,
  bindText,
  ed25519PublicOf,
  registerText,
  requestText,
  responseText,
  signText,
  verifyText,
} from "@/lib/push-relay/statements";
import { openEnvelope, OpenError } from "./envelope-open";
import { buildPlaintext, padPlaintext } from "@/lib/push-relay/plaintext";
import { alertMessage } from "@/lib/push-relay/apns-channel";
import { wakeMessage } from "@/lib/push-relay/wakes";
import {
  intakeRecordedMessage,
  intakeSyncMessage,
} from "@/lib/push-relay/medication-pushes";

const FIXTURE = path.join(__dirname, "fixtures", "relay-vectors-v1.json");
const PINNED_SHA256 =
  "eea37337e2db06cc668493dfee44610ed43f97b53fbf71f16f4c4b4a10ccd618";

const raw = readFileSync(FIXTURE);
const vectors = JSON.parse(raw.toString("utf8"));
const keys = vectors.keys as Record<string, string>;
const hex = (s: string) => Buffer.from(s, "hex");

afterEach(() => {
  vi.mocked(nodeCrypto.generateKeyPairSync).mockRestore?.();
});

describe("relay vectors v1", () => {
  it("is the pinned file", () => {
    expect(nodeCrypto.createHash("sha256").update(raw).digest("hex")).toBe(
      PINNED_SHA256,
    );
  });

  it("derives the token tag, AAD and key id", () => {
    const token = hex(keys.apnsToken);
    expect(tokenTag(token).toString("hex")).toBe(vectors.tokenTags[0].tokenTag);
    expect(tokenTagHex(keys.apnsToken)).toBe(vectors.tokenTags[0].tokenTag);
    const header = Buffer.from([1, 1, 1]);
    expect(envelopeAad(header, token).toString("hex")).toBe(vectors.aad.alert);
    expect(pushKeyId(hex(keys.recipientPublicKey))).toBe(
      keys.recipientKeyIdApiOnly,
    );
  });

  it("refuses every low-order recipient key", () => {
    for (const point of vectors.lowOrderPoints as string[]) {
      expect(isValidRecipientKey(hex(point))).toBe(false);
    }
    expect(isValidRecipientKey(hex(keys.recipientPublicKey))).toBe(true);
    expect(isValidRecipientKey(hex("aa".repeat(31)))).toBe(false);
  });

  const SEAL_KEYS: Record<string, { skS: string; skR: string }> = {
    alert: { skS: "senderPrivateKey", skR: "recipientPrivateKey" },
    silent: { skS: "senderPrivateKey", skR: "recipientPrivateKey" },
    previousSender: {
      skS: "senderPreviousPrivateKey",
      skR: "recipientPrivateKey",
    },
    previousRecipientKey: {
      skS: "senderPrivateKey",
      skR: "recipientPreviousPrivateKey",
    },
    exactBucketMultibyteEnd: {
      skS: "senderPrivateKey",
      skR: "recipientPrivateKey",
    },
  };

  for (const [name, pick] of Object.entries(SEAL_KEYS)) {
    it(`seals the ${name} vector byte for byte`, () => {
      const v = vectors.envelopes.find(
        (e: { name: string }) => e.name === name,
      );
      const pushClass = v.expectedClass as EnvelopeClass;
      const json = Buffer.from(JSON.stringify(v.plaintext), "utf8");
      const bucket = { alert: 1024, silent: 1024 }[pushClass];
      const padded = Buffer.alloc(bucket);
      padded.writeUInt16BE(json.length, 0);
      json.copy(padded, 2);
      const injected = x25519PrivateKey(hex(keys.ephemeralPrivateKey));
      // The X25519 overload of the generator, returning the vector's key.
      const injectVectorKey: (type: "x25519") => {
        privateKey: nodeCrypto.KeyObject;
        publicKey: nodeCrypto.KeyObject;
      } = (type) => {
        expect(type).toBe("x25519");
        return { privateKey: injected, publicKey: injected };
      };
      vi.mocked(nodeCrypto.generateKeyPairSync).mockImplementation(
        injectVectorKey as typeof nodeCrypto.generateKeyPairSync,
      );
      const sealed = sealPadded({
        pushClass,
        padded,
        recipientPublicKey: x25519RawPublic(
          x25519PrivateKey(hex(keys[pick.skR])),
        ),
        senderPrivateKey: hex(keys[pick.skS]),
        apnsToken: hex(v.apnsToken),
      });
      vi.mocked(nodeCrypto.generateKeyPairSync).mockRestore();
      expect(sealed.toString("base64url")).toBe(v.envelope);
    });
  }

  it("builds the wake and security plaintexts the way the vectors record them", () => {
    const pick = (name: string) =>
      vectors.envelopes.find((e: { name: string }) => e.name === name);
    const data = pick("silentDataChanged");
    const catchUp = pick("silentHealthKitCatchUp");
    const security = pick("alertSecurity");
    const cases = [
      [wakeMessage("DATA_CHANGED", data.plaintext.d), data],
      [wakeMessage("HEALTHKIT_CATCH_UP", catchUp.plaintext.d), catchUp],
      [
        alertMessage({
          eventType: "SECURITY_ALERT",
          title: security.plaintext.n.title,
          message: security.plaintext.n.body,
          metadata: { securityKind: security.plaintext.d.securityKind },
          urgent: true,
        }),
        security,
      ],
    ] as const;
    for (const [message, v] of cases) {
      const built = buildPlaintext({
        pushClass: message.pushClass,
        type: message.type,
        lifetimeSeconds: message.lifetimeSeconds,
        nowMs: v.plaintext.iat * 1000,
        data: message.data,
        text: message.text,
        ui: message.ui,
      });
      expect(JSON.stringify({ ...built, id: v.plaintext.id }), v.name).toBe(
        JSON.stringify(v.plaintext),
      );
    }
  });

  it("builds the alert and silent plaintexts the way the vectors record them", () => {
    const alert = vectors.envelopes.find(
      (e: { name: string }) => e.name === "alert",
    );
    const silent = vectors.envelopes.find(
      (e: { name: string }) => e.name === "silent",
    );
    const d = alert.plaintext.d;
    const recorded = intakeRecordedMessage(
      {
        medicationId: d.medicationId,
        intakeId: d.intakeId,
        slotInstant: new Date(d.slotInstant),
        outcome: d.outcome,
        takenAt: new Date(d.takenAt),
        takenVia: d.takenVia,
      },
      alert.plaintext.n,
    );
    const sync = intakeSyncMessage(new Date(silent.plaintext.d.syncedAt));
    for (const [message, v] of [
      [recorded, alert],
      [sync, silent],
    ] as const) {
      const built = {
        ...buildPlaintext({
          pushClass: message.pushClass,
          type: message.type,
          lifetimeSeconds: message.lifetimeSeconds,
          nowMs: v.plaintext.iat * 1000,
          data: message.data,
          text: message.text,
          ui: message.ui,
        }),
      };
      // The id is random per seal; the vector fixes one.
      const plaintext = { ...built, id: v.plaintext.id };
      expect(JSON.stringify(plaintext)).toBe(JSON.stringify(v.plaintext));
      const { padded } = padPlaintext(message.pushClass, plaintext);
      const injected = x25519PrivateKey(hex(keys.ephemeralPrivateKey));
      const inject: (type: "x25519") => {
        privateKey: nodeCrypto.KeyObject;
        publicKey: nodeCrypto.KeyObject;
      } = () => ({ privateKey: injected, publicKey: injected });
      vi.mocked(nodeCrypto.generateKeyPairSync).mockImplementation(
        inject as typeof nodeCrypto.generateKeyPairSync,
      );
      const sealed = sealPadded({
        pushClass: message.pushClass,
        padded,
        recipientPublicKey: hex(keys.recipientPublicKey),
        senderPrivateKey: hex(keys.senderPrivateKey),
        apnsToken: hex(v.apnsToken),
      });
      vi.mocked(nodeCrypto.generateKeyPairSync).mockRestore();
      expect(sealed.toString("base64url")).toBe(v.envelope);
    }
  });

  it("seals with a fresh ephemeral key every time", () => {
    const padded = Buffer.alloc(1024);
    padded.writeUInt16BE(2, 0);
    padded.write("{}", 2);
    const input = {
      pushClass: "alert" as const,
      padded,
      recipientPublicKey: hex(keys.recipientPublicKey),
      senderPrivateKey: hex(keys.senderPrivateKey),
      apnsToken: hex(keys.apnsToken),
    };
    const a = sealPadded(input);
    const b = sealPadded(input);
    expect(a.subarray(3, 35).equals(b.subarray(3, 35))).toBe(false);
    expect(a.length).toBe(1075);
  });

  for (const v of vectors.envelopes as Array<Record<string, unknown>>) {
    it(`opens ${v.name as string} as ${v.expect as string}`, () => {
      const run = () =>
        openEnvelope({
          recipientKeys: (v.recipientKeys as string[]).map(hex),
          trustedSenders: (v.trustedSenders as string[]).map(hex),
          apnsToken: hex(v.apnsToken as string),
          envelope: fromBase64Url(v.envelope as string) as Buffer,
          expectedClass: v.expectedClass as EnvelopeClass,
          now: v.now as number,
        });
      if (v.expect === "ok") {
        expect(run()).toEqual(v.plaintext);
      } else {
        expect(run).toThrow(OpenError);
        try {
          run();
        } catch (err) {
          expect((err as OpenError).code).toBe(v.expect);
        }
      }
    });
  }

  const SEEDS = [
    "instanceSeed",
    "instanceRotatedSeed",
    "bindingSeed",
    "relaySeed",
  ];
  const seedFor = (publicKeyB64: string) => {
    const pk = fromBase64Url(publicKeyB64, 32) as Buffer;
    const name = SEEDS.find((s) => ed25519PublicOf(hex(keys[s])).equals(pk));
    if (!name) throw new Error(`no seed for ${publicKeyB64}`);
    return hex(keys[name]);
  };

  const byName = (name: string) =>
    vectors.statements.find((s: { name: string }) => s.name === name);

  it("builds every statement this server signs or checks", () => {
    const host = vectors.constants.host as string;
    const now = vectors.constants.now as number;
    const built: Record<string, string> = {
      register: registerText(
        host,
        ed25519PublicOf(hex(keys.instanceSeed)),
        now,
      ),
      rotateNewKeyProof: registerText(
        host,
        ed25519PublicOf(hex(keys.instanceRotatedSeed)),
        now,
      ),
      request: requestText({
        host,
        instanceId: keys.instanceId,
        method: "POST",
        pathAndQuery: "/v1/push",
        timestamp: now,
        nonce: keys.nonce,
        body: byName("request").body,
      }),
      requestWithQuery: requestText({
        host,
        instanceId: keys.instanceId,
        method: "GET",
        pathAndQuery: "/v1/status?probe=1",
        timestamp: now,
        nonce: keys.nonce,
        body: "",
      }),
      response: responseText({
        host,
        method: "POST",
        pathAndQuery: "/v1/push",
        nonce: keys.nonce,
        status: 200,
        body: byName("response").body,
      }),
      responseAppEndpoint: responseText({
        host,
        method: "DELETE",
        pathAndQuery: "/v1/bindings/self",
        nonce: keys.nonce,
        status: 204,
        body: "",
      }),
      responseWithoutNonce: responseText({
        host,
        method: "GET",
        pathAndQuery: "/healthz",
        nonce: null,
        status: 200,
        body: byName("responseWithoutNonce").body,
      }),
      bind: bindText({
        host,
        instanceId: keys.instanceId,
        tokenTag: tokenTagHex(keys.apnsToken) as string,
        kind: "device",
        seq: 7,
        iat: now,
      }),
      activity: activityText({
        host,
        instanceId: keys.instanceId,
        tokenTag: tokenTagHex(keys.apnsToken) as string,
        laTokenTag: tokenTagHex(keys.laToken) as string,
        iat: now,
      }),
      laStart: laStartText({
        host,
        instanceId: keys.instanceId,
        tokenTag: tokenTagHex(keys.apnsToken) as string,
        startTokenTag: tokenTagHex(keys.laToken) as string,
        iat: now,
      }),
      laConsent: laConsentText({
        host,
        instanceId: keys.instanceId,
        tokenTag: tokenTagHex(keys.apnsToken) as string,
        textVersion: "2026-11-21",
        iat: now,
      }),
      laWithdraw: laWithdrawText({
        host,
        instanceId: keys.instanceId,
        tokenTag: tokenTagHex(keys.apnsToken) as string,
        iat: now,
      }),
    };
    for (const [name, text] of Object.entries(built)) {
      const v = byName(name);
      expect(text, name).toBe(v.text);
      const sig = signText(seedFor(v.publicKey), text);
      expect(sig.toString("base64url"), name).toBe(v.signature);
      expect(
        verifyText(
          fromBase64Url(v.publicKey, 32) as Buffer,
          text,
          fromBase64Url(v.signature, 64) as Buffer,
        ),
      ).toBe(true);
    }
    expect(bodyHashHex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("fails every negative statement", () => {
    for (const n of vectors.negativeStatements as Array<{
      name: string;
      of: string;
      text: string;
    }>) {
      const of = byName(n.of);
      expect(
        verifyText(
          fromBase64Url(of.publicKey, 32) as Buffer,
          n.text,
          fromBase64Url(of.signature, 64) as Buffer,
        ),
        n.name,
      ).toBe(false);
    }
  });
});
