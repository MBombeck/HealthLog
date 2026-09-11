/**
 * v1.20.1 — POST /api/labs/ocr/extract, TEXT mode.
 *
 * Focus: the text-mode structuring pass reserves the proportionate text budget
 * ceiling (`AI_BUDGETS.ocrExtractText`), not the far larger vision ceiling, and
 * on a clean extraction failure it refunds the reservation in full rather than
 * charging it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-handler")>(
      "@/lib/api-handler",
    );
  return {
    ...actual,
    apiHandler: <T extends (...args: unknown[]) => Promise<Response>>(
      h: T,
    ): T => h,
    requireAuth: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: vi.fn() } },
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/labs/ocr-capability", () => ({
  resolveTextProvider: vi.fn(),
  resolveVisionProvider: vi.fn(),
}));
vi.mock("@/lib/documents/rasterize-pdf", () => ({
  rasterizePdf: vi.fn(),
}));
vi.mock("@/lib/ai/consent-guard", () => ({
  assertConsentForChain: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  rateLimitHeaders: vi.fn(() => ({})),
}));
vi.mock("@/lib/ai/coach/budget", () => ({
  buildDateKey: vi.fn(() => "2026-06-26"),
  reserveBudget: vi.fn(),
  reconcileSpend: vi.fn().mockResolvedValue(undefined),
  resolveDailyCap: vi.fn(() => 200_000),
  resolveCostOwner: vi.fn(() => "operator" as const),
}));
vi.mock("@/lib/labs/ocr-extract", async () => {
  const actual = await vi.importActual<typeof import("@/lib/labs/ocr-extract")>(
    "@/lib/labs/ocr-extract",
  );
  return { ...actual, runOcrExtraction: vi.fn() };
});

import { POST } from "../route";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { requireAuth } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import {
  resolveTextProvider,
  resolveVisionProvider,
} from "@/lib/labs/ocr-capability";
import { rasterizePdf } from "@/lib/documents/rasterize-pdf";
import { reserveBudget, reconcileSpend } from "@/lib/ai/coach/budget";
import { OcrExtractError, runOcrExtraction } from "@/lib/labs/ocr-extract";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function textReq(text = "Glucose 95 mg/dL"): Request {
  return new Request("http://localhost/api/labs/ocr/extract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "text", text }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuth).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    labsLocalOcrEnabled: true,
  } as never);
  vi.mocked(resolveTextProvider).mockResolvedValue({
    chain: [{ providerType: "openai", instance: {} as never }],
    pick: {
      entry: { providerType: "openai", instance: {} as never },
      providerType: "openai",
    },
  } as never);
  vi.mocked(reserveBudget).mockResolvedValue({
    allowed: true,
    reserved: AI_BUDGETS.ocrExtractText.maxTokens ?? 0,
    totalAfter: AI_BUDGETS.ocrExtractText.maxTokens ?? 0,
    owner: "operator",
    operatorAfter: AI_BUDGETS.ocrExtractText.maxTokens ?? 0,
  } as never);
});

describe("POST /api/labs/ocr/extract — text mode budget", () => {
  it("reserves the cheaper text ceiling, not the vision ceiling", async () => {
    vi.mocked(runOcrExtraction).mockResolvedValue({ rows: [] } as never);

    const res = await POST(textReq());
    expect(res.status).toBe(200);

    // The reservation must use the text ceiling — proven distinct from the
    // vision ceiling so a future merge can't silently re-point it.
    expect(AI_BUDGETS.ocrExtractText.maxTokens).toBeLessThan(
      AI_BUDGETS.ocrExtract.maxTokens ?? Infinity,
    );
    expect(reserveBudget).toHaveBeenCalledWith(
      "user-1",
      AI_BUDGETS.ocrExtractText.maxTokens,
      "2026-06-26",
      // F1 — the provider-aware daily cap (mocked) is threaded as the 4th arg.
      200_000,
      // Wave E — and the cost owner that cap is enforced against as the 5th.
      "operator",
    );
  });

  it("refunds the reservation in full on a clean extract failure", async () => {
    vi.mocked(runOcrExtraction).mockRejectedValue(
      new OcrExtractError("unreadable"),
    );

    const res = await POST(textReq());
    expect(res.status).toBe(422);

    // actual spend reconciles to 0 — the failed structuring pass is refunded,
    // not charged at the reserved estimate.
    expect(reconcileSpend).toHaveBeenCalledWith(
      "user-1",
      AI_BUDGETS.ocrExtractText.maxTokens,
      0,
      "2026-06-26",
      0,
      { servedBy: null, reservedOwner: "operator" },
    );
  });

  it("identifies provider failures instead of blaming image quality", async () => {
    vi.mocked(runOcrExtraction).mockRejectedValue(new Error("provider down"));

    const res = await POST(textReq());
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(502);
    expect(body.error).toContain("configured AI provider");
  });
});

describe("POST /api/labs/ocr/extract — vision PDF rasterization", () => {
  function pdfReq(): Request {
    // A minimal `%PDF-` header is all `detectOcrMimeType` needs to sniff a PDF.
    const bytes = new Uint8Array([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3,
      0xcf, 0xd3, 0x0a,
    ]);
    const file = new File([bytes], "report.pdf", {
      type: "application/pdf",
    });
    const form = new FormData();
    form.append("file", file);
    return new Request("http://localhost/api/labs/ocr/extract", {
      method: "POST",
      body: form,
    });
  }

  beforeEach(() => {
    // A non-Anthropic vision provider (codex): no native PDF block, so the
    // route must rasterize.
    vi.mocked(resolveVisionProvider).mockResolvedValue({
      chain: [{ providerType: "codex", instance: {} as never }],
      localOcrEnabled: false,
      pick: {
        entry: { providerType: "codex", instance: {} as never },
        providerType: "codex",
        pdfSupported: false,
      },
    } as never);
    vi.mocked(reserveBudget).mockResolvedValue({
      allowed: true,
      reserved: AI_BUDGETS.ocrExtract.maxTokens ?? 0,
      totalAfter: AI_BUDGETS.ocrExtract.maxTokens ?? 0,
      owner: "operator",
      operatorAfter: AI_BUDGETS.ocrExtract.maxTokens ?? 0,
    } as never);
  });

  it("rasterizes a PDF for a non-Anthropic vision provider and sends the page images", async () => {
    vi.mocked(rasterizePdf).mockResolvedValue({
      ok: true,
      images: [{ mediaType: "image/jpeg", dataBase64: "cGFnZQ==" }],
    });
    vi.mocked(runOcrExtraction).mockResolvedValue({ rows: [] } as never);

    const res = await POST(pdfReq());
    expect(res.status).toBe(200);
    expect(rasterizePdf).toHaveBeenCalledOnce();
    // The rendered page images flow through as `input_image`s; no native PDF
    // document block is sent for a non-Anthropic provider.
    expect(runOcrExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [{ mediaType: "image/jpeg", dataBase64: "cGFnZQ==" }],
        documents: [],
      }),
    );
  });

  it("falls back to pdfNeedsAnthropic when rasterization fails", async () => {
    vi.mocked(rasterizePdf).mockResolvedValue({
      ok: false,
      reason: "render-failed",
    });

    const res = await POST(pdfReq());
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string | null };
    expect(body.error).toBeTruthy();
    // A failed render never reaches the provider — and refunds the reservation.
    expect(runOcrExtraction).not.toHaveBeenCalled();
    expect(reconcileSpend).toHaveBeenCalledWith(
      "user-1",
      AI_BUDGETS.ocrExtract.maxTokens,
      0,
      "2026-06-26",
      0,
      { servedBy: null, reservedOwner: "operator" },
    );
  });
});
