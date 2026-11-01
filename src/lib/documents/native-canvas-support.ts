/**
 * v1.28.27 — CPU-feature gate for the native canvas renderer.
 *
 * The bundled `@napi-rs/canvas` (Skia) x64 builds use AVX2 instructions. On an
 * x86-64 host WITHOUT AVX2 — Celeron/Atom-class NAS CPUs (Goldmont Plus and
 * older) are the common self-hosting case — the first canvas call dies with
 * SIGILL (`trap invalid opcode … in skia.linux-x64-musl.node`), which kills the
 * whole Node process and puts the container into an infinite restart loop
 * (live incident: a Synology DS1520+ self-host, exit code 132 ~18 s after
 * every boot once the thumbnail backfill touched Skia).
 *
 * A SIGILL cannot be caught in-process, so the only safe posture is to never
 * load the module on an unsupported CPU. Every canvas consumer (document
 * thumbnails, scanned-PDF rasterization) already has a fail-soft path — with
 * the gate closed those features degrade cleanly (no thumbnails, PDFs read as
 * text/native only) while the rest of the app runs normally.
 *
 * The arm64 musl build (the one the published arm64 image runs) is compiled
 * for ARMv8.2 and later: it uses LSE atomics (`ldaddal`, `casal`) and RCpc
 * loads (`ldapr`) throughout, with no runtime fallback, and dies with SIGILL
 * as soon as the module loads on an ARMv8.0 core such as the Raspberry Pi 4's
 * Cortex-A72. The glibc arm64 build uses neither, so a glibc host is left
 * alone.
 *
 * Detection reads `/proc/cpuinfo` once on Linux: x64 requires the `avx2`
 * flag, arm64 under musl requires the `atomics` and `lrcpc` features. Every
 * other host (glibc arm64, non-Linux dev machines) is supported. The optional
 * `NATIVE_CANVAS` env var overrides: `off` force-disables (e.g. to rule the
 * renderer out while debugging), `on` force-enables (only sensible if
 * detection misfires; on a CPU that truly lacks the features this WILL crash
 * the process). Unset or any other value → auto-detection.
 */
import { readFileSync } from "node:fs";

import { annotate } from "@/lib/logging/context";

type Verdict =
  | { supported: true }
  | {
      supported: false;
      reason: "cpu_missing_avx2" | "cpu_missing_lse_rcpc" | "override_off";
    };

let cached: Verdict | null = null;
let announced = false;

/** Read the gate once per process; logs a single annotation when closed. */
export function nativeCanvasSupported(): boolean {
  if (cached === null) {
    cached = detect();
  }
  if (!cached.supported && !announced) {
    announced = true;
    annotate({
      action: { name: "documents.nativeCanvas.unsupported" },
      meta: {
        reason: cached.reason,
        arch: process.arch,
        platform: process.platform,
      },
    });
  }
  return cached.supported;
}

const SUPPORTED: Verdict = { supported: true };

function detect(): Verdict {
  const override = process.env.NATIVE_CANVAS?.trim().toLowerCase();
  if (override === "off") return { supported: false, reason: "override_off" };
  if (override === "on") return SUPPORTED;

  if (process.platform !== "linux") return SUPPORTED;
  if (process.arch === "x64") {
    return cpuFeatures("flags", ["avx2"])
      ? SUPPORTED
      : { supported: false, reason: "cpu_missing_avx2" };
  }
  if (process.arch === "arm64" && runsOnMusl()) {
    return cpuFeatures("Features", ["atomics", "lrcpc"])
      ? SUPPORTED
      : { supported: false, reason: "cpu_missing_lse_rcpc" };
  }
  return SUPPORTED;
}

/**
 * Whether the first `/proc/cpuinfo` line starting with `label` names every
 * feature. An unreadable file or a missing line is an exotic kernel surface;
 * it fails OPEN to today's behavior rather than silently disabling a working
 * renderer.
 */
function cpuFeatures(label: string, required: string[]): boolean {
  try {
    const line = readFileSync("/proc/cpuinfo", "utf8")
      .split("\n")
      .find((l) => l.startsWith(label));
    if (!line) return true;
    const present = new Set(
      line
        .slice(line.indexOf(":") + 1)
        .trim()
        .split(/\s+/),
    );
    return required.every((feature) => present.has(feature));
  } catch {
    return true;
  }
}

/** A glibc Node reports the glibc it runs on; a musl one reports none. */
function runsOnMusl(): boolean {
  const header = (
    process.report?.getReport() as
      { header?: { glibcVersionRuntime?: string } } | undefined
  )?.header;
  return header !== undefined && header.glibcVersionRuntime === undefined;
}

/** Test hook — the gate is process-cached by design. */
export function __resetNativeCanvasSupportForTests(): void {
  cached = null;
  announced = false;
}
