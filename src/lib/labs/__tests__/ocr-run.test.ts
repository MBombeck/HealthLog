/**
 * The lab scan read the background worker runs (v1.40), moved out of the
 * route with the guarantees the route's own tests used to pin: the budget is
 * settled against what the provider reported, a PDF is rendered and read a
 * page at a time, a long PDF says which pages were read, the reads fit the
 * run's deadline, and a provider failure is named as one without the upstream
 * body reaching the stored failure or the event stream.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/documents/rasterize-pdf", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/documents/rasterize-pdf")>()),
  rasterizePdf: vi.fn(),
}));
vi.mock("@/lib/ai/coach/budget", () => ({
  reconcileSpend: vi.fn().mockResolvedValue(undefined),
  reserveBudget: vi.fn(),
  OPERATOR_COST_CAP: 200_000,
  USER_PLAN_CAP: 2_000_000,
}));
vi.mock("@/lib/labs/ocr-extract", async () => {
  const actual = await vi.importActual<typeof import("@/lib/labs/ocr-extract")>(
    "@/lib/labs/ocr-extract",
  );
  return { ...actual, runOcrExtraction: vi.fn() };
});

import { reconcileSpend, reserveBudget } from "@/lib/ai/coach/budget";
import { rasterizePdf } from "@/lib/documents/rasterize-pdf";
import {
  OCR_MAX_PAGES,
  OCR_TEXT_READ_CHARS,
  OCR_TEXT_READ_MAX_CHARS,
  planPageReads,
  splitOcrText,
} from "@/lib/documents/ocr-plan";
import { OcrExtractError } from "@/lib/documents/ocr-read";
import { runOcrExtraction } from "@/lib/labs/ocr-extract";
import type { RunOcrExtractionArgs } from "@/lib/labs/ocr-extract";
import { executeOcrExtraction } from "@/lib/labs/ocr-run";
import { AiUnavailableError } from "@/lib/ai/capabilities/refusal";
import { annotate } from "@/lib/logging/context";

const budget = {
  reserved: 1500,
  owner: "operator" as const,
  dateKey: "2027-01-15",
};
const textPick = {
  entry: { providerType: "openai", instance: {} as never },
  providerType: "openai",
} as never;
const codexPick = {
  entry: { providerType: "codex", instance: {} as never },
  providerType: "codex",
  pdfSupported: false,
} as never;
const anthropicPick = {
  entry: { providerType: "anthropic", instance: {} as never },
  providerType: "anthropic",
  pdfSupported: true,
} as never;

const text = (t = "Hb 14") => ({
  mode: "text" as const,
  text: t,
  pick: textPick,
});
const pdf = (pick: never = codexPick) => ({
  mode: "vision" as const,
  bytes: Buffer.from("%PDF-1.4"),
  mime: "application/pdf" as const,
  pick,
});
const pages = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    mediaType: "image/jpeg" as const,
    dataBase64: `page${i + 1}`,
  }));
/** A read that spends `spent` tokens (of them `cached` from the cache). */
const extraction =
  (spent = 0, cached = 0) =>
  async (args: RunOcrExtractionArgs) => {
    args.meter!.spent += spent;
    args.meter!.cached += cached;
    return {
      data: { rows: [] } as never,
      spentTokens: spent,
      cachedTokens: cached,
    };
  };
const schedule = (maxModelCalls: number) => ({
  maxModelCalls: () => maxModelCalls,
  arm: vi.fn().mockResolvedValue(undefined),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("planning the reads", () => {
  it("reads one page per call when the deadline allows it", () => {
    expect(planPageReads(3, Number.POSITIVE_INFINITY)).toEqual([[1], [2], [3]]);
  });

  it("shares the pages out when the deadline allows fewer reads", () => {
    expect(planPageReads(10, 4)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
      [10],
    ]);
    expect(planPageReads(5, 1)).toEqual([[1, 2, 3, 4, 5]]);
    expect(planPageReads(5, 0)).toEqual([[1, 2, 3, 4, 5]]);
  });

  it("keeps a photo's text as one read", () => {
    expect(splitOcrText("Hb 14\nMCV 90", Number.POSITIVE_INFINITY)).toEqual([
      "Hb 14\nMCV 90",
    ]);
  });

  it("splits long text at line boundaries, every line kept once", () => {
    const lines = Array.from(
      { length: 400 },
      (_, i) => `Marker ${i} 1,5 mg/dl`,
    );
    const whole = lines.join("\n");
    const parts = splitOcrText(whole, Number.POSITIVE_INFINITY);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(OCR_TEXT_READ_CHARS);
    }
    expect(parts.join("\n")).toBe(whole);
  });

  it("never splits text into more reads than the deadline allows", () => {
    const whole = Array.from({ length: 400 }, (_, i) => `Marker ${i}`).join(
      "\n",
    );
    const parts = splitOcrText(whole, 2);
    expect(parts).toHaveLength(2);
    expect(parts.join("\n")).toBe(whole);
  });

  it("folds the remainder in when lines do not share out evenly", () => {
    // Seven long lines into three reads: packing two lines a read leaves a
    // fourth read, which is folded into the third.
    const whole = Array.from({ length: 7 }, (_, i) =>
      String(i).repeat(5000),
    ).join("\n");
    const parts = splitOcrText(whole, 3);
    expect(parts).toHaveLength(3);
    expect(parts.join("\n")).toBe(whole);
  });
});

describe("text mode", () => {
  it("charges what the provider reported to the provider that served", async () => {
    vi.mocked(runOcrExtraction).mockImplementation(extraction(2345));
    const out = await executeOcrExtraction({
      userId: "u1",
      input: text(),
      budget,
    });
    expect(out).toEqual({ ok: true, data: { rows: [] } });
    expect(reconcileSpend).toHaveBeenCalledWith(
      "u1",
      1500,
      2345,
      "2027-01-15",
      0,
      { servedBy: "openai", reservedOwner: "operator" },
    );
  });

  it("charges the reservation when the provider reported nothing", async () => {
    vi.mocked(runOcrExtraction).mockImplementation(extraction(0));
    await executeOcrExtraction({ userId: "u1", input: text(), budget });
    expect(reconcileSpend).toHaveBeenCalledWith(
      "u1",
      1500,
      1500,
      "2027-01-15",
      0,
      { servedBy: "openai", reservedOwner: "operator" },
    );
  });

  it("sends long text in parts and moves the deadline to cover them", async () => {
    vi.mocked(runOcrExtraction).mockImplementation(extraction());
    // ~8.8k characters: three reads of at most OCR_TEXT_READ_CHARS.
    const long = Array.from(
      { length: 400 },
      (_, i) => `Marker ${i} 1,5 mg/dl`,
    ).join("\n");
    const s = schedule(20);
    await executeOcrExtraction({
      userId: "u1",
      input: text(long),
      budget,
      schedule: s,
    });
    const chunks = vi.mocked(runOcrExtraction).mock.calls[0][0].chunks;
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.pages.length === 0)).toBe(true);
    expect(s.arm).toHaveBeenCalledWith(6);
  });

  it("passes the cached share of what was spent to the ledger", async () => {
    vi.mocked(runOcrExtraction).mockImplementation(extraction(3000, 1200));
    await executeOcrExtraction({ userId: "u1", input: text(), budget });
    expect(reconcileSpend).toHaveBeenCalledWith(
      "u1",
      1500,
      3000,
      "2027-01-15",
      1200,
      { servedBy: "openai", reservedOwner: "operator" },
    );
  });

  it("reserves every read after the first, and settles against all of it", async () => {
    vi.mocked(reserveBudget).mockResolvedValue({
      allowed: true,
      reserved: 8000,
    } as never);
    vi.mocked(runOcrExtraction).mockImplementation(async (args) => {
      expect(await args.reserveRead!()).toBe(true);
      expect(await args.reserveRead!()).toBe(true);
      return extraction(20_000)(args);
    });
    await executeOcrExtraction({ userId: "u1", input: text(), budget });
    expect(reserveBudget).toHaveBeenCalledWith(
      "u1",
      8000,
      "2027-01-15",
      200_000,
      "operator",
      "coach",
      undefined,
      { countMessage: false },
    );
    expect(reconcileSpend).toHaveBeenCalledWith(
      "u1",
      1500 + 2 * 8000,
      20_000,
      "2027-01-15",
      0,
      { servedBy: "openai", reservedOwner: "operator" },
    );
  });

  it("judges the next read by the owner's cap, the one the route judged the first by", async () => {
    vi.mocked(reserveBudget).mockResolvedValue({
      allowed: true,
      reserved: 8000,
    } as never);
    vi.mocked(runOcrExtraction).mockImplementation(async (args) => {
      await args.reserveRead!();
      return extraction(1000)(args);
    });
    await executeOcrExtraction({
      userId: "u1",
      input: text(),
      budget: { ...budget, owner: "user" },
    });
    expect(vi.mocked(reserveBudget).mock.calls[0][3]).toBe(2_000_000);
    expect(vi.mocked(reserveBudget).mock.calls[0][4]).toBe("user");
  });

  it("books what the reads so far overspent before judging the next one", async () => {
    // A day's counter against the operator's cap, with reserveBudget's own
    // rule: a reservation is allowed while the spend before it is under cap.
    let counter = 190_000;
    vi.mocked(reserveBudget).mockImplementation(async (...a) => {
      const [, tokens, , cap] = a as unknown as [
        string,
        number,
        string,
        number,
      ];
      const prior = counter;
      if (prior >= cap) return { allowed: false, reserved: tokens } as never;
      counter += tokens;
      return { allowed: true, reserved: tokens } as never;
    });
    let answer: boolean | undefined;
    vi.mocked(runOcrExtraction).mockImplementation(async (args) => {
      // The first page cost 20 000 against the 1 500 the route reserved.
      args.meter!.spent += 20_000;
      answer = await args.reserveRead!();
      return { data: { rows: [] } as never, spentTokens: 0, cachedTokens: 0 };
    });
    await executeOcrExtraction({ userId: "u1", input: text(), budget });
    // 18 500 caught up first (allowed, the day stood at 190 000); the next
    // read is then judged at 208 500 and refused. Booking only the 8 000
    // ceiling, or both in one reservation, would have let it through.
    expect(answer).toBe(false);
    expect(vi.mocked(reserveBudget).mock.calls.map((c) => c[1])).toEqual([
      18_500, 8000,
    ]);
    expect(reconcileSpend).toHaveBeenCalledWith(
      "u1",
      20_000,
      20_000,
      "2027-01-15",
      0,
      { servedBy: "openai", reservedOwner: "operator" },
    );
  });

  it("judges the overspend net of the cached share, as the settlement books it", async () => {
    vi.mocked(reserveBudget).mockResolvedValue({
      allowed: true,
      reserved: 1,
    } as never);
    vi.mocked(runOcrExtraction).mockImplementation(async (args) => {
      args.meter!.spent += 20_000;
      args.meter!.cached += 4000;
      await args.reserveRead!();
      return { data: { rows: [] } as never, spentTokens: 0, cachedTokens: 0 };
    });
    await executeOcrExtraction({ userId: "u1", input: text(), budget });
    // 20 000 spent, 4 000 of it cached: 16 000 net against 1 500 reserved.
    expect(vi.mocked(reserveBudget).mock.calls[0][1]).toBe(14_500);
  });

  it("stops rather than takes the larger cap when the reservation names no known owner", async () => {
    let answer: boolean | undefined;
    vi.mocked(runOcrExtraction).mockImplementation(async (args) => {
      answer = await args.reserveRead!();
      return { data: { rows: [] } as never, spentTokens: 0, cachedTokens: 0 };
    });
    await executeOcrExtraction({
      userId: "u1",
      input: text(),
      budget: { ...budget, owner: undefined as never },
    });
    expect(answer).toBe(false);
    expect(reserveBudget).not.toHaveBeenCalled();
  });

  it("answers a scan stopped before any row with the stop's own reason", async () => {
    vi.mocked(runOcrExtraction).mockRejectedValueOnce(
      new OcrExtractError("x", "budget"),
    );
    expect(
      await executeOcrExtraction({ userId: "u1", input: text(), budget }),
    ).toMatchObject({ status: 429, errorCode: "labs.ocr.budgetExceeded" });

    vi.mocked(runOcrExtraction).mockRejectedValueOnce(
      new OcrExtractError(
        "x",
        "unavailable",
        new AiUnavailableError("labsOcr", "consent_required"),
      ),
    );
    expect(
      await executeOcrExtraction({ userId: "u1", input: text(), budget }),
    ).toMatchObject({ ok: false, errorCode: "consent.ai.required" });

    vi.mocked(runOcrExtraction).mockRejectedValueOnce(
      new OcrExtractError("x", "error"),
    );
    expect(
      await executeOcrExtraction({ userId: "u1", input: text(), budget }),
    ).toMatchObject({ status: 500, errorCode: "aiRuns.failed" });
  });

  it("tells the read to stop when the day's budget refuses the next one", async () => {
    vi.mocked(reserveBudget).mockResolvedValue({
      allowed: false,
      reserved: 8000,
    } as never);
    let answer: boolean | undefined;
    vi.mocked(runOcrExtraction).mockImplementation(async (args) => {
      answer = await args.reserveRead!();
      return extraction(4000)(args);
    });
    await executeOcrExtraction({ userId: "u1", input: text(), budget });
    expect(answer).toBe(false);
    // The refused reservation was handed back by reserveBudget itself; the
    // run settles against the first read's alone.
    expect(reconcileSpend).toHaveBeenCalledWith(
      "u1",
      1500,
      4000,
      "2027-01-15",
      0,
      { servedBy: "openai", reservedOwner: "operator" },
    );
  });

  it("refuses text one read cannot return up front, and refunds", async () => {
    // One unbroken line: it cannot be split, and is past what a read holds.
    const out = await executeOcrExtraction({
      userId: "u1",
      input: text("x".repeat(OCR_TEXT_READ_MAX_CHARS + 1)),
      budget,
    });
    expect(out).toMatchObject({
      ok: false,
      status: 422,
      errorCode: "labs.ocr.tooLarge",
    });
    expect(runOcrExtraction).not.toHaveBeenCalled();
    expect(reconcileSpend).toHaveBeenCalledWith(
      "u1",
      1500,
      0,
      "2027-01-15",
      0,
      { servedBy: null, reservedOwner: "operator" },
    );
  });

  it("charges a failed scan for the calls it made, refunding only the rest", async () => {
    vi.mocked(runOcrExtraction).mockImplementation(async (args) => {
      args.meter!.spent += 900;
      throw new OcrExtractError("x");
    });
    await executeOcrExtraction({ userId: "u1", input: text(), budget });
    expect(reconcileSpend).toHaveBeenCalledWith(
      "u1",
      1500,
      900,
      "2027-01-15",
      0,
      { servedBy: "openai", reservedOwner: "operator" },
    );
  });

  it("refunds the reservation in full when a failed scan spent nothing", async () => {
    vi.mocked(runOcrExtraction).mockRejectedValue(new OcrExtractError("x"));
    const out = await executeOcrExtraction({
      userId: "u1",
      input: text(),
      budget,
    });
    expect(out).toMatchObject({
      ok: false,
      status: 422,
      errorCode: "labs.ocr.extractFailed",
    });
    expect(reconcileSpend).toHaveBeenCalledWith(
      "u1",
      1500,
      0,
      "2027-01-15",
      0,
      { servedBy: null, reservedOwner: "operator" },
    );
  });

  it("names a read that stopped at the output limit as exactly that", async () => {
    vi.mocked(runOcrExtraction).mockRejectedValue(
      new OcrExtractError("x", "output_limit"),
    );
    const out = await executeOcrExtraction({
      userId: "u1",
      input: text(),
      budget,
    });
    expect(out).toMatchObject({
      ok: false,
      status: 422,
      errorCode: "labs.ocr.outputLimit",
    });
  });

  it("names a provider failure and never keeps the upstream body", async () => {
    vi.mocked(runOcrExtraction).mockRejectedValue(
      Object.assign(new Error("Local AI request failed (403)"), {
        httpStatus: 403,
        model: "llama3",
        bodyExcerpt: "ami-id iam/security-credentials/admin",
      }),
    );
    const out = await executeOcrExtraction({
      userId: "u1",
      input: text(),
      budget,
    });
    expect(out).toMatchObject({ ok: false, status: 502 });
    expect(JSON.stringify(out)).toContain("configured AI provider");
    expect(JSON.stringify(out)).not.toContain("iam/security-credentials");
    expect(JSON.stringify(vi.mocked(annotate).mock.calls)).not.toContain(
      "iam/security-credentials",
    );
    expect(annotate).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ upstreamStatus: 403, model: "llama3" }),
      }),
    );
  });
});

describe("vision mode", () => {
  it("reads a rendered PDF one page per call", async () => {
    vi.mocked(rasterizePdf).mockResolvedValue({
      ok: true,
      images: pages(3),
      pageCount: 3,
    });
    vi.mocked(runOcrExtraction).mockImplementation(extraction());
    const s = schedule(Number.POSITIVE_INFINITY);
    const out = await executeOcrExtraction({
      userId: "u1",
      input: pdf(),
      budget,
      schedule: s,
    });
    expect(out).toEqual({ ok: true, data: { rows: [] } });
    expect(rasterizePdf).toHaveBeenCalledWith(
      expect.anything(),
      OCR_MAX_PAGES,
      { withText: true },
    );
    const args = vi.mocked(runOcrExtraction).mock.calls[0][0];
    expect(args.totalPages).toBe(3);
    expect(args.chunks).toEqual([
      { images: [pages(3)[0]], documents: [], pages: [1], pageTexts: [] },
      { images: [pages(3)[1]], documents: [], pages: [2], pageTexts: [] },
      { images: [pages(3)[2]], documents: [], pages: [3], pageTexts: [] },
    ]);
    expect(s.arm).toHaveBeenCalledWith(6);
  });

  it("sends each page's text layer with it, headed by page when a read holds several", async () => {
    vi.mocked(rasterizePdf).mockResolvedValue({
      ok: true,
      images: pages(4),
      pageCount: 4,
      texts: ["Hb 14,2 g/dl", "", "TSH 1,2", "Na 140"],
    });
    vi.mocked(runOcrExtraction).mockImplementation(extraction());
    await executeOcrExtraction({
      userId: "u1",
      input: pdf(),
      budget,
      schedule: schedule(4),
    });
    const args = vi.mocked(runOcrExtraction).mock.calls[0][0];
    expect(args.chunks.map((c) => c.pageTexts)).toEqual([
      [{ page: 1, text: "Hb 14,2 g/dl" }],
      [
        { page: 3, text: "TSH 1,2" },
        { page: 4, text: "Na 140" },
      ],
    ]);
  });

  it("reads a multi-page PDF page by page on a provider that reads PDFs too", async () => {
    vi.mocked(rasterizePdf).mockResolvedValue({
      ok: true,
      images: pages(4),
      pageCount: 4,
    });
    vi.mocked(runOcrExtraction).mockImplementation(extraction());
    await executeOcrExtraction({
      userId: "u1",
      input: pdf(anthropicPick),
      budget,
    });
    const args = vi.mocked(runOcrExtraction).mock.calls[0][0];
    expect(args.chunks.map((c) => c.pages)).toEqual([[1], [2], [3], [4]]);
    expect(args.chunks.every((c) => c.documents?.length === 0)).toBe(true);
  });

  it("keeps the native document for a one-page PDF, or one that cannot be rendered", async () => {
    vi.mocked(runOcrExtraction).mockImplementation(extraction());
    vi.mocked(rasterizePdf).mockResolvedValueOnce({
      ok: true,
      images: pages(1),
      pageCount: 1,
    });
    vi.mocked(rasterizePdf).mockResolvedValueOnce({
      ok: false,
      reason: "unsupported",
    });
    for (let i = 0; i < 2; i += 1) {
      await executeOcrExtraction({
        userId: "u1",
        input: pdf(anthropicPick),
        budget,
      });
      const args = vi.mocked(runOcrExtraction).mock.calls[i][0];
      expect(args.chunks).toHaveLength(1);
      expect(args.chunks[0].documents).toHaveLength(1);
      expect(args.chunks[0].images).toEqual([]);
    }
  });

  it("puts several pages in a read when the deadline allows fewer reads", async () => {
    vi.mocked(rasterizePdf).mockResolvedValue({
      ok: true,
      images: pages(10),
      pageCount: 10,
    });
    vi.mocked(runOcrExtraction).mockImplementation(extraction());
    // Five sequential calls fit: two reads with their retries.
    const s = schedule(5);
    await executeOcrExtraction({
      userId: "u1",
      input: pdf(),
      budget,
      schedule: s,
    });
    const args = vi.mocked(runOcrExtraction).mock.calls[0][0];
    expect(args.chunks.map((c) => c.pages)).toEqual([
      [1, 2, 3, 4, 5],
      [6, 7, 8, 9, 10],
    ]);
    expect(s.arm).toHaveBeenCalledWith(4);
  });

  it("says when only the first pages of a long PDF were read", async () => {
    vi.mocked(rasterizePdf).mockResolvedValue({
      ok: true,
      images: pages(OCR_MAX_PAGES),
      pageCount: 23,
    });
    vi.mocked(runOcrExtraction).mockImplementation(extraction());
    const out = await executeOcrExtraction({
      userId: "u1",
      input: pdf(),
      budget,
    });
    expect(out).toEqual({
      ok: true,
      data: { rows: [], pageCoverage: { read: OCR_MAX_PAGES, total: 23 } },
    });
  });

  it("falls back to pdfNeedsAnthropic and refunds when rendering fails", async () => {
    vi.mocked(rasterizePdf).mockResolvedValue({
      ok: false,
      reason: "render-failed",
    });
    const out = await executeOcrExtraction({
      userId: "u1",
      input: pdf(),
      budget,
    });
    expect(out).toMatchObject({
      ok: false,
      status: 422,
      errorCode: "labs.ocr.pdfNeedsAnthropic",
    });
    expect(runOcrExtraction).not.toHaveBeenCalled();
    expect(reconcileSpend).toHaveBeenCalledWith(
      "u1",
      1500,
      0,
      "2027-01-15",
      0,
      { servedBy: null, reservedOwner: "operator" },
    );
  });
});
