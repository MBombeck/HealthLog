/**
 * The upload queue's answer to the route's busy signal (429 `uploadBusy`,
 * `Retry-After: 1`). Before this, the vault turned that one-second refusal
 * into an error card that told the person to come back in a few minutes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  busyRetryDelayMs,
  parseRetryAfterSeconds,
  UPLOAD_BUSY_BUDGET_MS,
  UPLOAD_BUSY_MAX_ATTEMPTS,
  uploadWithBusyRetry,
} from "../upload-busy-retry";
import type { UploadResult } from "../vault-utils";

const busy = (retryAfterSeconds?: number): UploadResult => ({
  ok: false,
  reason: "uploadBusy",
  retryAfterSeconds,
});
const stored = {
  ok: true,
  duplicate: false,
  document: { id: "doc-1" },
} as unknown as UploadResult;

const noJitter = () => 0;

describe("parseRetryAfterSeconds", () => {
  it("reads whole seconds", () => {
    expect(parseRetryAfterSeconds("1")).toBe(1);
    expect(parseRetryAfterSeconds(" 12 ")).toBe(12);
  });

  it("ignores an absent, dated or malformed header", () => {
    expect(parseRetryAfterSeconds(null)).toBeUndefined();
    expect(parseRetryAfterSeconds("")).toBeUndefined();
    expect(
      parseRetryAfterSeconds("Wed, 21 Oct 2026 07:28:00 GMT"),
    ).toBeUndefined();
    expect(parseRetryAfterSeconds("-3")).toBeUndefined();
    expect(parseRetryAfterSeconds("1.5")).toBeUndefined();
  });
});

describe("busyRetryDelayMs", () => {
  it("waits Retry-After, clamped to 1 to 10 seconds", () => {
    expect(busyRetryDelayMs(1, noJitter)).toBe(1000);
    expect(busyRetryDelayMs(0, noJitter)).toBe(1000);
    expect(busyRetryDelayMs(undefined, noJitter)).toBe(1000);
    expect(busyRetryDelayMs(4, noJitter)).toBe(4000);
    expect(busyRetryDelayMs(3600, noJitter)).toBe(10_000);
  });

  it("adds under half a second of jitter", () => {
    expect(busyRetryDelayMs(1, () => 0.999)).toBe(1499);
  });
});

describe("uploadWithBusyRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a busy answer after Retry-After and returns the success", async () => {
    const attempt = vi
      .fn<() => Promise<UploadResult>>()
      .mockResolvedValueOnce(busy(1))
      .mockResolvedValueOnce(stored);
    const onRetry = vi.fn();

    const pending = uploadWithBusyRetry(attempt, { random: noJitter, onRetry });
    await vi.advanceTimersByTimeAsync(999);
    expect(attempt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toBe(stored);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("gives up after the attempt cap and hands back the busy result", async () => {
    const attempt = vi
      .fn<() => Promise<UploadResult>>()
      .mockResolvedValue(busy(1));

    const pending = uploadWithBusyRetry(attempt, { random: noJitter });
    await vi.advanceTimersByTimeAsync(UPLOAD_BUSY_BUDGET_MS);

    await expect(pending).resolves.toMatchObject({ reason: "uploadBusy" });
    expect(attempt).toHaveBeenCalledTimes(UPLOAD_BUSY_MAX_ATTEMPTS);
  });

  it("stops before a wait that would overrun the time budget", async () => {
    // 10 s per wait (clamped): attempts at 0, 10 and 20 s; a third wait
    // would end at 30 s plus jitter, past the budget.
    const attempt = vi
      .fn<() => Promise<UploadResult>>()
      .mockResolvedValue(busy(60));

    const pending = uploadWithBusyRetry(attempt, { random: () => 0.5 });
    await vi.advanceTimersByTimeAsync(UPLOAD_BUSY_BUDGET_MS * 2);

    await expect(pending).resolves.toMatchObject({ reason: "uploadBusy" });
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("never retries any other failure, the hourly limit included", async () => {
    for (const failure of [
      { ok: false, reason: "rateLimited" },
      { ok: false, reason: "generic" },
      { ok: false, reason: "fileTooLarge" },
    ] as UploadResult[]) {
      const attempt = vi
        .fn<() => Promise<UploadResult>>()
        .mockResolvedValue(failure);
      await expect(uploadWithBusyRetry(attempt)).resolves.toBe(failure);
      expect(attempt).toHaveBeenCalledTimes(1);
    }
  });

  it("an abort during the wait clears the timer and sends nothing more", async () => {
    const attempt = vi
      .fn<() => Promise<UploadResult>>()
      .mockResolvedValue(busy(5));
    const controller = new AbortController();

    const pending = uploadWithBusyRetry(attempt, {
      signal: controller.signal,
      random: noJitter,
    });
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();

    await expect(pending).resolves.toMatchObject({ reason: "uploadBusy" });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(UPLOAD_BUSY_BUDGET_MS);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("an already-aborted signal makes no second attempt", async () => {
    const attempt = vi
      .fn<() => Promise<UploadResult>>()
      .mockResolvedValue(busy(1));
    const controller = new AbortController();
    controller.abort();

    await expect(
      uploadWithBusyRetry(attempt, { signal: controller.signal }),
    ).resolves.toMatchObject({ reason: "uploadBusy" });
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
