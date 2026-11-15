/**
 * Wire contract between HealthLog and `web-push`, exercised against the real
 * library rather than a mock.
 *
 * Every sender test mocks `web-push`, so a major bump of it would pass them
 * all while changing what a push service receives. The sender only borrows
 * three functions from the library (`generateVAPIDKeys`, `setVapidDetails`,
 * `generateRequestDetails`) and dials the result itself through `safeFetch`,
 * so this file pins what those three must keep doing:
 *
 * 1. They are reachable on the namespace a dynamic `import("web-push")`
 *    returns, which is how the sender and the VAPID route load the library.
 * 2. A VAPID key pair stored before an upgrade is still accepted, and a fresh
 *    one has the same shape.
 * 3. The request a subscription gets: method, the RFC 8030 headers (TTL,
 *    Urgency, aes128gcm encoding), a VAPID `Authorization` whose JWT verifies
 *    against the public key and names the endpoint's origin, and a body the
 *    subscriber's keys decrypt back to the exact payload (RFC 8291).
 */
import {
  createECDH,
  createHash,
  createDecipheriv,
  createHmac,
  createPublicKey,
  randomBytes,
  verify,
} from "node:crypto";
import { describe, expect, it } from "vitest";

const ENDPOINT = "https://push.example.test/send/abc123?x=1";
const SUBJECT = "mailto:operator@example.test";

/** A P-256 key pair from a fixed seed, so its encoded form is stable. */
function fixedVapidKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(createHash("sha256").update("healthlog-vapid").digest());
  return {
    publicKey: ecdh.getPublicKey().toString("base64url"),
    privateKey: ecdh.getPrivateKey().toString("base64url"),
  };
}

/** A browser-side subscription: its own P-256 key pair plus an auth secret. */
function subscriber() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    auth,
    subscription: {
      endpoint: ENDPOINT,
      keys: {
        p256dh: ecdh.getPublicKey().toString("base64url"),
        auth: auth.toString("base64url"),
      },
    },
  };
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** RFC 8291 / RFC 8188 decryption of a single-record aes128gcm body. */
function decryptAes128gcm(
  body: Buffer,
  ecdh: ReturnType<typeof createECDH>,
  auth: Buffer,
) {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const idLength = body[20]!;
  const serverPublic = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  expect(record.length).toBeLessThanOrEqual(recordSize);

  const shared = ecdh.computeSecret(serverPublic);
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    ecdh.getPublicKey(),
    serverPublic,
  ]);
  const ikm = hmac(
    hmac(auth, shared),
    Buffer.concat([keyInfo, Buffer.from([1])]),
  );
  const prk = hmac(salt, ikm);
  const cek = hmac(
    prk,
    Buffer.from("Content-Encoding: aes128gcm\0\x01"),
  ).subarray(0, 16);
  const nonce = hmac(
    prk,
    Buffer.from("Content-Encoding: nonce\0\x01"),
  ).subarray(0, 12);

  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([
    decipher.update(record.subarray(0, record.length - 16)),
    decipher.final(),
  ]);
  // The last record ends in the 0x02 delimiter followed by zero padding.
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  expect(padded[end]).toBe(2);
  return padded.subarray(0, end).toString("utf8");
}

function verifyVapidJwt(jwt: string, publicKeyB64: string) {
  const [header, claims, signature] = jwt.split(".");
  const point = Buffer.from(publicKeyB64, "base64url");
  const key = createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });
  const valid = verify(
    "sha256",
    Buffer.from(`${header}.${claims}`),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature!, "base64url"),
  );
  return {
    valid,
    header: JSON.parse(Buffer.from(header!, "base64url").toString()),
    claims: JSON.parse(Buffer.from(claims!, "base64url").toString()),
  };
}

type RequestDetails = {
  endpoint: string;
  method: string;
  headers: Record<string, string | number>;
  body: Buffer | null;
};

describe("web-push library contract", () => {
  it("exposes the three functions on the dynamically imported namespace", async () => {
    const webpush = await import("web-push");
    expect(typeof webpush.generateVAPIDKeys).toBe("function");
    expect(typeof webpush.setVapidDetails).toBe("function");
    expect(typeof webpush.generateRequestDetails).toBe("function");
  });

  it("accepts a stored VAPID pair and mints new ones of the same shape", async () => {
    const webpush = await import("web-push");
    const stored = fixedVapidKeys();
    expect(() =>
      webpush.setVapidDetails(SUBJECT, stored.publicKey, stored.privateKey),
    ).not.toThrow();

    const fresh = webpush.generateVAPIDKeys();
    expect(Buffer.from(fresh.publicKey, "base64url")).toHaveLength(65);
    expect(Buffer.from(fresh.privateKey, "base64url")).toHaveLength(32);
    expect(fresh.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fresh.privateKey).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("builds a signed, encrypted request the subscriber can open", async () => {
    const webpush = await import("web-push");
    const vapid = fixedVapidKeys();
    webpush.setVapidDetails(SUBJECT, vapid.publicKey, vapid.privateKey);
    const { ecdh, auth, subscription } = subscriber();
    const payload = JSON.stringify({
      title: "Reminder",
      body: "Täglich 08:00",
    });

    const details = webpush.generateRequestDetails(
      subscription,
      payload,
    ) as unknown as RequestDetails;

    expect(details.endpoint).toBe(ENDPOINT);
    expect(details.method).toBe("POST");
    expect(Object.keys(details.headers).sort()).toEqual([
      "Authorization",
      "Content-Encoding",
      "Content-Length",
      "Content-Type",
      "TTL",
      "Urgency",
    ]);
    // The sender passes no TTL, so the library default is what a push
    // service is told to hold an undelivered reminder for: four weeks.
    expect(String(details.headers.TTL)).toBe("2419200");
    expect(details.headers.Urgency).toBe("normal");
    expect(details.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(details.headers["Content-Type"]).toBe("application/octet-stream");
    expect(Buffer.isBuffer(details.body)).toBe(true);
    expect(Number(details.headers["Content-Length"])).toBe(
      details.body!.length,
    );

    const auth_ = String(details.headers.Authorization);
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(auth_);
    expect(match).not.toBeNull();
    expect(match![2]).toBe(vapid.publicKey);
    const jwt = verifyVapidJwt(match![1]!, vapid.publicKey);
    expect(jwt.valid).toBe(true);
    expect(jwt.header).toEqual({ typ: "JWT", alg: "ES256" });
    expect(jwt.claims.aud).toBe("https://push.example.test");
    expect(jwt.claims.sub).toBe(SUBJECT);
    const now = Math.floor(Date.now() / 1000);
    expect(jwt.claims.exp).toBeGreaterThan(now);
    expect(jwt.claims.exp).toBeLessThanOrEqual(now + 24 * 60 * 60);

    expect(decryptAes128gcm(details.body!, ecdh, auth)).toBe(payload);
  });

  it("carries the Urgency the sender asks for on an urgent event", async () => {
    const webpush = await import("web-push");
    const vapid = fixedVapidKeys();
    webpush.setVapidDetails(SUBJECT, vapid.publicKey, vapid.privateKey);
    const { subscription } = subscriber();

    const details = webpush.generateRequestDetails(subscription, "{}", {
      urgency: "high",
    }) as unknown as RequestDetails;

    expect(details.headers.Urgency).toBe("high");
  });
});
