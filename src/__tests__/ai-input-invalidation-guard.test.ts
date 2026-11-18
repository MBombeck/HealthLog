/**
 * Structural guard: every client write that changes an input of the `ai`
 * block on `GET /api/auth/me` evicts it through `aiInputDependentKeys`.
 *
 * Every AI surface on the web reads its capability from that block. Before
 * v1.39 shipped, the provider forms, the Codex sign-in, the fallback chain and
 * the central-Codex switch evicted only the provider and insights reads, so a
 * freshly configured provider left every AI surface on "not set up" until a
 * reload. The fix routes all of them through one bundle; this guard keeps a
 * new write site from re-deciding the keys by hand.
 *
 * The matcher finds write calls (`apiPost/apiPut/apiPatch/apiDelete`, and
 * `apiFetch`/`apiFetchRaw` with a write method) whose literal path names one
 * of the endpoints below, and asserts the file calls
 * `invalidateKeys(<client>, aiInputDependentKeys)`. A tripwire, not a proof:
 * it holds the file, not each mutation in it (one mutation can branch over
 * two endpoints and evict once), and a path built at runtime would slip the
 * matcher, which is why the matched total carries a floor and an empty sweep
 * fails.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { aiInputDependentKeys, queryKeys } from "@/lib/query-keys";

import { walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/**
 * The endpoints whose writes change an input of the capability answer.
 * Starting a device sign-in changes nothing until the poll reports success,
 * so the `device-start` legs are not listed.
 */
const AI_INPUT_ENDPOINTS = [
  "/api/user/ai-provider",
  "/api/insights/provider-chain",
  "/api/insights/provider-chains",
  "/api/auth/codex/device-poll",
  "/api/auth/codex/disconnect",
  "/api/auth/me/use-central-codex",
  "/api/auth/me/labs-local-ocr",
  "/api/consent/ai",
  "/api/auth/me/modules",
  "/api/auth/me/disable-coach",
  "/api/admin/ai-settings",
  "/api/admin/settings/assistant-flags",
  "/api/admin/settings/module-availability",
  "/api/admin/central-codex/device-poll",
  "/api/admin/central-codex",
  // A managed record's modules / coach / profile families, written by the
  // guardian from inside that record.
  "/api/record-settings",
] as const;

const HELPER_WRITE =
  /\bapi(?:Post|Put|Patch|Delete)\s*(?:<[^()]*?>)?\s*\(\s*["'`](\/api\/[^"'`?]+)/g;
const RAW_WRITE =
  /\bapiFetch(?:Raw)?\s*(?:<[^()]*?>)?\s*\(\s*["'`](\/api\/[^"'`?]+)[^"'`]*["'`]\s*,\s*\{[^}]*?\bmethod:\s*["'](?:POST|PUT|PATCH|DELETE)["']/g;
const BUNDLE_CALL =
  /\binvalidateKeys\(\s*[A-Za-z_]\w*\s*,\s*aiInputDependentKeys\b/g;

function isAiInputEndpoint(path: string): boolean {
  if (path.endsWith("/device-start")) return false;
  return AI_INPUT_ENDPOINTS.some((e) => path === e || path.startsWith(`${e}/`));
}

function inScope(rel: string): boolean {
  if (rel.includes("__tests__") || /\.test\.tsx?$/.test(rel)) return false;
  if (rel.startsWith("app/api/") || rel.startsWith("generated/")) return false;
  return (
    rel.startsWith("components/") ||
    rel.startsWith("hooks/") ||
    rel.startsWith("app/")
  );
}

function writeSites(source: string): string[] {
  const out: string[] = [];
  for (const re of [HELPER_WRITE, RAW_WRITE]) {
    for (const m of source.matchAll(re)) {
      if (isAiInputEndpoint(m[1]!)) out.push(m[1]!);
    }
  }
  return out;
}

const files = walkSourceFiles(SRC, { floor: 3000 }).filter(inScope);
const sites = files
  .map((rel) => {
    const source = readFileSync(join(SRC, rel), "utf8");
    return {
      rel,
      writes: writeSites(source),
      bundleCalls: [...source.matchAll(BUNDLE_CALL)].length,
    };
  })
  .filter((s) => s.writes.length > 0);

describe("AI-input writes evict the capability answer", () => {
  it("the bundle carries the account payload every AI surface reads", () => {
    expect(aiInputDependentKeys).toContainEqual(queryKeys.authMe());
  });

  it("finds the write sites it is meant to hold (an empty sweep is a broken matcher)", () => {
    const total = sites.reduce((n, s) => n + s.writes.length, 0);
    // v1.44 — three write sites left on purpose: the Coach's second switch
    // and the MCP page's second switch (the one switch is in Modules), and
    // the Coach overlay's copy of the provider and model selects (chosen in
    // Settings > AI only).
    expect(sites.length).toBeGreaterThanOrEqual(19);
    expect(total).toBeGreaterThanOrEqual(19);
  });

  it.each(sites.map((s) => [s.rel, s] as const))(
    "%s invalidates aiInputDependentKeys",
    (_rel, site) => {
      expect(
        site.bundleCalls,
        `writes to ${site.writes.join(", ")}`,
      ).toBeGreaterThanOrEqual(1);
    },
  );
});
