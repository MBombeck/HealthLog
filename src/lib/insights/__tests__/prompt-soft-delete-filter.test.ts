/**
 * v1.15.20 — soft-deleted rows must never reach an AI prompt snapshot.
 *
 * The user-facing DELETE flips `deletedAt` instead of removing the row,
 * so every prompt-feeding read has to filter the tombstones explicitly.
 * Three status generators (general / weight / bmi) and the Coach
 * snapshot's intake read shipped without the filter; this guard pins
 * the `deletedAt: null` predicate at each of those call sites so a
 * future query rewrite cannot silently drop it (same source-guard
 * pattern the queue-registration tests use).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

function read(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, rel), "utf8");
}

describe("prompt reads exclude tombstoned rows", () => {
  it("general-status filters its measurement read", () => {
    // The overview reads through the per-type latest-readings query.
    expect(read("../general-status.ts")).toMatch(/readLatestReadingsPerType\(/);
    expect(read("../recent-readings.ts")).toMatch(
      /readLatestReadingsPerType[\s\S]*?m\."deleted_at" IS NULL/,
    );
  });

  it("weight-status filters its measurement read", () => {
    // The weight series reads through the per-type newest-rows query.
    expect(read("../weight-status.ts")).toMatch(/readNewestRowsPerType\(/);
    expect(read("../../measurements/newest-per-type.ts")).toMatch(
      /readNewestRowsPerType[\s\S]*?m\."deleted_at" IS NULL/,
    );
  });

  it("bmi-status filters its measurement read", () => {
    const src = read("../bmi-status.ts");
    expect(src).toMatch(
      /measurement\s*\n?\s*\.findMany\(\{\s*where:\s*\{[\s\S]{0,300}?\bdeletedAt:\s*null/,
    );
  });

  it("the Coach snapshot filters its intake read", () => {
    // v1.16.9 — the compliance timeline reads intake events through the
    // medication relation (`intakeEvents`) so the ledger can be rebuilt
    // per medication; the tombstone filter must ride on that nested read.
    const src = read("../../ai/coach/snapshot.ts");
    const intakeRead = src.match(
      /intakeEvents:\s*\{[\s\S]{0,300}?where:\s*\{[^}]*\}/,
    );
    expect(intakeRead).not.toBeNull();
    expect(intakeRead![0]).toContain("deletedAt: null");
  });
  // A soft delete has to be able to reach the CACHE GATE as well as the
  // prompt. `buildStatusInputHash` fingerprints "how much data is there and
  // how new is it"; a tombstoned row that still counts leaves the fingerprint
  // unchanged, the gate re-dates yesterday's assessment, and text reasoning
  // over a deleted reading is served as today's. The measurement arm of that
  // same query already filters, which is what makes the two that did not so
  // easy to miss.
  it("the status input hash filters its mood aggregate", () => {
    const src = read("../status-cache.ts");
    const moodRead = src.match(
      /moodEntry\s*\n?\s*\.aggregate\(\{[\s\S]{0,800}?where:\s*\{[^}]*\}/,
    );
    expect(moodRead).not.toBeNull();
    expect(moodRead![0]).toContain("deletedAt: null");
  });

  it("the status input hash filters its custom-metric entry reads", () => {
    const src = read("../status-cache.ts");
    // Both the count and the newest-entry probe: either one left unfiltered
    // keeps the fingerprint still after a delete.
    expect(src).toMatch(
      /_count:\s*\{\s*select:\s*\{\s*entries:\s*\{[\s\S]{0,200}?deletedAt:\s*null/,
    );
    const newest = src.match(
      /entries:\s*\{\s*where:\s*\{[^}]*\}[\s\S]{0,200}?take:\s*1/,
    );
    expect(newest).not.toBeNull();
    expect(newest![0]).toContain("deletedAt: null");
  });

  it("the custom-metric correlation channel filters its entry read", () => {
    // The parent metric's own tombstone is filtered; its entries' were not,
    // so a reading the person deleted still shaped the correlation cards.
    const src = read("../correlation-channel-series.ts");
    const entryRead = src.match(
      /entries:\s*\{[\s\S]{0,400}?where:\s*\{[^}]*\}/,
    );
    expect(entryRead).not.toBeNull();
    expect(entryRead![0]).toContain("deletedAt: null");
  });
});
