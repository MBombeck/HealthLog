/**
 * The document-AI hourly ceiling is an operator setting
 * (`DOCUMENT_AI_LIMIT_PER_HOUR`), not a constant. This pins the resolver's
 * contract: unset / non-numeric falls back to the default 6, a numeric value
 * takes effect, and the clamp keeps a typo from zeroing the surface out
 * (floor 1) or removing the cap entirely (ceiling 1000).
 *
 * Also pins the shared 429 builder: the response mirrors the bucket's reset
 * instant into `meta.retryAt` so the client can name the ACTUAL wait instead
 * of a fixed "a few minutes".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    inboundDocument: { findFirst: vi.fn() },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));
vi.mock("@/lib/documents/store", () => ({
  decryptDocumentContent: vi.fn(),
}));
vi.mock("@/lib/documents/rasterize-pdf", () => ({
  rasterizePdf: vi.fn(),
}));
vi.mock("@/lib/labs/ocr-upload", () => ({
  detectOcrMimeType: vi.fn(),
}));

import {
  documentAiRateLimited,
  resolveDocumentAiLimitPerHour,
} from "../ai-route-support";

const ORIGINAL = process.env.DOCUMENT_AI_LIMIT_PER_HOUR;

beforeEach(() => {
  delete process.env.DOCUMENT_AI_LIMIT_PER_HOUR;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.DOCUMENT_AI_LIMIT_PER_HOUR;
  else process.env.DOCUMENT_AI_LIMIT_PER_HOUR = ORIGINAL;
});

describe("resolveDocumentAiLimitPerHour", () => {
  it("defaults to 6 when the variable is unset", () => {
    expect(resolveDocumentAiLimitPerHour()).toBe(6);
  });

  it("takes an operator value from the environment", () => {
    process.env.DOCUMENT_AI_LIMIT_PER_HOUR = "12";
    expect(resolveDocumentAiLimitPerHour()).toBe(12);
  });

  it("falls back to the default on a non-numeric value", () => {
    process.env.DOCUMENT_AI_LIMIT_PER_HOUR = "plenty";
    expect(resolveDocumentAiLimitPerHour()).toBe(6);
  });

  it("floors at 1 so a zero/negative typo cannot zero the surface out", () => {
    process.env.DOCUMENT_AI_LIMIT_PER_HOUR = "0";
    expect(resolveDocumentAiLimitPerHour()).toBe(1);
    process.env.DOCUMENT_AI_LIMIT_PER_HOUR = "-4";
    expect(resolveDocumentAiLimitPerHour()).toBe(1);
  });

  it("caps at 1000 so a typo cannot remove the ceiling entirely", () => {
    process.env.DOCUMENT_AI_LIMIT_PER_HOUR = "500000";
    expect(resolveDocumentAiLimitPerHour()).toBe(1000);
  });
});

describe("documentAiRateLimited", () => {
  it("mirrors the reset instant into meta.retryAt and the headers", async () => {
    const resetAt = Date.now() + 42 * 60_000;
    const response = documentAiRateLimited({
      allowed: false,
      limit: 60,
      remaining: 0,
      resetAt,
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("X-RateLimit-Reset")).toBe(
      new Date(resetAt).toISOString(),
    );
    const body = (await response.json()) as {
      error: string | null;
      meta?: { errorCode?: string; retryAt?: string };
    };
    expect(body.meta?.errorCode).toBe("documents.inbound.rateLimited");
    expect(body.meta?.retryAt).toBe(new Date(resetAt).toISOString());
  });
});
