/**
 * Structural guard — `coach_usage.total_tokens` and `coach_usage.operator_tokens`
 * move together in EVERY raw statement.
 *
 * v1.38.19 (Wave E) gave the daily ledger a second counter: `operator_tokens`
 * is the share of `total_tokens` an operator-funded provider served, and the
 * operator ceiling is enforced against it. The counters are only meaningful
 * while they stay in step. A statement that writes the total and forgets the
 * operator share under-counts the operator's exposure; a statement that
 * reverses the total and forgets the operator share leaks budget permanently
 * toward the operator cap, because nothing else ever subtracts it; a statement
 * that RETURNS the total alone forces its caller to gate on the wrong number,
 * which is the exact defect the wave exists to fix.
 *
 * Two of the three writers shipped with precisely those bugs, and both were a
 * grep away. This guard is that grep, executable: every INSERT column list,
 * every SET clause and every RETURNING list that names one counter must name
 * the other. It also pins the writer set, so a fourth place that learns to
 * write the ledger has to come past this file first.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";

import { describe, it, expect } from "vitest";

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(SRC_DIR, "..");

/**
 * The production files allowed to hold raw `coach_usage` SQL. The ledger's
 * invariants (two counters in one statement, one row per user and UTC day) are
 * reasoned about here and nowhere else; a new entry means a new place those
 * invariants can be broken, so it is a deliberate edit, not a side effect.
 */
const EXPECTED_SQL_WRITERS = [
  "src/lib/ai/coach/budget.ts",
  "src/lib/jobs/data-arrival.ts",
];

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "generated") continue;
      collectSourceFiles(full, out);
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) {
        continue;
      }
      out.push(full);
    }
  }
  return out;
}

/**
 * Every backtick-delimited SQL template literal in a source file. A prose
 * mention of `coach_usage` in a doc comment sits between backticks too, so a
 * literal only counts once it also reads like a statement.
 */
const SQL_STATEMENT = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|SELECT)\b/i;

function sqlLiterals(source: string): string[] {
  return (source.match(/`[^`]*`/g) ?? []).filter(
    (literal) => literal.includes("coach_usage") && SQL_STATEMENT.test(literal),
  );
}

/**
 * The clauses of one SQL statement that name columns: the INSERT column list,
 * every SET assignment block, and every RETURNING list. Each is checked on its
 * own, because a statement can write both counters and still return only one —
 * which is how the arrival-reaction reservation ended up gating the operator's
 * cap on a mixed total.
 */
function columnClauses(sql: string): { label: string; text: string }[] {
  const clauses: { label: string; text: string }[] = [];
  for (const m of sql.matchAll(/INSERT\s+INTO\s+[\w"]+\s*\(([^)]*)\)/gi)) {
    clauses.push({ label: "INSERT column list", text: m[1] });
  }
  for (const m of sql.matchAll(
    /\bSET\b([\s\S]*?)(?=\bWHERE\b|\bRETURNING\b|$)/gi,
  )) {
    clauses.push({ label: "SET clause", text: m[1] });
  }
  for (const m of sql.matchAll(/\bRETURNING\b([\s\S]*?)(?=;|$)/gi)) {
    clauses.push({ label: "RETURNING list", text: m[1] });
  }
  return clauses;
}

describe("coach_usage — the two counters move together", () => {
  const files = collectSourceFiles(SRC_DIR);

  it("names operator_tokens in every clause that names total_tokens", () => {
    const offences: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      if (!source.includes("coach_usage")) continue;
      for (const literal of sqlLiterals(source)) {
        for (const clause of columnClauses(literal)) {
          if (!clause.text.includes("total_tokens")) continue;
          if (clause.text.includes("operator_tokens")) continue;
          offences.push(
            `${relative(REPO_ROOT, file)} — ${clause.label}: ${clause.text
              .replace(/\s+/g, " ")
              .trim()}`,
          );
        }
      }
    }

    expect(
      offences,
      `Every raw coach_usage clause that touches total_tokens must touch operator_tokens too:\n${offences.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps the raw-SQL writer set to the files that reason about the ledger", () => {
    const writers = files
      .filter((file) => {
        return sqlLiterals(readFileSync(file, "utf8")).length > 0;
      })
      .map((file) => relative(REPO_ROOT, file))
      .sort();

    expect(writers).toEqual([...EXPECTED_SQL_WRITERS].sort());
  });
});
