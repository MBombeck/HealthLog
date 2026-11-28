/**
 * A document summary the model returned wrapped (`{"summary": "…"}`) is
 * stored as its text, and one stored wrapped before is shown as its text and
 * rewritten once, only while the row still holds the bytes that were read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { inboundDocument: { updateMany: (a: unknown) => updateMany(a) } },
}));

import { _resetCryptoCacheForTests } from "@/lib/crypto";
import {
  decryptDocumentSummary,
  encryptDocumentSummary,
  serialiseDocumentDetail,
  type SerialisableDocument,
} from "@/lib/documents/store";
import { runDocumentSummary } from "@/lib/documents/describe";
import type { AIProvider } from "@/lib/ai/types";

const KEY_V1 =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEXT = "A discharge letter from a hospital ward.";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("ENCRYPTION_KEYS", "");
  vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
  vi.stubEnv("ENCRYPTION_KEY", KEY_V1);
  _resetCryptoCacheForTests();
  updateMany.mockReset().mockResolvedValue({ count: 1 });
});

function row(summary: string): SerialisableDocument {
  return {
    id: "doc-1",
    userId: "user-1",
    kind: "OTHER",
    title: "Letter",
    filename: "letter.pdf",
    mimeType: "application/pdf",
    byteSize: 1,
    contentCodec: "binary2",
    status: "STORED",
    summaryEncrypted: encryptDocumentSummary(summary),
    summaryGeneratedAt: new Date("2026-11-20T09:00:00Z"),
    summaryState: "READY",
    createdAt: new Date("2026-11-20T00:00:00Z"),
    updatedAt: new Date("2026-11-20T00:00:00Z"),
    deletedAt: null,
  } as unknown as SerialisableDocument;
}

describe("a wrapped document summary", () => {
  it("is generated as its text", async () => {
    const provider = {
      generateCompletion: async () => ({
        content: "```json\n" + JSON.stringify({ summary: TEXT }) + "\n```",
      }),
    } as unknown as AIProvider;
    const { summary, blocked } = await runDocumentSummary({
      provider,
      providerType: "openai",
      ocrText: "Entlassbrief",
      locale: "en",
    });
    expect(blocked).toBeNull();
    expect(summary).toBe(TEXT);
  });

  it("stored before is shown as its text and repaired once", async () => {
    const doc = row(JSON.stringify({ summary: TEXT }));
    const dto = serialiseDocumentDetail(doc, []);
    expect(dto.summary).toBe(TEXT);
    await vi.waitFor(() => expect(updateMany).toHaveBeenCalledTimes(1));
    const call = updateMany.mock.calls[0][0] as {
      where: {
        id: string;
        userId: string;
        summaryEncrypted: { equals: Buffer };
      };
      data: { summaryEncrypted: Uint8Array };
    };
    expect(call.where.id).toBe("doc-1");
    expect(call.where.userId).toBe("user-1");
    expect(
      Buffer.from(call.where.summaryEncrypted.equals).equals(
        Buffer.from(doc.summaryEncrypted!),
      ),
    ).toBe(true);
    expect(decryptDocumentSummary(call.data.summaryEncrypted)).toBe(TEXT);
  });

  it("a clean summary is never rewritten", async () => {
    const dto = serialiseDocumentDetail(row(TEXT), []);
    expect(dto.summary).toBe(TEXT);
    await new Promise((r) => setTimeout(r, 10));
    expect(updateMany).not.toHaveBeenCalled();
  });
});
