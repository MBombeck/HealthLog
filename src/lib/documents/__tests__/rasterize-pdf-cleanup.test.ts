import { Buffer } from "node:buffer";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { destroyLoadingTask } = vi.hoisted(() => ({
  destroyLoadingTask: vi.fn(async () => undefined),
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: () => ({
    destroy: destroyLoadingTask,
    promise: Promise.resolve({
      numPages: 1,
      canvasFactory: {
        create: () => ({
          canvas: {
            width: 1,
            height: 1,
            toBuffer: () => Buffer.from([0xff, 0xd8]),
          },
          // One black pixel: an inked page, so the blank-page guard passes.
          context: {
            getImageData: () => ({
              data: new Uint8ClampedArray([0, 0, 0, 255]),
            }),
          },
        }),
      },
      getPage: async () => ({
        getViewport: ({ scale }: { scale: number }) => ({
          width: 100 * scale,
          height: 100 * scale,
        }),
        render: () => ({ promise: Promise.resolve() }),
        cleanup: vi.fn(),
      }),
    }),
  }),
}));

import { renderPdfPages } from "../pdf-engine.mjs";

describe("renderPdfPages PDF.js lifecycle", () => {
  beforeEach(() => {
    destroyLoadingTask.mockClear();
  });

  it("destroys the loading task after rendering", async () => {
    await expect(
      renderPdfPages(Buffer.from("synthetic"), {
        maxPages: 1,
        targetLongEdge: 1600,
        jpegQuality: 80,
        minInkRatio: 0.0001,
      }),
    ).resolves.toMatchObject({ pageCount: 1 });
    expect(destroyLoadingTask).toHaveBeenCalledOnce();
  });
});
