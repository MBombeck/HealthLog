import { describe, it, vi } from "vitest";

/**
 * GitHub #1277, text first: a local text read used to claim the in-process
 * pdf.js worker for its own copy, and every later rasterization (thumbnails,
 * the vision read of a scan) failed until a restart. See
 * `pdfjs-one-runtime.ts`.
 */

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/logging/signal", () => ({ logCaught: vi.fn() }));

import {
  expectFreshProcess,
  expectRaster,
  expectTextRead,
} from "./pdfjs-one-runtime";

describe("one pdf.js per process (#1277): text read first", () => {
  it("rasterizes after a text read, and reads text again after that", async () => {
    expectFreshProcess();
    await expectTextRead();
    await expectRaster();
    await expectTextRead();
  });
});
