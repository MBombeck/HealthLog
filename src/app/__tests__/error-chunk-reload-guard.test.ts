/**
 * Unit tests for the chunk-error auto-reload guard in
 * `src/lib/pwa/chunk-reload.ts` (both error boundaries call it).
 *
 * The guard is keyed on the running shell's build version: one reload
 * attempt per BROKEN SHELL, not one per session. After a successful
 * heal the reloaded page carries the new version and the guard re-arms
 * by construction; the pre-v1.16.8 once-per-session key exhausted on
 * multi-deploy days and stranded the user on the error page.
 */

import { describe, expect, it } from "vitest";

import {
  chunkReloadGuardValue,
  isChunkLoadError,
  shouldAttemptChunkReload,
} from "@/lib/pwa/chunk-reload";

describe("shouldAttemptChunkReload", () => {
  it("reloads when no attempt is recorded", () => {
    expect(shouldAttemptChunkReload(null, "1.16.8")).toBe(true);
  });

  it("suppresses a second reload for the SAME shell version", () => {
    const stored = chunkReloadGuardValue("1.16.8");
    expect(shouldAttemptChunkReload(stored, "1.16.8")).toBe(false);
  });

  it("re-arms after a deploy — the reloaded shell carries a NEW version", () => {
    const stored = chunkReloadGuardValue("1.16.8");
    expect(shouldAttemptChunkReload(stored, "1.16.9")).toBe(true);
  });

  it("treats a legacy timestamp guard value as no attempt", () => {
    // Pre-v1.16.8 sessions stored `String(Date.now())`; it never matches
    // a guard value, so a stranded session heals on its next chunk error.
    expect(shouldAttemptChunkReload("1765400000000", "1.16.8")).toBe(true);
  });

  it("degrades to once-per-shell-lifetime when no version is injected", () => {
    expect(chunkReloadGuardValue("")).toBe("unversioned");
    expect(shouldAttemptChunkReload(null, "")).toBe(true);
    expect(shouldAttemptChunkReload("unversioned", "")).toBe(false);
  });
});

describe("isChunkLoadError", () => {
  it.each([
    [{ name: "ChunkLoadError", message: "x" }],
    [{ name: "Error", message: "Loading chunk 123 failed." }],
    [{ name: "Error", message: "Loading CSS chunk 7 failed." }],
    [
      {
        name: "Error",
        message: "Failed to load chunk /_next/static/chunks/a.js",
      },
    ],
    [
      {
        name: "TypeError",
        message: "Failed to fetch dynamically imported module: /x.js",
      },
    ],
    // WebKit and Firefox word a failed dynamic import differently.
    [{ name: "TypeError", message: "Importing a module script failed." }],
    [
      {
        name: "TypeError",
        message: "error loading dynamically imported module: /x.js",
      },
    ],
  ])("recognises %j", (err) => {
    expect(isChunkLoadError(err)).toBe(true);
  });

  it("leaves other errors to the error page", () => {
    expect(
      isChunkLoadError({ name: "TypeError", message: "x is undefined" }),
    ).toBe(false);
  });
});
