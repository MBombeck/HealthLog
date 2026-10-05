/**
 * `backupPayloadSchema` is built when `src/lib/validations/backup.ts` is
 * evaluated and holds about 12 MB of heap. The restore job, the stored-backup
 * readers and the export writer sit on the boot path, so a static value import
 * of that module from any of them puts the schema in every server process,
 * whether or not it ever touches a backup. Runtime code reaches it with a
 * dynamic `import()` at the moment a file is validated, takes only types
 * statically, and takes the version and the summary from `backup-summary.ts`.
 *
 * The one static importer allowed is the OpenAPI registry, which only the
 * spec generator loads.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const ALLOWED_STATIC = new Set(["lib/openapi/routes/export.ts"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === "__tests__" || name === "generated") continue;
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

// `import … from "@/lib/validations/backup"`, across lines, capturing what
// precedes the specifier. Every importer uses the alias (a relative
// `./backup` also names `src/lib/cycle/backup.ts`, so it is not matched).
const STATIC_IMPORT =
  /^import\s+(type\s+)?([^;]*?)\s+from\s+["']@\/lib\/validations\/backup["']/gm;
const DYNAMIC_IMPORT = /import\(\s*["']@\/lib\/validations\/backup["']\s*\)/g;

describe("the backup payload schema loads on first use", () => {
  const files = sourceFiles(ROOT);
  const staticValueImporters: string[] = [];
  let dynamicImports = 0;
  let typeImports = 0;

  for (const file of files) {
    const rel = relative(ROOT, file);
    if (rel === "lib/validations/backup.ts") continue;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(STATIC_IMPORT)) {
      const typeOnly =
        match[1] !== undefined ||
        (/^\{[^}]*\}$/.test(match[2]) &&
          match[2]
            .slice(1, -1)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .every((s) => s.startsWith("type ")));
      if (typeOnly) typeImports++;
      else if (!ALLOWED_STATIC.has(rel)) staticValueImporters.push(rel);
    }
    dynamicImports += [...text.matchAll(DYNAMIC_IMPORT)].length;
  }

  it("has no static value import outside the OpenAPI registry", () => {
    expect(staticValueImporters).toEqual([]);
  });

  it("finds the loaders it guards (an empty match set would pass vacuously)", () => {
    // upload, restore, preview (store + summary route), download, streamed reader
    expect(dynamicImports).toBeGreaterThanOrEqual(5);
    expect(typeImports).toBeGreaterThan(0);
  });
});
