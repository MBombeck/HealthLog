/**
 * The vault's XHR transport carries the busy refusal's `Retry-After` into
 * the upload result, which is what the queue's retry waits on. Without the
 * header the retry still happens, but at the floor delay instead of the one
 * the server named.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { uploadViaXhr } from "../use-document-upload";

class BusyXhr {
  status = 0;
  responseText = "";
  upload = { addEventListener: () => {} };
  private listeners = new Map<string, () => void>();

  open(): void {}
  setRequestHeader(): void {}

  getResponseHeader(name: string): string | null {
    return name.toLowerCase() === "retry-after" ? "3" : null;
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener);
  }

  send(): void {
    this.status = 429;
    this.responseText = JSON.stringify({
      data: null,
      error: "Too many uploads are already in progress. Try again shortly.",
      meta: { errorCode: "documents.inbound.uploadBusy", reason: "uploadBusy" },
    });
    this.listeners.get("load")?.();
  }
}

beforeEach(() => {
  vi.stubGlobal("XMLHttpRequest", BusyXhr);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadViaXhr on a busy server", () => {
  it("reports uploadBusy with the server's Retry-After", async () => {
    const file = new File([new Uint8Array([1])], "scan.pdf", {
      type: "application/pdf",
    });
    await expect(uploadViaXhr(file, {}, () => {})).resolves.toEqual({
      ok: false,
      reason: "uploadBusy",
      retryAfterSeconds: 3,
    });
  });
});
