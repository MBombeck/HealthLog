/**
 * How the test-connection button reads a real failure response (#947).
 *
 * The component suite is SSR-only, so the button's probe is exercised as the
 * function the button calls: `apiFetchRaw` is stubbed with the envelope a
 * notification test route sends, and the result is rendered through the same
 * callout the button renders. Removing the meta extraction turns this red.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchRawMock = vi.fn();
vi.mock("@/lib/api/api-fetch", () => ({
  apiFetchRaw: (...args: unknown[]) => apiFetchRawMock(...args),
}));

import {
  runConnectionTest,
  TestConnectionFailure,
} from "../test-connection-button";

function envelope(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderFailure(
  result: Awaited<ReturnType<typeof runConnectionTest>>,
): string {
  if (result.kind !== "error") throw new Error("expected a failure");
  return renderToStaticMarkup(
    <TestConnectionFailure
      message={`code:${result.errorCode}`}
      upstreamStatus={result.upstreamStatus}
      smtpCode={result.smtpCode}
      upstreamBody={result.upstreamBody}
    />,
  );
}

beforeEach(() => {
  apiFetchRawMock.mockReset();
});

describe("runConnectionTest", () => {
  it("reads the code, the HTTP status and what the relay said from a 502", async () => {
    apiFetchRawMock.mockResolvedValue(
      envelope(502, {
        data: null,
        error: "The webhook answered HTTP 400.",
        meta: {
          errorCode: "upstream_rejected",
          upstreamStatus: 400,
          upstreamBody: "priority must be an integer",
        },
      }),
    );

    const result = await runConnectionTest("/api/settings/webhook/test");

    expect(apiFetchRawMock).toHaveBeenCalledWith("/api/settings/webhook/test", {
      method: "POST",
    });
    const html = renderFailure(result);
    expect(html).toContain("code:upstream_rejected (HTTP 400)");
    expect(html).toContain("priority must be an integer");
  });

  it("reads the SMTP reply code from an email failure", async () => {
    apiFetchRawMock.mockResolvedValue(
      envelope(502, {
        data: null,
        error: "The mail server rejected the credentials (SMTP 535).",
        meta: { errorCode: "credentials_rejected", smtpCode: 535 },
      }),
    );

    const html = renderFailure(
      await runConnectionTest("/api/settings/email/test"),
    );

    expect(html).toContain("code:credentials_rejected (SMTP 535)");
    expect(html).not.toContain("test-connection-upstream-body");
  });

  it("falls back to the generic code when a proxy replaced the body", async () => {
    apiFetchRawMock.mockResolvedValue(
      new Response("<html>Bad Gateway</html>", { status: 502 }),
    );

    expect(await runConnectionTest("/api/settings/ntfy/test")).toEqual({
      kind: "error",
      errorCode: "generic",
      upstreamStatus: undefined,
      smtpCode: undefined,
      upstreamBody: undefined,
    });
  });

  it("reads why a push test that ran was refused", async () => {
    // The Web Push test answers 200 with `ok: false`; the code rides `meta`.
    apiFetchRawMock.mockResolvedValue(
      envelope(200, {
        data: { ok: false, reason: "web_push_403" },
        error: null,
        meta: { errorCode: "upstream_rejected" },
      }),
    );

    const result = await runConnectionTest("/api/notifications/web-push/test");

    expect(result).toMatchObject({
      kind: "error",
      errorCode: "upstream_rejected",
    });
  });

  it("reports success with the latency", async () => {
    apiFetchRawMock.mockResolvedValue(
      envelope(200, { data: { ok: true, latencyMs: 42 }, error: null }),
    );

    expect(await runConnectionTest("/api/nightscout/test")).toEqual({
      kind: "ok",
      latency: 42,
    });
  });

  it("is what the button calls", () => {
    const src = readFileSync(
      join(process.cwd(), "src/components/settings/test-connection-button.tsx"),
      "utf8",
    );
    expect(src).toMatch(/setResult\(await runConnectionTest\(endpoint\)\)/);
  });
});
