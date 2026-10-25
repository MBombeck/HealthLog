import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createReaderQueue, type ReaderTicket } from "../reader-queue";

/**
 * The document reader has one slot. It used to go to whoever asked first,
 * and a waiting item waited without end: a few heavy PDFs from one account
 * held every other account's lab scan behind them. These pin the order the
 * slot is handed out in, the cap on what one account may queue, and the
 * deadline a waiting item gets.
 */

const WAIT = { interactive: 1_000, background: 5_000 };

function queue(maxQueuedPerOwner = 10) {
  return createReaderQueue({ slots: 1, maxQueuedPerOwner, waitMs: WAIT });
}

/** Acquire, and note the order in which tickets are granted. */
function recorder() {
  const order: string[] = [];
  const tickets = new Map<string, ReaderTicket>();
  const track = (label: string, pending: Promise<ReaderTicket>) =>
    pending.then((ticket) => {
      if (ticket.ok) order.push(label);
      tickets.set(label, ticket);
      return ticket;
    });
  const release = (label: string) => {
    const ticket = tickets.get(label);
    if (ticket?.ok) ticket.release();
  };
  return { order, track, release };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("the reader queue", () => {
  it("takes accounts in turn instead of first come, first served", async () => {
    const q = queue();
    const r = recorder();
    void r.track("a1", q.acquire("a", "background"));
    void r.track("a2", q.acquire("a", "background"));
    void r.track("a3", q.acquire("a", "background"));
    void r.track("b1", q.acquire("b", "background"));
    void r.track("c1", q.acquire("c", "background"));
    await flush();
    for (const label of ["a1", "a2", "b1", "c1", "a3"]) {
      r.release(label);
      await flush();
    }
    // a1 held the slot. Of the waiting items a2 came first, then b and c
    // each get their turn before a's third item comes round.
    expect(r.order).toEqual(["a1", "a2", "b1", "c1", "a3"]);
  });

  it("serves a read a person is waiting on before background work", async () => {
    const q = queue();
    const r = recorder();
    void r.track("bg-running", q.acquire("a", "background"));
    void r.track("bg-a", q.acquire("a", "background"));
    void r.track("bg-b", q.acquire("b", "background"));
    void r.track("lab-scan", q.acquire("c", "interactive"));
    await flush();
    r.release("bg-running");
    await flush();
    expect(r.order).toEqual(["bg-running", "lab-scan"]);
  });

  it("refuses an account's item past its waiting cap at once, without touching others", async () => {
    const q = queue(2);
    const r = recorder();
    await r.track("a-running", q.acquire("a", "interactive"));
    void r.track("a-1", q.acquire("a", "interactive"));
    void r.track("a-2", q.acquire("a", "background"));
    await expect(q.acquire("a", "interactive")).resolves.toMatchObject({
      ok: false,
      reason: "queue-full",
    });
    // Another account still gets in line, and its turn comes before the
    // capped account's second waiting item.
    void r.track("b-1", q.acquire("b", "interactive"));
    expect(q.snapshot().waiting).toEqual({ interactive: 2, background: 1 });
    for (const label of ["a-running", "a-1"]) {
      r.release(label);
      await flush();
    }
    expect(r.order).toEqual(["a-running", "a-1", "b-1"]);
    r.release("b-1");
    await flush();
    expect(r.order.at(-1)).toBe("a-2");
    r.release("a-2");
  });

  describe("with a deadline", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("answers a waiting item busy when its lane's deadline passes, and keeps the slot for the next", async () => {
      const q = queue();
      const held = await q.acquire("a", "background");
      const waiting = q.acquire("b", "interactive");
      const later = q.acquire("c", "background");

      await vi.advanceTimersByTimeAsync(WAIT.interactive + 1);
      await expect(waiting).resolves.toEqual({
        ok: false,
        reason: "wait-expired",
        retryAfterMs: WAIT.interactive,
      });
      expect(q.snapshot()).toEqual({
        running: 1,
        waiting: { interactive: 0, background: 1 },
      });

      // The expired item left the queue: releasing hands the slot to the
      // next one in line, not to nobody.
      if (held.ok) held.release();
      await expect(later).resolves.toMatchObject({ ok: true });
    });

    it("releases a slot once, however often release is called", async () => {
      const q = queue();
      const first = await q.acquire("a", "background");
      if (!first.ok) throw new Error("expected the slot");
      first.release();
      first.release();
      expect(q.snapshot().running).toBe(0);
      const a = await q.acquire("a", "background");
      expect(a.ok).toBe(true);
      expect(q.snapshot().running).toBe(1);
    });
  });
});
