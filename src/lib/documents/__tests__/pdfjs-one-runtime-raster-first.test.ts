import { describe, it, vi } from "vitest";

/**
 * GitHub #1277, rasterization first: a render used to claim the in-process
 * pdf.js worker for its own copy, and every later local text read failed
 * without a word, leaving the document out of the search index. See
 * `pdfjs-one-runtime.ts`.
 */

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/logging/signal", () => ({ logCaught: vi.fn() }));

import {
  expectFreshProcess,
  expectRaster,
  expectTextRead,
} from "./pdfjs-one-runtime";

describe("one pdf.js per process (#1277): rasterization first", () => {
  it("reads text after a rasterization, and rasterizes again after that", async () => {
    expectFreshProcess();
    await expectRaster();
    await expectTextRead();
    await expectRaster();
  });
});
