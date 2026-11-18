/**
 * The vault upload inside a managed or shared record.
 *
 * The upload is an `XMLHttpRequest`, so it does not pass through `apiFetch`
 * and does not get the record-session fence headers for free. Without them a
 * guardian's upload into the record they manage was refused as an unfenced
 * client (403) and surfaced as "Upload failed. Please try again." These tests
 * pin both halves: the request asserts the adopted context, and a response
 * that contradicts it is dropped and handed to the reconciler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetRecordFenceForTests,
  adoptRecordFenceState,
  onRecordFenceMismatch,
} from "@/lib/api/record-fence";
import {
  RECORD_EPOCH_HEADER,
  RECORD_FENCE_BOOTSTRAP,
  RECORD_FENCE_ERROR_CODE,
  RECORD_SCOPE_HEADER,
} from "@/lib/sharing/record-session-fence-contract";
import { uploadViaXhr } from "../use-document-upload";

interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

let reply: Reply;
const sentHeaders: Record<string, string>[] = [];

class FakeXhr {
  status = 0;
  responseText = "";
  upload = { addEventListener: () => {} };
  private listeners = new Map<string, () => void>();
  private headers: Record<string, string> = {};

  open(): void {}

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  getResponseHeader(name: string): string | null {
    return reply.headers?.[name.toLowerCase()] ?? null;
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener);
  }

  send(): void {
    sentHeaders.push(this.headers);
    this.status = reply.status;
    this.responseText = JSON.stringify(reply.body);
    this.listeners.get("load")?.();
  }
}

const created: Reply = {
  status: 201,
  body: { data: { id: "doc-1", fileName: "scan.pdf" }, error: null },
};

function pdf(): File {
  return new File([new Uint8Array([1, 2, 3])], "scan.pdf", {
    type: "application/pdf",
  });
}

beforeEach(() => {
  sentHeaders.length = 0;
  reply = created;
  __resetRecordFenceForTests();
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});

afterEach(() => {
  __resetRecordFenceForTests();
  vi.unstubAllGlobals();
});

describe("vault upload carries the record-session fence", () => {
  it("asserts the adopted record's epoch and scope", async () => {
    adoptRecordFenceState({ epoch: 3, scope: "managed-1" });

    const result = await uploadViaXhr(pdf(), {}, () => {});

    expect(sentHeaders[0]![RECORD_EPOCH_HEADER]).toBe("3");
    expect(sentHeaders[0]![RECORD_SCOPE_HEADER]).toBe("managed-1");
    expect(result.ok).toBe(true);
  });

  it("asserts the bootstrap sentinel before a context is adopted", async () => {
    await uploadViaXhr(pdf(), {}, () => {});

    expect(sentHeaders[0]![RECORD_EPOCH_HEADER]).toBe(RECORD_FENCE_BOOTSTRAP);
    expect(sentHeaders[0]![RECORD_SCOPE_HEADER]).toBe(RECORD_FENCE_BOOTSTRAP);
  });

  it("drops a response echoing a record this tab has left", async () => {
    adoptRecordFenceState({ epoch: 3, scope: "managed-1" });
    const mismatch = vi.fn();
    onRecordFenceMismatch(mismatch);
    reply = {
      ...created,
      headers: {
        [RECORD_EPOCH_HEADER]: "4",
        [RECORD_SCOPE_HEADER]: "managed-2",
      },
    };

    const result = await uploadViaXhr(pdf(), {}, () => {});

    expect(result).toEqual({ ok: false, reason: "recordChanged" });
    expect(mismatch).toHaveBeenCalledTimes(1);
  });

  it("keeps a response whose echo agrees", async () => {
    adoptRecordFenceState({ epoch: 3, scope: "managed-1" });
    const mismatch = vi.fn();
    onRecordFenceMismatch(mismatch);
    reply = {
      ...created,
      headers: {
        [RECORD_EPOCH_HEADER]: "3",
        [RECORD_SCOPE_HEADER]: "managed-1",
      },
    };

    const result = await uploadViaXhr(pdf(), {}, () => {});

    expect(result.ok).toBe(true);
    expect(mismatch).not.toHaveBeenCalled();
  });

  it("hands a 409 session-changed refusal to the reconciler", async () => {
    adoptRecordFenceState({ epoch: 3, scope: "managed-1" });
    const mismatch = vi.fn();
    onRecordFenceMismatch(mismatch);
    reply = {
      status: 409,
      body: {
        data: null,
        error: "sharing.session.changed",
        meta: { errorCode: RECORD_FENCE_ERROR_CODE },
      },
    };

    const result = await uploadViaXhr(pdf(), {}, () => {});

    expect(result).toEqual({ ok: false, reason: "recordChanged" });
    expect(mismatch).toHaveBeenCalledTimes(1);
  });
});
