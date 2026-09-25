/**
 * Wire contract between HealthLog and `@simplewebauthn/server`, exercised
 * against the real library rather than a mock.
 *
 * Every other passkey test mocks the library, so a major bump of it would
 * pass them all while changing what a browser or the iOS app receives, or
 * which credentials the server accepts. This file pins the three things a
 * library upgrade must not move:
 *
 * 1. The JSON the option endpoints return (challenge and user handle are
 *    random and are masked; every other field is compared verbatim).
 * 2. The algorithm set: registration offers EdDSA / ES256 / RS256 and
 *    verification accepts every algorithm the server has ever accepted, so a
 *    credential that registered before an upgrade still registers after it.
 * 3. Stored credentials: a key derived from a fixed seed must produce the
 *    same stored public-key bytes, and an assertion from it must verify
 *    through the same code path login and step-up use.
 *
 * The authenticator is a software one: it builds `fmt: "none"` attestation
 * objects and signs assertions with Node's crypto, the way a platform
 * authenticator would.
 */
import {
  createECDH,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  constants as cryptoConstants,
  type KeyObject,
} from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { NextRequest } from "next/server";
import { isoCBOR } from "@simplewebauthn/server/helpers";

// ── In-memory stand-in for the four tables the ceremonies touch ──────

const store = vi.hoisted(() => ({
  authChallenge: new Map<string, Record<string, unknown>>(),
  passkey: new Map<string, Record<string, unknown>>(),
  mfa: new Map<string, Record<string, unknown>>(),
  seq: 0,
}));

vi.mock("@/lib/db", () => {
  const byCredential = (
    table: Map<string, Record<string, unknown>>,
    credentialId: unknown,
  ) => [...table.values()].find((r) => r.credentialId === credentialId) ?? null;
  return {
    prisma: {
      authChallenge: {
        deleteMany: async () => ({ count: 0 }),
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const id = `challenge-${++store.seq}`;
          const row = { id, ...data };
          store.authChallenge.set(id, row);
          return row;
        },
        findUnique: async ({ where }: { where: { id: string } }) =>
          store.authChallenge.get(where.id) ?? null,
        delete: async ({ where }: { where: { id: string } }) => {
          store.authChallenge.delete(where.id);
          return {};
        },
      },
      passkey: {
        findMany: async ({ where }: { where: { userId: string } }) =>
          [...store.passkey.values()].filter((r) => r.userId === where.userId),
        findUnique: async ({ where }: { where: { credentialId: string } }) =>
          byCredential(store.passkey, where.credentialId),
        update: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => Object.assign(store.passkey.get(where.id) ?? {}, data),
      },
      webauthnMfaCredential: {
        findMany: async ({ where }: { where: { userId: string } }) =>
          [...store.mfa.values()].filter((r) => r.userId === where.userId),
        findFirst: async ({
          where,
        }: {
          where: { credentialId: string; userId: string };
        }) => {
          const row = byCredential(store.mfa, where.credentialId);
          return row && row.userId === where.userId ? row : null;
        },
        update: async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => Object.assign(store.mfa.get(where.id) ?? {}, data),
      },
    },
  };
});

vi.mock("@/lib/rate-limit", () => ({
  checkAuthSurfaceRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 9,
    reset: 0,
    ip: "203.0.113.1",
  }),
  rateLimitHeaders: vi.fn(() => ({})),
}));

import {
  createAuthenticationOptions,
  createRegistrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from "../passkey";
import {
  createMfaAuthenticationOptions,
  createMfaRegistrationOptions,
  verifyMfaAuthentication,
} from "../mfa/webauthn";
import { POST as LOGIN_OPTIONS } from "@/app/api/auth/passkey/login-options/route";

const ORIGIN = "https://health.example.test";
const RP_ID = "health.example.test";
const USER_ID = "user-contract";

let savedAppUrl: string | undefined;
let savedPublicUrl: string | undefined;
let savedHmacKey: string | undefined;

beforeAll(() => {
  savedAppUrl = process.env.APP_URL;
  savedPublicUrl = process.env.NEXT_PUBLIC_APP_URL;
  process.env.APP_URL = ORIGIN;
  delete process.env.NEXT_PUBLIC_APP_URL;
  savedHmacKey = process.env.API_TOKEN_HMAC_KEY;
  process.env.API_TOKEN_HMAC_KEY ??= "contract-test-hmac-key-".padEnd(64, "x");
});

afterAll(() => {
  if (savedAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedAppUrl;
  if (savedPublicUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = savedPublicUrl;
  if (savedHmacKey === undefined) delete process.env.API_TOKEN_HMAC_KEY;
  else process.env.API_TOKEN_HMAC_KEY = savedHmacKey;
});

beforeEach(() => {
  store.authChallenge.clear();
  store.passkey.clear();
  store.mfa.clear();
  store.seq = 0;
});

// ── Software authenticator ───────────────────────────────────────────

const b64url = (buf: Uint8Array) => Buffer.from(buf).toString("base64url");
const sha256 = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest();

type Alg = {
  alg: number;
  name: string;
  keyPair: () => { privateKey: KeyObject; publicKey: KeyObject };
  cose: (publicKey: KeyObject) => Map<number, number | Uint8Array>;
  sign: (privateKey: KeyObject, data: Buffer) => Buffer;
};

function ec2Cose(alg: number, crv: number) {
  return (publicKey: KeyObject) => {
    const jwk = publicKey.export({ format: "jwk" });
    return new Map<number, number | Uint8Array>([
      [1, 2],
      [3, alg],
      [-1, crv],
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]);
  };
}

function rsaCose(alg: number) {
  return (publicKey: KeyObject) => {
    const jwk = publicKey.export({ format: "jwk" });
    return new Map<number, number | Uint8Array>([
      [1, 3],
      [3, alg],
      [-1, Buffer.from(jwk.n!, "base64url")],
      [-2, Buffer.from(jwk.e!, "base64url")],
    ]);
  };
}

const rsaKeys = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const pss = (hash: string, saltLength: number) => (k: KeyObject, d: Buffer) =>
  sign(hash, d, {
    key: k,
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
    saltLength,
  });
const pkcs1 = (hash: string) => (k: KeyObject, d: Buffer) => sign(hash, d, k);

/** Every COSE algorithm the 13.x verifier accepted by default. */
const LEGACY_ALGS: Alg[] = [
  {
    alg: -8,
    name: "EdDSA",
    keyPair: () => generateKeyPairSync("ed25519"),
    cose: (publicKey) => {
      const jwk = publicKey.export({ format: "jwk" });
      return new Map<number, number | Uint8Array>([
        [1, 1],
        [3, -8],
        [-1, 6],
        [-2, Buffer.from(jwk.x!, "base64url")],
      ]);
    },
    sign: (k, d) => sign(null, d, k),
  },
  {
    alg: -7,
    name: "ES256",
    keyPair: () => generateKeyPairSync("ec", { namedCurve: "P-256" }),
    cose: ec2Cose(-7, 1),
    sign: (k, d) => sign("sha256", d, k),
  },
  {
    alg: -36,
    name: "ES512",
    keyPair: () => generateKeyPairSync("ec", { namedCurve: "P-521" }),
    cose: ec2Cose(-36, 3),
    sign: (k, d) => sign("sha512", d, k),
  },
  {
    alg: -37,
    name: "PS256",
    keyPair: rsaKeys,
    cose: rsaCose(-37),
    sign: pss("sha256", 32),
  },
  {
    alg: -38,
    name: "PS384",
    keyPair: rsaKeys,
    cose: rsaCose(-38),
    sign: pss("sha384", 48),
  },
  {
    alg: -39,
    name: "PS512",
    keyPair: rsaKeys,
    cose: rsaCose(-39),
    sign: pss("sha512", 64),
  },
  {
    alg: -257,
    name: "RS256",
    keyPair: rsaKeys,
    cose: rsaCose(-257),
    sign: pkcs1("sha256"),
  },
  {
    alg: -258,
    name: "RS384",
    keyPair: rsaKeys,
    cose: rsaCose(-258),
    sign: pkcs1("sha384"),
  },
  {
    alg: -259,
    name: "RS512",
    keyPair: rsaKeys,
    cose: rsaCose(-259),
    sign: pkcs1("sha512"),
  },
  {
    alg: -65535,
    name: "RS1",
    keyPair: rsaKeys,
    cose: rsaCose(-65535),
    sign: pkcs1("sha1"),
  },
];

const ES256 = LEGACY_ALGS.find((a) => a.alg === -7)!;

function clientData(type: string, challenge: string) {
  return Buffer.from(
    JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }),
  );
}

function registrationResponse(
  challenge: string,
  credentialId: Buffer,
  cosePublicKey: Map<number, number | Uint8Array>,
  transports: string[],
) {
  const coseBytes = isoCBOR.encode(cosePublicKey);
  const counter = Buffer.alloc(4);
  const idLength = Buffer.alloc(2);
  idLength.writeUInt16BE(credentialId.length);
  const authData = Buffer.concat([
    sha256(RP_ID),
    Buffer.from([0x45]), // UP | UV | AT
    counter,
    Buffer.alloc(16), // AAGUID, all zero under "none" attestation
    idLength,
    credentialId,
    Buffer.from(coseBytes),
  ]);
  const attestationObject = isoCBOR.encode(
    new Map<string, unknown>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authData],
    ]) as never,
  );
  return {
    id: b64url(credentialId),
    rawId: b64url(credentialId),
    type: "public-key",
    response: {
      clientDataJSON: b64url(clientData("webauthn.create", challenge)),
      attestationObject: b64url(attestationObject),
      transports,
    },
    clientExtensionResults: {},
  };
}

function assertionResponse(
  challenge: string,
  credentialId: Buffer,
  alg: Alg,
  privateKey: KeyObject,
  signCount: number,
) {
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(signCount);
  const authData = Buffer.concat([
    sha256(RP_ID),
    Buffer.from([0x05]), // UP | UV
    counter,
  ]);
  const cdj = clientData("webauthn.get", challenge);
  const signature = alg.sign(
    privateKey,
    Buffer.concat([authData, sha256(cdj)]),
  );
  return {
    id: b64url(credentialId),
    rawId: b64url(credentialId),
    type: "public-key",
    response: {
      clientDataJSON: b64url(cdj),
      authenticatorData: b64url(authData),
      signature: b64url(signature),
    },
    clientExtensionResults: {},
  };
}

/** Mask the random parts of an options object; keep everything else. */
function normalise(options: Record<string, unknown>) {
  const out = structuredClone(options) as Record<string, unknown> & {
    user?: { id: string };
  };
  expect(out.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  out.challenge = "<32 random bytes, base64url>";
  if (out.user) {
    expect(out.user.id).toMatch(/^[A-Za-z0-9_-]+$/);
    out.user.id = "<random user handle, base64url>";
  }
  return out;
}

/** Register a credential through the real verifier and store it as the route does. */
async function registerPasskey(
  alg: Alg,
  keys: { privateKey: KeyObject; publicKey: KeyObject },
  credentialId: Buffer,
) {
  const { options } = await createRegistrationOptions(
    USER_ID,
    "user@example.test",
    "sess-1",
  );
  const verification = await verifyRegistration(
    options.challenge,
    registrationResponse(
      options.challenge,
      credentialId,
      alg.cose(keys.publicKey),
      ["internal", "hybrid"],
    ),
  );
  expect(verification.verified).toBe(true);
  const info = verification.registrationInfo!;
  const id = `pk-${++store.seq}`;
  store.passkey.set(id, {
    id,
    userId: USER_ID,
    credentialId: info.credential.id,
    credentialPublicKey: Buffer.from(info.credential.publicKey),
    counter: BigInt(info.credential.counter),
    transports: ["internal", "hybrid"],
  });
  return verification;
}

// ── 1. Option shapes ─────────────────────────────────────────────────

describe("option shapes returned to the web client and the iOS app", () => {
  it("passkey registration options", async () => {
    store.passkey.set("existing", {
      id: "existing",
      userId: USER_ID,
      credentialId: "ZXhpc3RpbmctY3JlZA",
      transports: ["internal", "hybrid"],
    });
    const { options } = await createRegistrationOptions(
      USER_ID,
      "user@example.test",
      "sess-1",
    );
    expect(normalise(options as never)).toMatchInlineSnapshot(`
      {
        "attestation": "none",
        "authenticatorSelection": {
          "requireResidentKey": false,
          "residentKey": "preferred",
          "userVerification": "required",
        },
        "challenge": "<32 random bytes, base64url>",
        "excludeCredentials": [
          {
            "id": "ZXhpc3RpbmctY3JlZA",
            "transports": [
              "internal",
              "hybrid",
            ],
            "type": "public-key",
          },
        ],
        "extensions": {
          "credProps": true,
        },
        "hints": [],
        "pubKeyCredParams": [
          {
            "alg": -8,
            "type": "public-key",
          },
          {
            "alg": -7,
            "type": "public-key",
          },
          {
            "alg": -257,
            "type": "public-key",
          },
        ],
        "rp": {
          "id": "health.example.test",
          "name": "HealthLog",
        },
        "timeout": 60000,
        "user": {
          "displayName": "",
          "id": "<random user handle, base64url>",
          "name": "user@example.test",
        },
      }
    `);
  });

  it("passkey authentication options, discoverable (login-options route body)", async () => {
    const res = await LOGIN_OPTIONS(
      new NextRequest(`${ORIGIN}/api/auth/passkey/login-options`, {
        method: "POST",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { options: Record<string, unknown>; challengeId: string };
      error: null;
    };
    expect(Object.keys(body).sort()).toEqual(["data", "error"]);
    expect(Object.keys(body.data).sort()).toEqual(["challengeId", "options"]);
    expect(normalise(body.data.options)).toMatchInlineSnapshot(`
      {
        "challenge": "<32 random bytes, base64url>",
        "rpId": "health.example.test",
        "timeout": 60000,
        "userVerification": "required",
      }
    `);
  });

  it("passkey authentication options scoped to a user (step-up)", async () => {
    store.passkey.set("existing", {
      id: "existing",
      userId: USER_ID,
      credentialId: "ZXhpc3RpbmctY3JlZA",
      transports: ["internal", "hybrid"],
    });
    const { options } = await createAuthenticationOptions(USER_ID);
    expect(normalise(options as never)).toMatchInlineSnapshot(`
      {
        "allowCredentials": [
          {
            "id": "ZXhpc3RpbmctY3JlZA",
            "transports": [
              "internal",
              "hybrid",
            ],
            "type": "public-key",
          },
        ],
        "challenge": "<32 random bytes, base64url>",
        "extensions": undefined,
        "rpId": "health.example.test",
        "timeout": 60000,
        "userVerification": "required",
      }
    `);
  });

  it("security-key registration and authentication options", async () => {
    store.mfa.set("key", {
      id: "key",
      userId: USER_ID,
      credentialId: "c2VjdXJpdHkta2V5",
      transports: ["usb", "nfc"],
    });
    const reg = await createMfaRegistrationOptions(
      USER_ID,
      "user@example.test",
    );
    const auth = await createMfaAuthenticationOptions(USER_ID);
    expect(normalise(reg.options as never)).toMatchInlineSnapshot(`
      {
        "attestation": "none",
        "authenticatorSelection": {
          "authenticatorAttachment": "cross-platform",
          "requireResidentKey": false,
          "residentKey": "discouraged",
          "userVerification": "required",
        },
        "challenge": "<32 random bytes, base64url>",
        "excludeCredentials": [
          {
            "id": "c2VjdXJpdHkta2V5",
            "transports": [
              "usb",
              "nfc",
            ],
            "type": "public-key",
          },
        ],
        "extensions": {
          "credProps": true,
        },
        "hints": [],
        "pubKeyCredParams": [
          {
            "alg": -8,
            "type": "public-key",
          },
          {
            "alg": -7,
            "type": "public-key",
          },
          {
            "alg": -257,
            "type": "public-key",
          },
        ],
        "rp": {
          "id": "health.example.test",
          "name": "HealthLog",
        },
        "timeout": 60000,
        "user": {
          "displayName": "",
          "id": "<random user handle, base64url>",
          "name": "user@example.test",
        },
      }
    `);
    expect(normalise(auth!.options as never)).toMatchInlineSnapshot(`
      {
        "allowCredentials": [
          {
            "id": "c2VjdXJpdHkta2V5",
            "transports": [
              "usb",
              "nfc",
            ],
            "type": "public-key",
          },
        ],
        "challenge": "<32 random bytes, base64url>",
        "extensions": undefined,
        "rpId": "health.example.test",
        "timeout": 60000,
        "userVerification": "required",
      }
    `);
  });
});

// ── 2. Algorithm set ─────────────────────────────────────────────────

describe("algorithm set", () => {
  it.each(LEGACY_ALGS.map((a) => [a.name, a] as const))(
    "%s registers and then authenticates",
    async (_name, alg) => {
      const keys = alg.keyPair();
      const credentialId = randomBytes(16);
      const registration = await registerPasskey(alg, keys, credentialId);
      expect(registration.registrationInfo!.credential.id).toBe(
        b64url(credentialId),
      );

      const { options, challengeId } = await createAuthenticationOptions();
      const { verification, passkey } = await verifyAuthentication(
        challengeId,
        assertionResponse(
          options.challenge,
          credentialId,
          alg,
          keys.privateKey,
          1,
        ),
      );
      expect(verification.verified).toBe(true);
      expect(passkey.userId).toBe(USER_ID);
    },
  );
});

// ── 3. Stored credentials ────────────────────────────────────────────

/** A P-256 key derived from a fixed seed, so its stored bytes are stable. */
function fixedEs256Key() {
  const d = sha256("healthlog-webauthn-contract-fixture");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey(); // 0x04 | x | y
  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: d.toString("base64url"),
    x: pub.subarray(1, 33).toString("base64url"),
    y: pub.subarray(33, 65).toString("base64url"),
  };
  const privateKey = createPrivateKey({ key: jwk, format: "jwk" });
  const { d: _d, ...publicJwk } = jwk;
  const publicKey = createPublicKey({ key: publicJwk, format: "jwk" });
  return { privateKey, publicKey };
}

describe("stored credentials", () => {
  it("stores the same public-key bytes and verification fields for a fixed key", async () => {
    const keys = fixedEs256Key();
    const credentialId = Buffer.from("fixed-credential-id");
    const verification = await registerPasskey(ES256, keys, credentialId);
    const info = verification.registrationInfo!;
    expect({
      verified: verification.verified,
      credentialId: info.credential.id,
      publicKeyHex: Buffer.from(info.credential.publicKey).toString("hex"),
      counter: info.credential.counter,
      transports: info.credential.transports,
      fmt: info.fmt,
      aaguid: info.aaguid,
      credentialType: info.credentialType,
      credentialDeviceType: info.credentialDeviceType,
      credentialBackedUp: info.credentialBackedUp,
      userVerified: info.userVerified,
      origin: info.origin,
      rpID: info.rpID,
      registrationInfoKeys: Object.keys(info).sort(),
    }).toMatchInlineSnapshot(`
      {
        "aaguid": "00000000-0000-0000-0000-000000000000",
        "counter": 0,
        "credentialBackedUp": false,
        "credentialDeviceType": "singleDevice",
        "credentialId": "Zml4ZWQtY3JlZGVudGlhbC1pZA",
        "credentialType": "public-key",
        "fmt": "none",
        "origin": "https://health.example.test",
        "publicKeyHex": "a50102032620012158202a40dff8de2ee1ba264ae10e05136e3933839a3bf5a24fb40672a2fb90bccf722258205508587675cda220cac807aa2bb93596dc3ce76590eb728fab4d00dbda17d4b4",
        "registrationInfoKeys": [
          "aaguid",
          "attestationObject",
          "authenticatorExtensionResults",
          "credential",
          "credentialBackedUp",
          "credentialDeviceType",
          "credentialType",
          "fmt",
          "origin",
          "rpID",
          "userVerified",
        ],
        "rpID": "health.example.test",
        "transports": [
          "internal",
          "hybrid",
        ],
        "userVerified": true,
        "verified": true,
      }
    `);
  });

  it("verifies an assertion against a credential stored before the upgrade", async () => {
    const keys = fixedEs256Key();
    const credentialId = Buffer.from("fixed-credential-id");
    const cose = isoCBOR.encode(ES256.cose(keys.publicKey));
    // The row exactly as an earlier release wrote it: raw COSE bytes, a
    // non-zero counter and the transports the browser reported.
    store.passkey.set("legacy", {
      id: "legacy",
      userId: USER_ID,
      credentialId: b64url(credentialId),
      credentialPublicKey: Buffer.from(cose),
      counter: BigInt(7),
      transports: ["internal", "hybrid"],
    });

    const { options, challengeId } = await createAuthenticationOptions(USER_ID);
    const { verification } = await verifyAuthentication(
      challengeId,
      assertionResponse(
        options.challenge,
        credentialId,
        ES256,
        keys.privateKey,
        8,
      ),
    );
    expect({
      verified: verification.verified,
      authenticationInfo: {
        ...verification.authenticationInfo,
        credentialID: verification.authenticationInfo.credentialID,
      },
    }).toMatchInlineSnapshot(`
      {
        "authenticationInfo": {
          "authenticatorExtensionResults": undefined,
          "credentialBackedUp": false,
          "credentialDeviceType": "singleDevice",
          "credentialID": "Zml4ZWQtY3JlZGVudGlhbC1pZA",
          "newCounter": 8,
          "origin": "https://health.example.test",
          "rpID": "health.example.test",
          "userVerified": true,
        },
        "verified": true,
      }
    `);
    expect(store.passkey.get("legacy")!.counter).toBe(BigInt(8));
  });

  it("verifies a security-key assertion against a stored second-factor credential", async () => {
    const keys = fixedEs256Key();
    const credentialId = Buffer.from("fixed-security-key");
    store.mfa.set("legacy-key", {
      id: "legacy-key",
      userId: USER_ID,
      credentialId: b64url(credentialId),
      credentialPublicKey: Buffer.from(
        isoCBOR.encode(ES256.cose(keys.publicKey)),
      ),
      counter: BigInt(0),
      transports: ["usb"],
    });
    const { options, challengeId } =
      (await createMfaAuthenticationOptions(USER_ID))!;
    const ok = await verifyMfaAuthentication(
      challengeId,
      USER_ID,
      assertionResponse(
        options.challenge,
        credentialId,
        ES256,
        keys.privateKey,
        1,
      ),
    );
    expect(ok).toBe(true);
  });
});
