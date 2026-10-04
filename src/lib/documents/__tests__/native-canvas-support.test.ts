/**
 * Pins the CPU-feature gate for the native canvas renderer: the bundled Skia
 * x64 build uses AVX2, and loading it on a CPU without AVX2 is an uncatchable
 * SIGILL that crash-loops the whole container (live incident on a Celeron
 * NAS). The gate must (a) close on linux/x64 without the avx2 flag, (b) stay
 * open everywhere else, (c) honour the NATIVE_CANVAS override in both
 * directions, and (d) make generateThumbnail fail soft without ever loading
 * the module.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readFileSyncMock } = vi.hoisted(() => ({
  readFileSyncMock: vi.fn(),
}));
vi.mock("node:fs", () => ({ readFileSync: readFileSyncMock }));

import {
  nativeCanvasSupported,
  __resetNativeCanvasSupportForTests,
} from "../native-canvas-support";

const FLAGS_WITH_AVX2 =
  "flags\t\t: fpu vme sse sse2 ssse3 sse4_1 sse4_2 avx avx2 bmi1\n";
const FLAGS_WITHOUT_AVX2 =
  "flags\t\t: fpu vme sse sse2 ssse3 sse4_1 sse4_2 rdrand\n";

function onLinuxX64(fn: () => void): void {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  Object.defineProperty(process, "arch", { value: "x64" });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", platform);
    Object.defineProperty(process, "arch", arch);
  }
}

beforeEach(() => {
  __resetNativeCanvasSupportForTests();
  readFileSyncMock.mockReset();
  delete process.env.NATIVE_CANVAS;
});

afterEach(() => {
  delete process.env.NATIVE_CANVAS;
});

describe("nativeCanvasSupported", () => {
  it("closes on linux/x64 when /proc/cpuinfo lacks the avx2 flag", () => {
    readFileSyncMock.mockReturnValue(`processor: 0\n${FLAGS_WITHOUT_AVX2}`);
    onLinuxX64(() => {
      expect(nativeCanvasSupported()).toBe(false);
    });
  });

  it("stays open on linux/x64 with avx2 present", () => {
    readFileSyncMock.mockReturnValue(`processor: 0\n${FLAGS_WITH_AVX2}`);
    onLinuxX64(() => {
      expect(nativeCanvasSupported()).toBe(true);
    });
  });

  it("fails OPEN when cpuinfo is unreadable (exotic surface, keep today's behavior)", () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error("EACCES");
    });
    onLinuxX64(() => {
      expect(nativeCanvasSupported()).toBe(true);
    });
  });

  it("is always open off linux/x64 — AVX is an x86 concept", () => {
    // The test process itself (darwin/arm64 or linux CI x64 WITH avx2) must
    // never read cpuinfo on non-x64; simulate arm64 explicitly.
    const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
    Object.defineProperty(process, "arch", { value: "arm64" });
    try {
      expect(nativeCanvasSupported()).toBe(true);
      expect(readFileSyncMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "arch", arch);
    }
  });

  it("honours NATIVE_CANVAS=off and =on over detection", () => {
    process.env.NATIVE_CANVAS = "off";
    expect(nativeCanvasSupported()).toBe(false);

    __resetNativeCanvasSupportForTests();
    process.env.NATIVE_CANVAS = "on";
    readFileSyncMock.mockReturnValue(FLAGS_WITHOUT_AVX2);
    onLinuxX64(() => {
      expect(nativeCanvasSupported()).toBe(true);
    });
  });

  it("caches the verdict per process", () => {
    readFileSyncMock.mockReturnValue(`processor: 0\n${FLAGS_WITH_AVX2}`);
    onLinuxX64(() => {
      nativeCanvasSupported();
      nativeCanvasSupported();
    });
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
  });
});

describe("generateThumbnail behind a closed gate", () => {
  it("fails soft without loading the canvas module", async () => {
    process.env.NATIVE_CANVAS = "off";
    __resetNativeCanvasSupportForTests();
    const { generateThumbnail } = await import("../thumbnail");
    const result = await generateThumbnail(
      Buffer.from([0xff, 0xd8, 0xff]),
      "image/jpeg",
    );
    expect(result).toEqual({ ok: false, reason: "native-canvas-unsupported" });
  });
});
