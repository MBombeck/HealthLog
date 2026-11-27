/**
 * The Wallet pass queues report what went wrong instead of passing quietly:
 * a pass that throws or a push Apple refused fails the refresh job, so the
 * queue's backoff retries it and the failure reaches the worker report. The
 * sweep walks every live pass, past one run's page, not the same oldest ones.
 */
import type { Job } from "pg-boss";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  deleteMany: vi.fn(),
}));
const refresh = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({
  prisma: {
    walletPass: {
      findUnique: db.findUnique,
      findMany: db.findMany,
      deleteMany: db.deleteMany,
    },
  },
}));
vi.mock("@/lib/emergency-card/wallet-pass/push", () => ({
  owedRegistrations: () => [],
  pushOwedWalletUpdates: push,
  walletPassChangedAt: () => new Date(),
}));
vi.mock("@/lib/emergency-card/wallet-pass/queues", () => ({
  enqueueWalletPassRefresh: vi.fn(),
}));
vi.mock("@/lib/emergency-card/wallet-pass/ready-push", () => ({
  runWalletReadyPushPass: async () => ({ sent: 0, failed: 0 }),
  sendWalletReadyPush: vi.fn(),
}));
vi.mock("@/lib/emergency-card/wallet-pass/service", () => ({
  refreshWalletPass: refresh,
  voidWalletPassById: vi.fn(),
}));
vi.mock("@/lib/sharing/guardian-minted", () => ({
  guardianMintRefusal: async () => null,
}));

import {
  handleWalletPassRefresh,
  handleWalletPassSweep,
} from "@/lib/jobs/wallet-pass";

const jobs = (...ids: string[]) =>
  ids.map((walletPassId) => ({ data: { walletPassId } }) as Job<never>);
const pushed = (over: Record<string, unknown> = {}) => ({
  owed: 1,
  accepted: 1,
  dropped: 0,
  rejected: 0,
  deferredUntil: null,
  skipped: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.findUnique.mockResolvedValue({
    voidedAt: null,
    link: { revokedAt: null, expiresAt: null },
  });
  db.deleteMany.mockResolvedValue({ count: 0 });
  refresh.mockResolvedValue({ changed: true });
  push.mockResolvedValue(pushed());
});

describe("the Wallet pass refresh job", () => {
  it("succeeds when every pass went out", async () => {
    const outcome = await handleWalletPassRefresh(jobs("p1"));
    expect(outcome.ok).toBe(true);
  });

  it("fails when a pass could not be rebuilt, so the queue retries it", async () => {
    refresh.mockRejectedValueOnce(new Error("card read failed"));
    const outcome = await handleWalletPassRefresh(jobs("p1", "p2"));
    expect(outcome.ok).toBe(false);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("fails when Apple refused a push, and says how many", async () => {
    push.mockResolvedValue(pushed({ accepted: 0, rejected: 2 }));
    const outcome = await handleWalletPassRefresh(jobs("p1"));
    expect(outcome.ok).toBe(false);
    expect(outcome.did).toMatchObject({ wallet_pushes_rejected: 2 });
  });
});

describe("the Wallet pass sweep", () => {
  it("walks every live pass page by page by id, not the same oldest ones", async () => {
    const page = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `p${String(from + i).padStart(5, "0")}`,
        userId: "u",
        createdById: "u",
      }));
    db.findMany
      .mockResolvedValueOnce(page(0, 2000))
      .mockResolvedValueOnce(page(2000, 3));

    const outcome = await handleWalletPassSweep([]);

    expect(outcome.ok).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(2003);
    expect(db.findMany).toHaveBeenCalledTimes(2);
    const [first, second] = db.findMany.mock.calls.map((c) => c[0]);
    expect(first.orderBy).toEqual({ id: "asc" });
    expect(second.cursor).toEqual({ id: "p01999" });
    expect(second.skip).toBe(1);
  });
});
