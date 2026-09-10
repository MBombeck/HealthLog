/**
 * v1.38.12 — the delegated-write table is the routes, frozen.
 *
 * `src/lib/sharing/domain-write-support.ts` says, per section, whether any
 * route accepts a delegated `"write"` and whether any accepts a delegated
 * `"manage"`. The account payload publishes a grant's intersection with that
 * table, and every add / edit / delete control in a shared record reads the
 * result. So the table is an access-shaped fact about the route tree, and a
 * table that drifted from the tree would either paint a control that 403s
 * (table says yes, no route) or hide one the server accepts (route exists,
 * table says no) — the two failures #939 was made of.
 *
 * This guard re-derives the table from the route files and fails on a
 * disagreement in EITHER direction. It scans every `route.ts` under
 * `src/app/api` for `requireRecordAuth("write" | "manage", "<domain>")`,
 * whitespace-tolerant across the line break a formatter may put after the
 * opening parenthesis (the matcher lesson from
 * `bearer-scope-enforcement-guard.test.ts`: a literal that demanded one line
 * matched nothing and was green for it). An empty match set is a failure, not
 * a clean sweep.
 *
 * `record` is skipped on purpose: it is not a member of `SHARE_DOMAINS`, and a
 * route declaring it reads across sections rather than writing to one. A
 * domain outside the vocabulary other than `record` fails the run outright,
 * because the table is keyed on the vocabulary and would silently lack it.
 *
 * What it deliberately does not hold, stated so nobody reads more into a green
 * run than it earns: the table is EXISTENTIAL per section. It answers "does
 * any route in this section accept this need", and within a section the answer
 * varies by verb — `POST /api/encounters` is WRITE while `POST /api/allergies`
 * beside it is MANAGE, both under `profile`. So this guard proves the table
 * and the routes agree about the section, never that one control's own verb is
 * covered. That is the control's job: it asks the hook for its own verb class,
 * and a control that read "my section is writable, therefore my create is"
 * would be wrong in three of the four sections marked writable.
 *
 * Mutation checks, run:
 *   - set `mind.write` to `true` in the table → "agrees with the routes" red;
 *   - change `requireRecordAuth("manage", "mind")` in `mood-entries/route.ts`
 *     to `"write"` → red, in the other direction;
 *   - point `API_ROOT` at an empty directory → the non-zero floor goes red.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DOMAIN_WRITE_SUPPORT,
  delegatedDomains,
} from "@/lib/sharing/domain-write-support";
import { SHARE_DOMAINS, type ShareDomain } from "@/lib/sharing/scope";

import { walkSourceFiles } from "./helpers/source-files";

const API_ROOT = join(process.cwd(), "src", "app", "api");

/**
 * Whitespace-tolerant on both sides of the comma and after the parenthesis.
 * `[a-z-]+` rather than the vocabulary, so a route naming a section this
 * file has never heard of is reported instead of ignored.
 */
const DELEGATED_WRITE =
  /requireRecordAuth\(\s*"(write|manage)"\s*,\s*"([a-z-]+)"/g;

interface Observed {
  write: Set<string>;
  manage: Set<string>;
  matches: number;
  unknown: string[];
}

function observe(): Observed {
  const out: Observed = {
    write: new Set(),
    manage: new Set(),
    matches: 0,
    unknown: [],
  };
  const known = new Set<string>(SHARE_DOMAINS);
  for (const rel of walkSourceFiles(API_ROOT, { floor: 100 })) {
    if (!rel.endsWith("route.ts")) continue;
    const source = readFileSync(join(API_ROOT, rel), "utf8");
    for (const m of source.matchAll(DELEGATED_WRITE)) {
      out.matches += 1;
      const need = m[1] as "write" | "manage";
      const domain = m[2];
      if (domain === "record") continue;
      if (!known.has(domain)) {
        out.unknown.push(`${rel}: ${need} ${domain}`);
        continue;
      }
      out[need].add(domain);
    }
  }
  return out;
}

describe("the delegated-write table agrees with the routes", () => {
  const observed = observe();

  it("scanned a non-trivial route tree", () => {
    // Below this, the matcher is broken rather than the tree small: the
    // measurements, medications, labs and profile families alone carry more.
    expect(observed.matches).toBeGreaterThan(50);
    expect(observed.write.size).toBeGreaterThan(0);
    expect(observed.manage.size).toBeGreaterThan(0);
  });

  it("names no section outside the vocabulary", () => {
    expect(observed.unknown).toEqual([]);
  });

  it("agrees with the routes, section by section, in both directions", () => {
    const derived = Object.fromEntries(
      SHARE_DOMAINS.map((domain) => [
        domain,
        {
          write: observed.write.has(domain),
          manage: observed.manage.has(domain),
        },
      ]),
    ) as Record<ShareDomain, { write: boolean; manage: boolean }>;
    expect(DOMAIN_WRITE_SUPPORT).toEqual(derived);
  });

  it("keys the table on the whole vocabulary and nothing else", () => {
    expect(Object.keys(DOMAIN_WRITE_SUPPORT).sort()).toEqual(
      [...SHARE_DOMAINS].sort(),
    );
  });
});

describe("delegatedDomains", () => {
  it("answers nothing for a read grant", () => {
    expect(delegatedDomains("read", null, "write")).toEqual([]);
    expect(delegatedDomains("read", null, "manage")).toEqual([]);
  });

  it("gives a write grant its write sections and no manage sections", () => {
    const writable = delegatedDomains("write", null, "write");
    for (const domain of writable) {
      expect(DOMAIN_WRITE_SUPPORT[domain].write, domain).toBe(true);
    }
    expect(writable).not.toContain("mind");
    expect(writable).not.toContain("documents");
    expect(delegatedDomains("write", null, "manage")).toEqual([]);
  });

  it("gives a manage grant every section with a delegated route, and never the vault", () => {
    const writable = delegatedDomains("manage", null, "write");
    const manageable = delegatedDomains("manage", null, "manage");
    expect(manageable).toContain("mind");
    expect(manageable).toContain("profile");
    expect(manageable).not.toContain("documents");
    expect(writable).not.toContain("documents");
    // manageable ⊆ writable: a section a grant can manage is one it can add to.
    for (const domain of manageable) expect(writable).toContain(domain);
  });

  it("narrows to the grant's sections, keeping consent order", () => {
    expect(
      delegatedDomains("write", ["labs", "measurements"], "write"),
    ).toEqual(["measurements", "labs"]);
    expect(delegatedDomains("write", ["documents"], "write")).toEqual([]);
    expect(delegatedDomains("write", [], "write")).toEqual([]);
  });
});
