/**
 * The two maps `GET /api/auth/me` publishes for a record, and the one thing
 * that must stay true between them.
 *
 * `modules` is the boolean gate every client already reads; `moduleAccess` is
 * the same answer with its reason attached. They are built independently in
 * `buildModuleDisclosure` — the boolean half still runs through
 * `maskModulesToSections` — precisely so this file can assert they agree
 * rather than restate a derivation. Delete the mask from either half and the
 * invariant leg goes red.
 */
import { describe, it, expect } from "vitest";

import { MODULE_KEYS, type ModuleKey } from "@/lib/modules/registry";
import type { ShareDomain } from "@/lib/sharing/scope";

import {
  MODULE_SHARE_DOMAIN,
  buildModuleDisclosure,
} from "../module-disclosure";

function allModules(value: boolean): Record<ModuleKey, boolean> {
  return Object.fromEntries(MODULE_KEYS.map((k) => [k, value])) as Record<
    ModuleKey,
    boolean
  >;
}

const AVAILABLE = allModules(true);

describe("buildModuleDisclosure", () => {
  it("answers enabled / disabled only for a record with no grant over it", () => {
    const resolved = { ...allModules(true), mood: false, labs: false };

    const { moduleAccess } = buildModuleDisclosure(resolved, AVAILABLE, null);

    expect(moduleAccess.mood).toBe("disabled");
    expect(moduleAccess.labs).toBe("disabled");
    expect(moduleAccess.sleep).toBe("enabled");
    expect(new Set(Object.values(moduleAccess))).toEqual(
      new Set(["enabled", "disabled"]),
    );
  });

  it("marks the sections a scoped grant does not open as not_granted", () => {
    const sections: ShareDomain[] = ["measurements"];

    const { moduleAccess } = buildModuleDisclosure(
      allModules(true),
      AVAILABLE,
      sections,
    );

    // Inside the grant.
    expect(moduleAccess.sleep).toBe("enabled");
    expect(moduleAccess.glucose).toBe("enabled");
    // A section the grant does not name.
    expect(moduleAccess.labs).toBe("not_granted");
    expect(moduleAccess.cycle).toBe("not_granted");
    // Record-spanning: no scoped grant opens a module with a null domain, so
    // the answer is the same one the boolean mask gives.
    for (const key of MODULE_KEYS) {
      if (MODULE_SHARE_DOMAIN[key] === null) {
        expect(moduleAccess[key], key).toBe("not_granted");
      }
    }
  });

  it("never says not_granted for an unscoped grant or an own record", () => {
    // `null` sections are both cases at once: an own-record session has no
    // grant to narrow to, and an unscoped grant names the whole record.
    const { moduleAccess } = buildModuleDisclosure(
      { ...allModules(true), coach: false },
      AVAILABLE,
      null,
    );
    expect(Object.values(moduleAccess)).not.toContain("not_granted");
    expect(moduleAccess.coach).toBe("disabled");
  });

  it("lets the operator's instance-wide switch outrank every other reason", () => {
    const operator = { ...AVAILABLE, labs: false, sleep: false };
    // The resolved map already has the operator layer AND-ed in, which is why
    // an operator-off module arrives here as `false` and would otherwise be
    // indistinguishable from the record's own choice.
    const resolved = { ...allModules(true), labs: false, sleep: false };

    // Off for the record's own session…
    const own = buildModuleDisclosure(resolved, operator, null);
    expect(own.moduleAccess.labs).toBe("unavailable");

    // …and still the operator's switch under a grant that does not open the
    // section, because the switch that would have to move is theirs either way.
    const scoped = buildModuleDisclosure(resolved, operator, ["measurements"]);
    expect(scoped.moduleAccess.labs).toBe("unavailable");
    expect(scoped.moduleAccess.sleep).toBe("unavailable");
    expect(scoped.moduleAccess.cycle).toBe("not_granted");
  });

  it("keeps modules[key] equal to moduleAccess[key] === enabled everywhere", () => {
    const sectionSets: Array<readonly ShareDomain[] | null> = [
      null,
      [],
      ["measurements"],
      ["measurements", "labs"],
      ["cycle", "mind", "medications", "illness", "documents", "profile"],
    ];
    const resolvedMaps = [
      allModules(true),
      allModules(false),
      { ...allModules(true), mood: false, cycle: false, medications: false },
    ];
    const operatorMaps = [
      AVAILABLE,
      allModules(false),
      { ...AVAILABLE, insights: false, mood: false },
    ];

    let checked = 0;
    for (const sections of sectionSets) {
      for (const resolved of resolvedMaps) {
        for (const operator of operatorMaps) {
          // The operator layer is AND-ed into the resolved map upstream; mirror
          // that here or the fixture would describe a state the gate cannot
          // produce.
          const effective = Object.fromEntries(
            MODULE_KEYS.map((k) => [k, resolved[k] && operator[k]]),
          ) as Record<ModuleKey, boolean>;
          const { modules, moduleAccess } = buildModuleDisclosure(
            effective,
            operator,
            sections,
          );
          for (const key of MODULE_KEYS) {
            expect(
              modules[key],
              `${key} under sections=${JSON.stringify(sections)}`,
            ).toBe(moduleAccess[key] === "enabled");
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBe(
      sectionSets.length *
        resolvedMaps.length *
        operatorMaps.length *
        MODULE_KEYS.length,
    );
    expect(checked).toBeGreaterThan(0);
  });
});
