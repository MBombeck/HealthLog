/**
 * A file attached in the Coach while the vault is still uploading elsewhere
 * gets the route's busy answer first; it must wait and land, not toast.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchRaw = vi.fn();
vi.mock("@/lib/api/api-fetch", () => ({
  apiFetchRaw: (...args: unknown[]) => apiFetchRaw(...args),
}));

import { uploadCoachAttachment } from "../upload-attachment";

function answer(status: number, body: unknown, retryAfter?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: retryAfter ? { "Retry-After": retryAfter } : {},
  });
}

const busyBody = {
  data: null,
  error: "Too many uploads are already in progress. Try again shortly.",
  meta: { errorCode: "documents.inbound.uploadBusy", reason: "uploadBusy" },
};

beforeEach(() => {
  vi.useFakeTimers();
  apiFetchRaw.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("uploadCoachAttachment", () => {
  it("waits out a busy answer and returns the stored document", async () => {
    apiFetchRaw
      .mockResolvedValueOnce(answer(429, busyBody, "1"))
      .mockResolvedValueOnce(
        answer(201, { data: { id: "doc-1" }, error: null }),
      );
    const file = new File(["%PDF-1.4"], "letter.pdf", {
      type: "application/pdf",
    });

    const pending = uploadCoachAttachment(file, undefined);
    await vi.advanceTimersByTimeAsync(1500);
    const upload = await pending;

    expect(upload.result).toMatchObject({
      ok: true,
      document: { id: "doc-1" },
    });
    expect(apiFetchRaw).toHaveBeenCalledTimes(2);
    // Each attempt is its own request with its own key and a fresh body.
    const [first, second] = apiFetchRaw.mock.calls.map(
      (call) => (call[1] as RequestInit).headers as Record<string, string>,
    );
    expect(first!["Idempotency-Key"]).not.toBe(second!["Idempotency-Key"]);
  });

  it("an unmount during the wait sends nothing more", async () => {
    apiFetchRaw.mockResolvedValue(answer(429, busyBody, "1"));
    const controller = new AbortController();
    const file = new File(["%PDF-1.4"], "letter.pdf");

    const pending = uploadCoachAttachment(file, controller.signal);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    const upload = await pending;

    expect(upload.result).toMatchObject({ ok: false, reason: "uploadBusy" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(apiFetchRaw).toHaveBeenCalledTimes(1);
  });
});
