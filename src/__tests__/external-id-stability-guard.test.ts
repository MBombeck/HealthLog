/**
 * Structural guard on the external-id stability floor.
 *
 * A client-supplied `externalId` is half of every ingest dedup key. An id
 * that rotates between client launches never matches its own earlier row,
 * so each sync sweep mints a fresh record — the failure mode that filled a
 * live instance with phantom medications, one per sweep, none of which
 * could ever collect a dose.
 *
 * The fix is only durable if it cannot be bypassed by the NEXT route.
 * These guards freeze the two legal ways to accept the field:
 *
 *   1. the request schema routes it through `assertStableExternalId`, so
 *      the refusal rides the standard 422 multi-issue envelope; or
 *   2. the field is deliberately permissive because a schema-level refusal
 *      would fail a whole batch on one bad row — in which case the
 *      declaration carries an `@external-id-checked-per-entry: <path>`
 *      marker naming the file that runs `classifyExternalId` per entry,
 *      and this guard verifies that file really does.
 *
 * They are tripwires, not proofs. A reviewer who waves through a bad
 * addition defeats them, and no test substitutes for that review.
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";

import {
  readSource,
  readSourceText,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");
const VALIDATOR_MODULE = "@/lib/validations/external-id";

function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

function read(rel: string): string {
  return readSourceText(join(SRC, rel));
}

/**
 * The file with its `import … from "…";` statements removed.
 *
 * A guard that greps the raw source cannot tell "this file APPLIES the
 * check" from "this file merely imports it" — deleting the call while
 * leaving the import would slip straight through. Every usage assertion
 * below therefore runs against the body, and the module import is
 * asserted separately where it matters.
 */
function body(rel: string): string {
  return read(rel).replace(/import\s+[\s\S]*?from\s+"[^"]+";/g, "");
}

/**
 * A REQUEST-side declaration of a client-supplied identity string:
 * `externalId: z.…` / `externalSourceId: z.…` / `idempotencyKey: z.…` in a
 * Zod object shape.
 *
 * `idempotencyKey` is here because `MedicationIntakeEvent.idempotency_key`
 * is NOT a windowed replay token — it is a `@unique` column persisted with
 * the dose row forever and matched by plain equality, which makes it an
 * identity with the same failure mode. The HTTP `Idempotency-Key` HEADER
 * is a different thing and stays out: `IdempotencyKey.expiresAt` bounds it
 * and `lib/jobs/idempotency-cleanup.ts` sweeps it.
 *
 * Response DTOs under `lib/openapi/` are excluded below — those echo a
 * value the server already stored and validating them would be validating
 * our own output.
 */
const DECLARATION =
  /^\s*(externalId|externalSourceId|idempotencyKey)\s*:\s*z\b/gm;

/** `// @external-id-checked-per-entry: <path under repo root>` */
const MARKER = /@external-id-checked-per-entry:\s*(\S+)/;

/**
 * Files that declare the field but are deliberately outside the floor.
 * Each entry states WHY; an addition here is a decision, not a shortcut.
 */
const EXEMPT: Record<string, string> = {
  // Backup restore reads a payload the SERVER itself wrote and encrypted.
  // It has to reproduce the stored rows byte-for-byte — including ids that
  // predate this floor — or a self-hoster with an already-poisoned export
  // could never restore it. Nothing client-authored reaches this schema.
  "lib/validations/backup.ts":
    "restore payload is a server-written backup; refusing a stored id would block a restore",
};

/**
 * The backup payload schema is composed from one slice per domain, each a
 * part of the same server-written file, so every slice carries the payload's
 * exemption and its reason.
 */
const BACKUP_SCHEMA_SLICE =
  /^lib\/(?:export\/[\w-]+-backup-schema|cycle\/backup-schema)\.ts$/;

function exemptionFor(rel: string): string | undefined {
  if (rel in EXEMPT) return EXEMPT[rel];
  return BACKUP_SCHEMA_SLICE.test(rel)
    ? EXEMPT["lib/validations/backup.ts"]
    : undefined;
}

/**
 * Trees where a stored identity is derived from input that never passes
 * through a Zod request schema — an uploaded file's row, or an MCP host's
 * tool argument. The declaration rule above cannot see those, so this one
 * works on provenance instead: inside these trees, any module that touches
 * an identity must either apply the floor itself or import a module that
 * does.
 *
 * That is a real chain, not a list of known offenders: a NEW importer that
 * mints an `externalId` from file input and imports nothing checked fails
 * here, with no allowlist to add itself to.
 */
const DERIVED_IDENTITY_TREES = ["lib/import/", "app/api/import/", "lib/mcp/"];

const IDENTITY_MENTION = /\b(externalId|idempotencyKey)\b/;

/** Floor symbols that count as "this module applies the check itself". */
const FLOOR_SYMBOLS = [
  "classifyExternalId",
  "isStableExternalId",
  "assertStableExternalId",
  "assertStableIdempotencyKey",
];

/** Local `@/…` and relative modules this file imports, as src-relative paths. */
function importedLocalModules(rel: string): string[] {
  const source = read(rel);
  const dir = rel.split("/").slice(0, -1).join("/");
  const out: string[] = [];
  for (const m of source.matchAll(/from\s+"([^"]+)"/g)) {
    const spec = m[1];
    let target: string | null = null;
    if (spec.startsWith("@/")) target = spec.slice(2);
    else if (spec.startsWith("./")) target = `${dir}/${spec.slice(2)}`;
    else if (spec.startsWith("../")) {
      const parts = dir.split("/");
      let rest = spec;
      while (rest.startsWith("../")) {
        parts.pop();
        rest = rest.slice(3);
      }
      target = [...parts, rest].join("/");
    }
    if (target) out.push(target.replace(/\.tsx?$/, ""));
  }
  return out;
}

function appliesFloor(rel: string): boolean {
  const b = body(rel);
  return FLOOR_SYMBOLS.some((sym) => b.includes(sym));
}

/** Lines of `rel` (1-based) on which a request-side declaration appears. */
function declarationLines(rel: string): number[] {
  const source = read(rel);
  const lines: number[] = [];
  DECLARATION.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DECLARATION.exec(source)) !== null) {
    lines.push(source.slice(0, m.index).split("\n").length);
  }
  return lines;
}

function declaringFiles(): string[] {
  return sourceFiles()
    .filter((rel) => !rel.startsWith("lib/openapi/"))
    .filter((rel) => declarationLines(rel).length > 0);
}

describe("every client-supplied external id routes through the stability floor", () => {
  it("finds the declaring files at all (the matcher still matches)", () => {
    // A guard whose matcher silently stops matching passes forever. Pin the
    // known set so a rename of the field or of the Zod idiom trips here.
    const files = declaringFiles();
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(files).toContain("app/api/measurements/batch/route.ts");
    expect(files).toContain("lib/validations/medication/create-update.ts");
  });

  it.each(declaringFiles())(
    "%s either applies the field check or names the per-entry checker",
    (rel) => {
      const exemption = exemptionFor(rel);
      if (exemption !== undefined) {
        expect(exemption.length).toBeGreaterThan(20);
        return;
      }

      const usesFieldCheck =
        read(rel).includes(VALIDATOR_MODULE) &&
        (body(rel).includes("assertStableExternalId") ||
          body(rel).includes("assertStableIdempotencyKey"));
      const marksPerEntry = MARKER.test(read(rel));
      expect(
        usesFieldCheck || marksPerEntry,
        `${rel} declares a client-supplied identity string but neither applies ` +
          "`assertStableExternalId` / `assertStableIdempotencyKey` to its request schema " +
          "nor marks the declaration `@external-id-checked-per-entry: <path>` naming the " +
          "route that checks it per entry.",
      ).toBe(true);
    },
  );

  it.each(declaringFiles())(
    "%s — every per-entry marker points at a file that really checks per entry",
    (rel) => {
      if (exemptionFor(rel) !== undefined) return;
      const source = read(rel);
      MARKER.lastIndex = 0;
      const targets = [...source.matchAll(new RegExp(MARKER, "g"))].map(
        (m) => m[1],
      );
      for (const target of targets) {
        expect(
          target.startsWith("src/"),
          `${rel}: marker target "${target}" must be a repo-root-relative src/ path`,
        ).toBe(true);
        const checker = body(target.replace(/^src\//, ""));
        expect(
          checker.includes("classifyExternalId"),
          `${rel} points its per-entry marker at ${target}, but that file never calls classifyExternalId.`,
        ).toBe(true);
      }
    },
  );
});

describe("identities derived outside a Zod schema stay inside the floor", () => {
  /**
   * The CSV importer builds an `externalId` from a spreadsheet column, and
   * the MCP write path hashes a host-supplied key into one. Neither goes
   * through a Zod request field, so the declaration rule above is blind to
   * both — which is exactly the gap this rule closes.
   */
  function derivedIdentityFiles(): string[] {
    return sourceFiles()
      .filter((rel) => DERIVED_IDENTITY_TREES.some((t) => rel.startsWith(t)))
      .filter((rel) => IDENTITY_MENTION.test(read(rel)));
  }

  it("finds the derived-identity modules at all (the matcher still matches)", () => {
    const files = derivedIdentityFiles();
    expect(files).toContain("lib/import/csv-measurements.ts");
    expect(files).toContain("lib/mcp/writes.ts");
  });

  it.each(derivedIdentityFiles())(
    "%s applies the floor itself or imports a module that does",
    (rel) => {
      if (appliesFloor(rel)) return;
      const sources = importedLocalModules(rel).filter((target) => {
        try {
          return appliesFloor(`${target}.ts`);
        } catch {
          return false;
        }
      });
      expect(
        sources.length,
        `${rel} handles an external identity but neither applies the stability floor ` +
          "nor imports a module that does. It derives an identity from input no Zod " +
          "request schema sees (a file row, an MCP tool argument), so nothing else " +
          "will catch an unstable value here.",
      ).toBeGreaterThan(0);
    },
  );

  it("the CSV importer refuses an unstable id with its own row reason", () => {
    // The importer has no per-entry Zod field to hang a refine on; its
    // contract is a per-row `reason` code. Pin that the floor is wired to
    // that contract and not merely imported.
    const b = body("lib/import/csv-measurements.ts");
    expect(b).toContain("isStableExternalId");
    expect(b).toContain('skip("unstable_external_id")');
    expect(
      readSource("src/lib/import/csv-measurements.ts", "unstable_external_id"),
    ).toContain('| "unstable_external_id"');
  });

  it("the MCP write path checks the key BEFORE it is hashed into an identity", () => {
    // A SHA-256 of a pointer address is clean hex, so the externalId floor
    // downstream can never see the shape. The check has to run on the input.
    const b = body("lib/mcp/writes.ts");
    const guardAt = b.indexOf("checkMcpIdempotencyKey");
    const hashAt = b.indexOf("mcpExternalId");
    expect(guardAt).toBeGreaterThan(-1);
    expect(hashAt).toBeGreaterThan(-1);
    expect(b).toContain("classifyExternalId");
    // Every entry point returns the refusal before reaching the hash.
    for (const fn of [
      "logMcpMeasurement",
      "logMcpMood",
      "logMcpBloodPressure",
    ]) {
      const start = b.indexOf(`export async function ${fn}`);
      expect(start, `${fn} not found`).toBeGreaterThan(-1);
      const scope = b.slice(start, start + 2000);
      expect(
        scope.indexOf("checkMcpIdempotencyKey"),
        `${fn} does not check the idempotency key before writing`,
      ).toBeGreaterThan(-1);
    }
  });
});

describe("the intake idempotency key is never read across users", () => {
  /**
   * `medication_intake_events.idempotency_key` carried a GLOBAL unique
   * from 0001_init until migration 0273. Client-supplied keys on a global
   * unique meant one user's key blocked another user's write outright,
   * and an unscoped lookup resolved a stranger's row and handed back its
   * id. The column is now unique per user; every read has to key on
   * `(userId, idempotencyKey)` or the leak comes straight back.
   */
  function intakeQueriesFilteringOnTheKey(): Array<{
    file: string;
    line: number;
    scoped: boolean;
  }> {
    const out: Array<{ file: string; line: number; scoped: boolean }> = [];
    for (const rel of sourceFiles()) {
      const source = read(rel);
      if (!source.includes("medicationIntakeEvent.")) continue;
      const call = /medicationIntakeEvent\.(\w+)\(\s*\{/g;
      let m: RegExpExecArray | null;
      while ((m = call.exec(source)) !== null) {
        // Walk to the matching brace so the window is the call, not a
        // fixed slice that could bleed into the next statement.
        let depth = 0;
        let j = source.indexOf("{", m.index);
        for (; j < source.length; j++) {
          if (source[j] === "{") depth++;
          else if (source[j] === "}" && --depth === 0) break;
        }
        const body = source.slice(m.index, j + 1);
        const whereAt = body.indexOf("where");
        if (whereAt === -1) continue;
        const where = body.slice(whereAt, whereAt + 400);
        if (!where.includes("idempotencyKey")) continue;
        out.push({
          file: rel,
          line: source.slice(0, m.index).split("\n").length,
          // Keyed on the row's own primary id is scoped by construction —
          // that is an update-by-id that happens to WRITE the key.
          scoped: where.includes("userId") || /where:\s*\{\s*id:/.test(where),
        });
      }
    }
    return out;
  }

  it("finds the reads at all (the matcher still matches)", () => {
    const found = intakeQueriesFilteringOnTheKey();
    expect(found.length).toBeGreaterThanOrEqual(6);
    expect(found.map((f) => f.file)).toContain(
      "lib/medications/intake-bulk/entry-write.ts",
    );
  });

  it("every query filtering on the key also narrows by userId", () => {
    const unscoped = intakeQueriesFilteringOnTheKey().filter((f) => !f.scoped);
    expect(
      unscoped,
      "a medicationIntakeEvent query filters on idempotencyKey without a userId. " +
        "The key is client-supplied and unique per USER (migration 0273); an " +
        "unscoped read resolves another user's row.",
    ).toEqual([]);
  });

  it("the schema keeps the key unique per user, not globally", () => {
    const schema = readSourceText(
      join(process.cwd(), "prisma", "schema.prisma"),
    );
    expect(schema).toContain("@@unique([userId, idempotencyKey])");
    expect(schema).not.toMatch(
      /idempotencyKey\s+String\?\s+@unique\s+@map\("idempotency_key"\)/,
    );
  });
});

describe("the batch surfaces refuse per entry, never whole-batch", () => {
  // Each of these drains a client sync queue. A schema-level refusal here
  // would stop a whole batch of good rows because of one bad one, which is
  // worse than the duplicate it prevents.
  //
  // A surface whose ingest moved into a service names the service files
  // beside the route: the route parses, the service refuses per entry.
  const BATCH_SURFACES: Record<string, readonly string[]> = {
    "app/api/measurements/batch/route.ts": [
      "lib/measurements/batch-ingest/prepare.ts",
      "lib/measurements/batch-ingest/ingest.ts",
    ],
    "app/api/mood-entries/bulk/route.ts": ["lib/mood/bulk-ingest.ts"],
    "app/api/medications/intake/bulk/route.ts": [
      "lib/medications/intake-bulk/entry.ts",
      "lib/medications/intake-bulk/ingest.ts",
    ],
    "app/api/workouts/batch/route.ts": [
      "lib/workouts/batch-ingest/entries.ts",
      "lib/workouts/batch-ingest/ingest.ts",
    ],
    "app/api/cycle/day-logs/bulk/route.ts": [],
    "app/api/import/route.ts": [
      "lib/import/json/measurements.ts",
      "lib/import/json/mood.ts",
      "lib/import/json/run.ts",
    ],
  };
  const BATCH_ROUTES = Object.keys(BATCH_SURFACES);

  /** The route and the service files that carry its per-entry ingest. */
  const surface = (rel: string): string =>
    [rel, ...BATCH_SURFACES[rel]].map((file) => body(file)).join("\n");

  it.each(BATCH_ROUTES)("%s classifies each entry itself", (rel) => {
    const source = surface(rel);
    expect(source).toContain("classifyExternalId");
    expect(source).toContain("unstableExternalIdMeta");
  });

  it.each(BATCH_ROUTES.filter((r) => r !== "app/api/import/route.ts"))(
    "%s reports the shared per-entry reason code",
    (rel) => {
      // The JSON importer has no per-entry status envelope — it reports a
      // skipped COUNT — so it is the one batch surface without the code.
      expect(surface(rel)).toContain("UNSTABLE_EXTERNAL_ID_REASON");
    },
  );
});
