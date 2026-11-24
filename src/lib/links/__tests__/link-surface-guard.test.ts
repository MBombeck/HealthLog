/**
 * Structural guard: the link tables have exactly one gateway.
 *
 * `src/lib/links/` owns every read and write of the narrow link tables this
 * venture introduced — the three encounter link tables, the document↔condition
 * table, and the vaccination↔document table. The whole point of routing both
 * link families through one module with one signature is that #203's later
 * absorption of these tables into a single join model is a storage change here,
 * not a sweep across every route that files something. That property is only
 * real if nothing outside the module touches the tables directly, and a claim
 * about "nothing outside" is exactly what a structural guard can hold and a
 * behavioural test cannot.
 *
 * This is a tripwire, not a proof. It cannot show the service is correct — only
 * that a call to one of its tables has not appeared outside it without someone
 * editing this file. A reviewer who waves through a new exemption defeats it.
 *
 * Its own limit, stated so a future reader does not mistake it for more than it
 * is: the matcher recognises a delegate accessed off `prisma` or `tx`, the two
 * client identifiers this codebase uses. A transaction bound to some other name
 * would slip it. That is the same class of limit the Bearer-scope and
 * session-surface guards document about themselves, and the mitigation is the
 * same: the matcher is proven non-vacuous below (it MUST match inside the
 * module), so it cannot silently match nothing and pass for the wrong reason.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "@/__tests__/helpers/source-files";

const SRC = join(process.cwd(), "src");

/**
 * The link tables `src/lib/links/` is the sole gateway for. A sixth table, or a
 * new caller of one of these five outside the module, is the signature leaking
 * out of its one home.
 */
const LINK_DELEGATES = [
  "documentConditionLink",
  "encounterDocumentLink",
  "encounterLabLink",
  "encounterConditionLink",
  "vaccinationDocumentLink",
  // v1.43 — the five tables that close the relation matrix.
  "labResultDocumentLink",
  "encounterMedicationLink",
  "encounterVaccinationLink",
  "medicationDocumentLink",
  "medicationConditionLink",
] as const;

/**
 * A delegate accessed off a Prisma client. Whitespace-tolerant around the dot
 * so `tx . encounterDocumentLink` cannot dodge it, and the delegate name is
 * captured so a match can be attributed to the exact table.
 */
const LINK_CALL_RE = new RegExp(
  String.raw`\b(?:prisma|tx)\s*\.\s*(${LINK_DELEGATES.join("|")})\b`,
  "g",
);

/** The module that is ALLOWED — and required — to hold these calls. */
const MODULE_DIR = "lib/links/";

/**
 * The files exempt by the same standing rule the wipe and key-rotation writers
 * hold: a backup RESTORE rebuilds an account rather than filing something in
 * one, so it preserves ids and creation instants and writes the link tables
 * directly. The set is frozen here so the next one arrives as a diff a human
 * reviewed rather than as a quiet spread.
 */
const RESTORE_EXEMPTIONS = [
  "lib/export/visits-backup.ts",
  // The visits restore's own link half, kept in its own file beside it: the
  // same restore, the same standing rule.
  "lib/export/visit-links-restore.ts",
  "lib/export/vaccinations-backup.ts",
  // The document↔condition filing, carried and restored from the release that
  // takes it off the backup debt register. Same standing rule as the two
  // above: it re-creates the link with the instant it was originally filed at,
  // which the service's filing signature has no way to express.
  "lib/export/document-filing-backup.ts",
  // The five relation links (v1.43), same standing rule.
  "lib/export/relation-links-backup.ts",
].sort();

/** Every non-test, non-generated source file under `src/`, relative to `src/`. */
function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

/** Every delegate name the call regex matches in `text`, in order. */
function matchedDelegates(text: string): string[] {
  return [...text.matchAll(LINK_CALL_RE)].map((m) => m[1]);
}

describe("link-surface guard — the tables have one gateway", () => {
  it("no file outside src/lib/links calls the owned link tables (except the frozen restore exemption)", () => {
    const offenders: string[] = [];
    for (const rel of sourceFiles()) {
      if (rel.startsWith(MODULE_DIR)) continue;
      if (RESTORE_EXEMPTIONS.includes(rel)) continue;
      const matches = matchedDelegates(read(rel));
      if (matches.length > 0) {
        offenders.push(`${rel} → ${[...new Set(matches)].sort().join(", ")}`);
      }
    }
    expect(
      offenders,
      "A link table is accessed outside src/lib/links/. Route the call through " +
        "the link service (linkTargets / unlinkTargets / replaceTargets / " +
        "listTargets*), or, if it is a backup restore, add it to the frozen " +
        "RESTORE_EXEMPTIONS with a reason.",
    ).toEqual([]);
  });

  it("the matcher is non-vacuous: the link service itself is matched for every owned table", () => {
    // A guard whose matcher matches nothing is green for the wrong reason. The
    // module MUST match — and must match every one of the five tables — or the
    // sweep above proves nothing.
    const moduleText = read("lib/links/link-service.ts");
    const matched = new Set(matchedDelegates(moduleText));
    expect(matched.size).toBeGreaterThan(0);
    for (const delegate of LINK_DELEGATES) {
      expect(
        matched.has(delegate),
        `The link service does not reach ${delegate} through prisma/tx — the ` +
          `matcher no longer covers it, so the sweep above would miss a leak of it.`,
      ).toBe(true);
    }
  });

  it("the restore exemption set is exactly the backup writers named here", () => {
    // Freeze the exemption list so widening it is a reviewed diff, not a quiet
    // addition. Every file must exist and must actually write a link table.
    for (const rel of RESTORE_EXEMPTIONS) {
      expect(matchedDelegates(read(rel)).length).toBeGreaterThan(0);
    }
    expect(RESTORE_EXEMPTIONS).toEqual(
      [
        "lib/export/document-filing-backup.ts",
        "lib/export/relation-links-backup.ts",
        "lib/export/vaccinations-backup.ts",
        "lib/export/visit-links-restore.ts",
        "lib/export/visits-backup.ts",
      ].sort(),
    );
  });
});
