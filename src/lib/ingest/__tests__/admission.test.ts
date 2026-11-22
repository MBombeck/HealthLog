/**
 * The heavy-ingest gate: how many run at once, who waits, and what a request
 * that cannot get a slot is told.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetIngestAdmissionForTests,
  admitIngest,
  INGEST_MAX_QUEUED_PER_CALLER,
  INGEST_MAX_WAIT_MS,
  INGEST_SLOTS,
  INGEST_SLOTS_PER_CALLER,
  ingestAdmissionState,
  ingestCallerKey,
  withIngestAdmission,
} from "../admission";

afterEach(() => {
  __resetIngestAdmissionForTests();
  vi.useRealTimers();
});

function request(credential: string): Request {
  return new Request("http://localhost/api/measurements/batch", {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
  });
}

/** A handler that holds its slot until `release()` is called. */
function heldHandler() {
  const waiting: Array<() => void> = [];
  let running = 0;
  let maxRunning = 0;
  const handler = vi.fn(async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise<void>((resolve) => waiting.push(resolve));
    running -= 1;
    return new Response("{}", { status: 200 });
  });
  return {
    handler,
    releaseOne: () => waiting.shift()?.(),
    get maxRunning() {
      return maxRunning;
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

describe("withIngestAdmission", () => {
  it("never runs more than the process's slots, over every caller", async () => {
    const held = heldHandler();
    const wrapped = withIngestAdmission(held.handler);
    const responses = Array.from({ length: INGEST_SLOTS * 3 }, (_, i) =>
      wrapped(request(`caller-${i}`)),
    );
    await tick();
    expect(held.maxRunning).toBe(INGEST_SLOTS);
    for (let i = 0; i < INGEST_SLOTS * 3; i++) {
      held.releaseOne();
      await tick();
    }
    const statuses = (await Promise.all(responses)).map((r) => r.status);
    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(held.maxRunning).toBe(INGEST_SLOTS);
    expect(ingestAdmissionState()).toEqual({ running: 0, queued: 0 });
  });

  it("holds one caller to its share and lets another caller past it", async () => {
    const held = heldHandler();
    const wrapped = withIngestAdmission(held.handler);
    const mine = Array.from({ length: INGEST_SLOTS_PER_CALLER + 1 }, () =>
      wrapped(request("phone")),
    );
    await tick();
    expect(held.handler).toHaveBeenCalledTimes(INGEST_SLOTS_PER_CALLER);
    // Another account's single batch does not wait behind the phone's line.
    const theirs = wrapped(request("other-phone"));
    await tick();
    expect(held.handler).toHaveBeenCalledTimes(INGEST_SLOTS_PER_CALLER + 1);
    for (let i = 0; i < INGEST_SLOTS_PER_CALLER + 2; i++) {
      held.releaseOne();
      await tick();
    }
    await Promise.all([...mine, theirs]);
  });

  it("answers 429 with Retry-After and X-RateLimit-Reset once the wait runs out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const held = heldHandler();
    const wrapped = withIngestAdmission(held.handler);
    const running = Array.from({ length: INGEST_SLOTS_PER_CALLER }, () =>
      wrapped(request("phone")),
    );
    const waiting = wrapped(request("phone"));
    await vi.advanceTimersByTimeAsync(INGEST_MAX_WAIT_MS + 1);
    const refused = await waiting;
    expect(refused.status).toBe(429);
    const retryAfter = Number(refused.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(30);
    const reset = Date.parse(refused.headers.get("X-RateLimit-Reset") ?? "");
    expect(reset).toBeGreaterThan(Date.now());
    expect(await refused.json()).toMatchObject({ data: null });
    // The refused request never reached the handler.
    expect(held.handler).toHaveBeenCalledTimes(INGEST_SLOTS_PER_CALLER);
    vi.useRealTimers();
    for (let i = 0; i < INGEST_SLOTS_PER_CALLER; i++) held.releaseOne();
    await Promise.all(running);
  });

  it("refuses at once when the caller already has a full line", async () => {
    const held = heldHandler();
    const wrapped = withIngestAdmission(held.handler);
    const admittedOrQueued = Array.from(
      { length: INGEST_SLOTS_PER_CALLER + INGEST_MAX_QUEUED_PER_CALLER },
      () => wrapped(request("phone")),
    );
    await tick();
    const overflow = await wrapped(request("phone"));
    expect(overflow.status).toBe(429);
    expect(overflow.headers.get("Retry-After")).not.toBeNull();
    for (let i = 0; i < admittedOrQueued.length; i++) {
      held.releaseOne();
      await tick();
    }
    const statuses = (await Promise.all(admittedOrQueued)).map((r) => r.status);
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it("frees the slot when the handler throws", async () => {
    const wrapped = withIngestAdmission(async () => {
      throw new Error("boom");
    });
    await expect(wrapped(request("phone"))).rejects.toThrow("boom");
    expect(ingestAdmissionState()).toEqual({ running: 0, queued: 0 });
  });
});

describe("admitIngest", () => {
  it("serves waiters in arrival order", async () => {
    const order: string[] = [];
    const first = await Promise.all(
      Array.from({ length: INGEST_SLOTS }, (_, i) => admitIngest(`c${i}`)),
    );
    const later = ["a", "b", "c"].map((name) =>
      admitIngest(`late-${name}`).then((slot) => {
        order.push(name);
        return slot;
      }),
    );
    for (const slot of first) if (slot.admitted) slot.release();
    for (const slot of await Promise.all(later)) {
      if (slot.admitted) slot.release();
    }
    expect(order).toEqual(["a", "b", "c"]);
  });
});

describe("ingestCallerKey", () => {
  it("keys on the credential, hashed, and shares one key without one", () => {
    const a = ingestCallerKey(request("token-a"));
    expect(a).not.toContain("token-a");
    expect(a).toBe(ingestCallerKey(request("token-a")));
    expect(a).not.toBe(ingestCallerKey(request("token-b")));
    expect(ingestCallerKey(new Request("http://localhost/"))).toBe("anonymous");
  });
});
