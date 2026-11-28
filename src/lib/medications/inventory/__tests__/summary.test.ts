/**
 * v1.16.10 — shared supply-summary math (`summariseSupply`).
 *
 * Pins the release-QA disagreement scenario: a single EXPIRED pen with
 * units left must read as ZERO available supply on every surface
 * (Übersicht supply row, Bestand summary, list payload, GLP-1 endpoint)
 * while the expired units stay visible separately. Both detail-page
 * surfaces render from this helper, so the predicate cannot drift from
 * the list / GLP-1 one (ACTIVE / IN_USE with units only).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  detectSupplyUnderflow,
  isAvailableSupply,
  summariseSupply,
} from "@/lib/medications/inventory/summary";

describe("summariseSupply — expired stock is visible but never available", () => {
  it("one expired pen with units ⇒ 0 available, expired units surfaced separately", () => {
    const out = summariseSupply(
      [{ state: "EXPIRED", unitsTotal: 4, unitsRemaining: 4 }],
      1,
    );
    expect(out).toEqual({
      unitsRemaining: 0,
      unitsTotal: 0,
      dosesRemaining: 0,
      dosesTotal: 0,
      expiredUnits: 4,
    });
  });

  it("pools only ACTIVE / IN_USE containers with units left", () => {
    const out = summariseSupply(
      [
        { state: "IN_USE", unitsTotal: 4, unitsRemaining: 3 },
        { state: "ACTIVE", unitsTotal: 4, unitsRemaining: 4 },
        { state: "USED_UP", unitsTotal: 4, unitsRemaining: 0 },
        { state: "EXPIRED", unitsTotal: 4, unitsRemaining: 4 },
      ],
      2,
    );
    // 7 available units / 2 per dose = 3 doses; capacity 8 units = 4 doses.
    expect(out).toEqual({
      unitsRemaining: 7,
      unitsTotal: 8,
      dosesRemaining: 3,
      dosesTotal: 4,
      expiredUnits: 4,
    });
  });

  it("a drained (used-up) container counts nowhere", () => {
    const out = summariseSupply(
      [{ state: "USED_UP", unitsTotal: 4, unitsRemaining: 0 }],
      1,
    );
    expect(out).toEqual({
      unitsRemaining: 0,
      unitsTotal: 0,
      dosesRemaining: 0,
      dosesTotal: 0,
      expiredUnits: 0,
    });
  });

  it("matches the list-route availability predicate per state", () => {
    expect(
      isAvailableSupply({ state: "ACTIVE", unitsTotal: 4, unitsRemaining: 4 }),
    ).toBe(true);
    expect(
      isAvailableSupply({ state: "IN_USE", unitsTotal: 4, unitsRemaining: 1 }),
    ).toBe(true);
    expect(
      isAvailableSupply({ state: "EXPIRED", unitsTotal: 4, unitsRemaining: 4 }),
    ).toBe(false);
    expect(
      isAvailableSupply({ state: "USED_UP", unitsTotal: 4, unitsRemaining: 0 }),
    ).toBe(false);
    expect(
      isAvailableSupply({ state: "ACTIVE", unitsTotal: 4, unitsRemaining: 0 }),
    ).toBe(false);
  });
});

describe("summariseSupply / detectSupplyUnderflow — central negative-stock sanity gate (#31)", () => {
  it("RCA: an available row whose capacity is NaN (corrupt Decimal) surfaces a NaN headline pre-fix — now clamped to 0, underflow detected", () => {
    // The per-row availability predicate gates only on `unitsRemaining >
    // 0`, so a row with a real remaining but a corrupt / legacy
    // `unitsTotal` (a Decimal that deserialised to NaN) DOES pool in. The
    // pre-fix `reduce` then produced a NaN `unitsTotal` / `dosesTotal`
    // headline — the nonsensical Bestand the report described. The clamp
    // floors it to 0 and the pure detector flags the defect for the
    // server-side caller to record.
    const items = [
      { state: "IN_USE", unitsTotal: Number.NaN, unitsRemaining: 3 },
    ] as const;
    const out = summariseSupply(items, 1);
    expect(out.unitsRemaining).toBe(3);
    expect(out.unitsTotal).toBe(0);
    expect(out.dosesTotal).toBe(0);
    expect(detectSupplyUnderflow(items)).toEqual({
      rawUnitsRemaining: 3,
      rawUnitsTotal: null,
      clampedUnitsRemaining: 3,
      availableCount: 1,
    });
  });

  it("sanity gate: a corrupt remaining (NaN) on an EXPIRED-suffix path floors the expired figure, no underflow", () => {
    // The expired suffix is also pooled; a corrupt EXPIRED row must not
    // surface a NaN suffix. EXPIRED never reaches the available pool, so
    // the detector returns null for it — but the expired figure floors.
    const items = [
      { state: "EXPIRED", unitsTotal: 4, unitsRemaining: Number.NaN },
    ] as const;
    const out = summariseSupply(items, 1);
    expect(out.expiredUnits).toBe(0);
    expect(out.unitsRemaining).toBe(0);
    expect(detectSupplyUnderflow(items)).toBeNull();
  });

  it("fix: a healthy mixed inventory yields the correct pooled figure and no underflow", () => {
    const items = [
      { state: "IN_USE", unitsTotal: 4, unitsRemaining: 3 },
      { state: "ACTIVE", unitsTotal: 4, unitsRemaining: 4 },
    ] as const;
    const out = summariseSupply(items, 2);
    expect(out).toEqual({
      unitsRemaining: 7,
      unitsTotal: 8,
      dosesRemaining: 3,
      dosesTotal: 4,
      expiredUnits: 0,
    });
    expect(detectSupplyUnderflow(items)).toBeNull();
  });
});

describe("supply surfaces — server computes, the detail-page clients render the DTO (source guard)", () => {
  // v1.19.0 (iOS#25) — server-authoritative parity. The detail-page
  // clients used to call `summariseSupply` in the browser; that risked
  // web ↔ iOS drift and dragged the shared math into the client bundle.
  // The SERVER now computes the canonical summary via the one source of
  // truth and ships it in the DTO; the clients render it. This guard is
  // re-pointed at the new seam: (1) the GET inventory route computes the
  // summary through `summariseSupply`, (2) neither client imports the
  // helper as a value, (3) both consume the server `summary` field.
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

  it("the SERVER computes the summary through summariseSupply (single source of truth)", () => {
    const service = read("src/lib/medications/inventory/service.ts");
    expect(service).toContain('from "./summary"');
    expect(service).toMatch(/summariseSupply\(/);
    expect(service).toContain("buildSupplySummary");

    const route = read("src/app/api/medications/[id]/inventory/route.ts");
    // The GET response carries the server-computed summary in the DTO.
    expect(route).toContain("buildSupplySummary");
    expect(route).toMatch(/summary,/);
  });

  it("the Übersicht client renders the server summary and never imports the helper as a value", () => {
    const src = read(
      // The overview's supply line lives in the plan card.
      "src/components/medications/detail/overview/plan-card.tsx",
    );
    // Type-only import is allowed; a value import of the helper is not.
    expect(src).toContain(
      'import type { SupplySummary } from "@/lib/medications/inventory/summary"',
    );
    expect(src).not.toMatch(/^import \{[^}]*summariseSupply/m);
    // The client consumes the server-provided summary, not a local
    // derivation, and still drives the runway with the available figure.
    expect(src).toMatch(/inventory\?\.summary/);
    expect(src).toMatch(
      /estimateRunwayDays\(summary\?\.dosesRemaining \?\? 0, medication\.schedules\)/,
    );
    expect(src).not.toContain('state !== "USED_UP"');
    expect(src).toContain("medications.detail.bestand.expiredSuffix");
  });

  it("the Bestand client renders the server summary and never imports the helper as a value", () => {
    const src = read(
      "src/components/medications/sections/inventory-section.tsx",
    );
    expect(src).toContain(
      'import type { SupplySummary } from "@/lib/medications/inventory/summary"',
    );
    expect(src).not.toMatch(/^import \{[^}]*summariseSupply/m);
    expect(src).toMatch(/data\?\.summary/);
    expect(src).not.toContain('state !== "USED_UP"');
    expect(src).toContain("medications.detail.bestand.expiredSuffix");
  });
});

describe("summariseSupply — whole doses survive binary floating point", () => {
  it("2.4 mL at 0.8 mL per dose is three doses, not two", () => {
    const summary = summariseSupply(
      [{ state: "ACTIVE", unitsRemaining: 2.4, unitsTotal: 2.4 }] as never,
      0.8,
    );
    expect(summary.dosesRemaining).toBe(3);
    expect(summary.dosesTotal).toBe(3);
  });
});
