/**
 * Only a dead token drops a Wallet registration, and only through the
 * breaker (`forgetGoneRegistrations`). A refusal that is about the
 * certificate, the topic, the payload or the provider (the relay's and the
 * local sender's `rejected`) keeps every registration owed and is reported,
 * and so does a stored token that does not decrypt.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
}));
const notify = vi.hoisted(() => vi.fn());
const local = vi.hoisted(() => vi.fn());
const mode = vi.hoisted(() => ({ current: { kind: "relay" } as unknown }));
const forget = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({
  prisma: {
    walletPass: { findUnique: db.findUnique },
    walletPassRegistration: {
      updateMany: db.updateMany,
      deleteMany: db.deleteMany,
    },
  },
}));
vi.mock("@/lib/app-settings", () => ({
  isApiGloballyEnabled: async () => true,
}));
vi.mock("@/lib/crypto", () => ({
  decrypt: (v: string) => {
    if (v === "sealed-under-a-lost-key") throw new Error("unknown key id");
    return v;
  },
}));
vi.mock("@/lib/notifications/gone-registrations", () => ({
  forgetGoneRegistrations: forget,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, resetAt: 0 }),
}));
vi.mock("@/lib/push-relay/wallet", () => ({
  WALLET_NOTIFY_MAX: 50,
  notifyWalletPasses: notify,
}));
vi.mock("../push-local", () => ({ sendLocalPassPushes: local }));
vi.mock("../sign", () => ({ walletSigningMode: () => mode.current }));

import { pushOwedWalletUpdates } from "../push";

const token = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const now = new Date("2026-12-01T10:00:00Z");

function pass(signer: "RELAY" | "LOCAL") {
  return {
    id: "p1",
    signer,
    passTypeIdentifier: "pass.org.example",
    teamIdentifier: "ABCDE12345",
    contentChangedAt: new Date("2026-11-30T10:00:00Z"),
    voidedAt: null,
    link: { revokedAt: null, expiresAt: null },
    registrations: ["a", "b", "c", "d"].map((id, i) => ({
      id,
      pushTokenEncrypted: token(i + 1),
      createdAt: new Date("2026-11-01T10:00:00Z"),
      lastPushAt: null,
    })),
  };
}

const answers = new Map([
  ["a", "accepted"],
  ["b", "unregistered"],
  ["c", "rejected"],
  ["d", "unavailable"],
]);

beforeEach(() => {
  vi.clearAllMocks();
  forget.mockResolvedValue(true);
});

describe.each([
  ["the relay", "RELAY" as const, { kind: "relay" }],
  [
    "the operator's own certificate",
    "LOCAL" as const,
    {
      kind: "local",
      identity: {
        passTypeIdentifier: "pass.org.example",
        teamIdentifier: "ABCDE12345",
      },
    },
  ],
])("a Wallet push over %s", (_label, signer, signingMode) => {
  it("drops only the unregistered token and keeps a rejected one owed", async () => {
    mode.current = signingMode;
    db.findUnique.mockResolvedValue(pass(signer));
    notify.mockResolvedValue(answers);
    local.mockResolvedValue(answers);

    const outcome = await pushOwedWalletUpdates("p1", {
      throttle: false,
      now,
    });

    expect(db.deleteMany).not.toHaveBeenCalled();
    expect(forget).toHaveBeenCalledTimes(1);
    expect(forget).toHaveBeenCalledWith("walletPass", ["b"]);
    expect(db.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["a"] } },
      data: { lastPushAt: now },
    });
    expect(outcome).toMatchObject({ accepted: 1, dropped: 1, rejected: 1 });
  });

  it("drops nothing when Apple refuses every push for the certificate", async () => {
    mode.current = signingMode;
    db.findUnique.mockResolvedValue(pass(signer));
    const all = new Map(["a", "b", "c", "d"].map((r) => [r, "rejected"]));
    notify.mockResolvedValue(all);
    local.mockResolvedValue(all);

    const outcome = await pushOwedWalletUpdates("p1", {
      throttle: false,
      now,
    });

    expect(db.deleteMany).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ dropped: 0, rejected: 4 });
  });

  it("drops nothing when the breaker holds a mass verdict", async () => {
    mode.current = signingMode;
    db.findUnique.mockResolvedValue(pass(signer));
    const all = new Map(["a", "b", "c", "d"].map((r) => [r, "unregistered"]));
    notify.mockResolvedValue(all);
    local.mockResolvedValue(all);
    forget.mockResolvedValue(false);

    const outcome = await pushOwedWalletUpdates("p1", {
      throttle: false,
      now,
    });

    expect(forget).toHaveBeenCalledWith("walletPass", ["a", "b", "c", "d"]);
    expect(db.deleteMany).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ dropped: 0 });
  });

  it("keeps a registration whose token does not decrypt, and counts it", async () => {
    mode.current = signingMode;
    const p = pass(signer);
    p.registrations[1].pushTokenEncrypted = "sealed-under-a-lost-key";
    p.registrations[2].pushTokenEncrypted = "not-a-token";
    db.findUnique.mockResolvedValue(p);
    const sent = new Map([
      ["a", "accepted"],
      ["d", "accepted"],
    ]);
    notify.mockResolvedValue(sent);
    local.mockResolvedValue(sent);

    const outcome = await pushOwedWalletUpdates("p1", {
      throttle: false,
      now,
    });

    // Neither is sent, neither is deleted, both stay owed.
    const items = (signer === "RELAY" ? notify : local).mock.calls[0].at(-1);
    expect(items.map((i: { ref: string }) => i.ref)).toEqual(["a", "d"]);
    expect(forget).not.toHaveBeenCalled();
    expect(db.deleteMany).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ accepted: 2, dropped: 0, unreadable: 2 });
  });
});
