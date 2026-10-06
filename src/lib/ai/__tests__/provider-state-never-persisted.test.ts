import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * v1.41 — `providerState` (encrypted reasoning items, signed thinking blocks,
 * gateway reasoning details) lives in memory for one turn. It is opaque
 * provider output tied to the request that produced it: never persisted,
 * never logged, never passed to `annotate()`.
 *
 * The guard freezes where the name may appear at all — the clients that make
 * and consume it, the contract, and the Coach tool loop that threads it from
 * one round to the next — and, inside those files, forbids any line that
 * names it alongside a logging or persistence call. A new reader elsewhere
 * (a persistence helper, a route, a job, a log line) fails here and has to
 * argue its case in this list.
 */
const ROOT = join(__dirname, "../../../..");
const SRC = join(ROOT, "src");

const ALLOWED_FILES = new Set([
  "src/lib/ai/types.ts",
  "src/lib/ai/codex-client.ts",
  "src/lib/ai/openai-client.ts",
  "src/lib/ai/anthropic-client.ts",
  "src/lib/ai/local-client.ts",
  "src/lib/ai/mock-client.ts",
]);
/** The Coach tool loop carries it between rounds of one turn. */
const ALLOWED_PREFIXES = ["src/lib/ai/coach/tools/"];

/**
 * A read (`x.providerState`) or a key / field declaration
 * (`providerState: …`, `providerState?: …`). Comment lines are skipped. A
 * local variable that merely shares the name (the onboarding screen's
 * `const providerState = useAiProviderState()`) is a different thing and
 * does not match.
 */
const STATE_REFERENCE = /\.providerState\b|\bproviderState\??\s*:/;

const FORBIDDEN_ON_SAME_LINE =
  /annotate\(|prisma\.|auditLog|console\.|logger\.|reportToGlitchtip|captureException|persist|JSON\.stringify|encrypt\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (
      name === "generated" ||
      name === "node_modules" ||
      name === "__tests__"
    ) {
      continue;
    }
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function mentions(): Array<{ file: string; lines: string[] }> {
  return walk(SRC)
    .map((full) => {
      const lines = readFileSync(full, "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .filter((l) => STATE_REFERENCE.test(l));
      return { file: relative(ROOT, full).split("\\").join("/"), lines };
    })
    .filter((m) => m.lines.length > 0);
}

describe("providerState never leaves the turn", () => {
  const found = mentions();

  it("finds the clients that make it (a guard that matches nothing proves nothing)", () => {
    const files = found.map((m) => m.file);
    // The contract, the three clients that run tool rounds (Codex, OpenAI,
    // Anthropic) and the mock, today. Local never runs tools.
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const client of [
      "src/lib/ai/codex-client.ts",
      "src/lib/ai/anthropic-client.ts",
      "src/lib/ai/openai-client.ts",
      "src/lib/ai/types.ts",
    ]) {
      expect(files).toContain(client);
    }
  });

  it("appears only in the clients, the contract and the tool loop", () => {
    const outside = found
      .map((m) => m.file)
      .filter(
        (f) =>
          !ALLOWED_FILES.has(f) &&
          !ALLOWED_PREFIXES.some((p) => f.startsWith(p)),
      );
    expect(outside).toEqual([]);
  });

  it("is never named on a line that logs, annotates or persists", () => {
    const offending = found.flatMap((m) =>
      m.lines
        .filter((l) => FORBIDDEN_ON_SAME_LINE.test(l))
        .map((l) => `${m.file}: ${l.trim()}`),
    );
    expect(offending).toEqual([]);
  });

  it("has no column in the schema", () => {
    const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
    expect(schema).not.toMatch(/providerState|provider_state/);
  });
});
