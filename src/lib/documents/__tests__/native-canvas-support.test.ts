/**
 * Pins the CPU-feature gate for the native canvas renderer: the bundled Skia
 * x64 build uses AVX2 and the arm64 musl build LSE atomics and RCpc, and
 * loading either on a CPU without them is an uncatchable SIGILL (live
 * incidents on a Celeron NAS and a Raspberry Pi 4). The gate must (a) close
 * on linux/x64 without the avx2 flag and on linux/arm64 musl without the
 * atomics and lrcpc features, (b) stay open everywhere else, (c) honour the NATIVE_CANVAS override in both
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

  it("is always open off Linux, without reading cpuinfo", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      expect(nativeCanvasSupported()).toBe(true);
      expect(readFileSyncMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  describe("on linux/arm64", () => {
    // Raspberry Pi 4 (Cortex-A72, ARMv8.0) against a Pi 5 (Cortex-A76).
    const PI4 =
      "Features\t: fp asimd evtstrm crc32 cpuid\nCPU implementer\t: 0x41\n";
    const PI5 =
      "Features\t: fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp cpuid asimdrdm lrcpc dcpop asimddp\n";

    function onLinuxArm64(libc: "musl" | "glibc", fn: () => void): void {
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
      Object.defineProperty(process, "platform", { value: "linux" });
      Object.defineProperty(process, "arch", { value: "arm64" });
      const header = libc === "glibc" ? { glibcVersionRuntime: "2.36" } : {};
      const report = vi
        .spyOn(process.report, "getReport")
        .mockReturnValue({ header } as ReturnType<
          typeof process.report.getReport
        >);
      try {
        fn();
      } finally {
        report.mockRestore();
        Object.defineProperty(process, "platform", platform);
        Object.defineProperty(process, "arch", arch);
      }
    }

    it("closes under musl on a core without LSE atomics and RCpc", () => {
      readFileSyncMock.mockReturnValue(`processor\t: 0\n${PI4}`);
      onLinuxArm64("musl", () => {
        expect(nativeCanvasSupported()).toBe(false);
      });
    });

    it("stays open under musl on a core that has both", () => {
      readFileSyncMock.mockReturnValue(`processor\t: 0\n${PI5}`);
      onLinuxArm64("musl", () => {
        expect(nativeCanvasSupported()).toBe(true);
      });
    });

    it("stays open under glibc, whose build needs neither", () => {
      readFileSyncMock.mockReturnValue(`processor\t: 0\n${PI4}`);
      onLinuxArm64("glibc", () => {
        expect(nativeCanvasSupported()).toBe(true);
      });
      expect(readFileSyncMock).not.toHaveBeenCalled();
    });
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
