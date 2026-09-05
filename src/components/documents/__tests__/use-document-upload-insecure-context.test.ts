/**
 * The vault upload on a plain-HTTP origin — the reported failure.
 *
 * A self-hoster on plain HTTP over a LAN picked a file and nothing
 * happened: no queue row, no request, no error toast. The upload minted an
 * `Idempotency-Key` (and its local queue id) with `crypto.randomUUID()`,
 * which a non-secure context does not expose — measured in Chromium on
 * `http://<lan-ip>`: `isSecureContext` false, `crypto.randomUUID`
 * undefined, `crypto.getRandomValues` still a function. The call threw
 * synchronously inside the file-input change handler, so the throw had
 * nowhere to surface and the picker looked inert.
 *
 * Watched red: restoring `crypto.randomUUID()` in `uploadViaXhr` fails
 * "sends the multipart POST" with the plain-HTTP TypeError, and the
 * secure-context case stays green — which is the whole shape of the bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { uploadViaXhr } from "../use-document-upload";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Bound BEFORE any stubbing: `vi.stubGlobal("crypto", …)` replaces
 * `globalThis.crypto`, so a stub that delegated through the global would
 * call itself.
 */
const realGetRandomValues = globalThis.crypto.getRandomValues.bind(
  globalThis.crypto,
);

/**
 * The `crypto` a plain-HTTP origin actually hands the page: real
 * `getRandomValues`, no `randomUUID`, no `subtle`.
 */
function insecureCrypto(): Crypto {
  return { getRandomValues: realGetRandomValues } as Crypto;
}

interface SentRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: FormData | null;
}

const sent: SentRequest[] = [];

/** Minimal XHR double that records the request and resolves with a 201. */
class FakeXhr {
  status = 0;
  responseText = "";
  upload = { addEventListener: () => {} };
  private listeners = new Map<string, () => void>();
  private request: SentRequest = {
    method: "",
    url: "",
    headers: {},
    body: null,
  };

  open(method: string, url: string): void {
    this.request.method = method;
    this.request.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.request.headers[name] = value;
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener);
  }

  send(body: FormData): void {
    this.request.body = body;
    sent.push(this.request);
    this.status = 201;
    this.responseText = JSON.stringify({
      data: { id: "doc-1", fileName: "scan.pdf" },
      error: null,
    });
    this.listeners.get("load")?.();
  }
}

beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function pdf(): File {
  return new File([new Uint8Array([1, 2, 3])], "scan.pdf", {
    type: "application/pdf",
  });
}

describe("vault upload on a plain-HTTP origin", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", insecureCrypto());
  });

  it("has no crypto.randomUUID to call — the control", () => {
    expect(typeof (crypto as Crypto).randomUUID).toBe("undefined");
  });

  it("sends the multipart POST", async () => {
    const result = await uploadViaXhr(pdf(), {}, () => {});

    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe("POST");
    expect(sent[0]!.url).toBe("/api/documents/inbound");
    expect(sent[0]!.body?.get("file")).toBeInstanceOf(File);
    expect(result.ok).toBe(true);
  });

  it("still carries a v4 Idempotency-Key", async () => {
    await uploadViaXhr(pdf(), {}, () => {});

    expect(sent[0]!.headers["Idempotency-Key"]).toMatch(UUID_V4);
  });

  it("still forwards the episode link on a deep-link upload", async () => {
    await uploadViaXhr(pdf(), { episodeId: "ep-1" }, () => {});

    expect(sent[0]!.body?.get("episodeIds")).toBe("ep-1");
  });
});

describe("vault upload in a secure context", () => {
  it("is unchanged — a v4 Idempotency-Key and one POST", async () => {
    await uploadViaXhr(pdf(), {}, () => {});

    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers["Idempotency-Key"]).toMatch(UUID_V4);
    expect(typeof globalThis.crypto.randomUUID).toBe("function");
  });
});
