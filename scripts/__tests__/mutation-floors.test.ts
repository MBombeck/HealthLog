import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkFloors } from "../mutation-floors.mjs";

const ROOT = resolve(__dirname, "../..");

const mutants = (killed: number, survived: number) => [
  ...Array.from({ length: killed }, () => ({ status: "Killed" })),
  ...Array.from({ length: survived }, () => ({ status: "Survived" })),
];

const modules = {
  crypto: { paths: ["src/lib/crypto.ts"], floor: 50 },
  backup: { paths: ["src/lib/export/a-backup-schema.ts"], floor: 50 },
};

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true });
});

describe("checkFloors", () => {
  it("passes when every module is at its floor and every file is claimed", () => {
    const result = checkFloors({
      root: ROOT,
      modules,
      report: {
        files: {
          "src/lib/crypto.ts": { mutants: mutants(5, 5) },
          "src/lib/export/a-backup-schema.ts": { mutants: mutants(3, 1) },
        },
      },
    });
    expect(result.failed).toBe(false);
    expect(result.unassigned).toEqual([]);
  });

  it("fails on a mutated file no module claims, whatever its score", () => {
    const result = checkFloors({
      root: ROOT,
      modules,
      report: {
        files: {
          "src/lib/crypto.ts": { mutants: mutants(5, 5) },
          "src/lib/export/a-backup-schema.ts": { mutants: mutants(3, 1) },
          "src/lib/export/b-backup-schema.ts": { mutants: mutants(10, 0) },
        },
      },
    });
    expect(result.failed).toBe(true);
    expect(result.belowFloor).toBe(false);
    expect(result.unassigned).toEqual(["src/lib/export/b-backup-schema.ts"]);
    expect(result.rows.at(-1)).toContain("b-backup-schema.ts");
  });

  it("fails a module under its floor and one the report never reached", () => {
    const result = checkFloors({
      root: ROOT,
      modules,
      report: { files: { "src/lib/crypto.ts": { mutants: mutants(4, 6) } } },
    });
    expect(result.failed).toBe(true);
    expect(result.belowFloor).toBe(true);
    expect(result.rows[0]).toMatch(/^FAIL crypto .*40\.0 %/);
    expect(result.rows[1]).toMatch(/^FAIL backup .*no mutants/);
  });

  it("counts a mutant no test reaches against its module", () => {
    const result = checkFloors({
      root: ROOT,
      modules: { crypto: modules.crypto },
      report: {
        files: {
          "src/lib/crypto.ts": {
            mutants: [
              ...mutants(1, 0),
              { status: "Timeout" },
              { status: "NoCoverage" },
              { status: "NoCoverage" },
              { status: "CompileError" },
            ],
          },
        },
      },
    });
    expect(result.rows[0]).toMatch(/^ok {3}crypto .*50\.0 %.*2\/4 mutants/);
  });
});

describe("mutation-floors.mjs", () => {
  it("exits non-zero and names an unclaimed file in the real floors", () => {
    const dir = mkdtempSync(join(tmpdir(), "mutation-floors-"));
    temporary.push(dir);
    const report = join(dir, "mutation.json");
    writeFileSync(
      report,
      JSON.stringify({
        files: {
          "src/lib/not-a-module.ts": { mutants: mutants(1, 0) },
        },
      }),
    );
    const run = spawnSync(
      process.execPath,
      [join(ROOT, "scripts/mutation-floors.mjs"), report],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(
      "FAIL src/lib/not-a-module.ts is mutated but belongs to no module",
    );
    expect(run.stderr).toContain("belongs to no module in stryker.floors.json");
  });
});
