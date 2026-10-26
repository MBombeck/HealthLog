/**
 * Where the request guards live, for the structural tests that read them.
 *
 * `apiHandler` and the guards it fronts (`requireAuth`, the record modes, the
 * cookie-only helpers, the step-up gates) were one file. The guards now live
 * in `src/lib/auth/guards/`, one module per family, and `src/lib/api-handler.ts`
 * keeps the wrapper and re-exports them as the one public entry.
 *
 * A test that pins a guard reads the module that DECLARES it, found by name
 * here, rather than a hard-coded path. Two properties follow: moving a guard
 * between the modules does not need every test edited, and a guard that is
 * renamed or deleted throws here instead of leaving a negative assertion green
 * over a file that no longer holds it.
 */
import { readSource, readSourceFolder, requireFloor } from "./source-files";

/** The guard folder, relative to the repository root. */
export const AUTH_GUARDS_DIR = "src/lib/auth/guards";

/** The route wrapper and public entry, relative to `src/`. */
export const API_HANDLER = "lib/api-handler.ts";

/** How many guard modules there are at least; a smaller folder is a broken read. */
const GUARD_MODULE_FLOOR = 10;

/** Every guard module as `[path relative to src/, text]`, sorted. */
export function authGuardModules(): Array<[string, string]> {
  const modules = readSourceFolder(AUTH_GUARDS_DIR, {
    floor: GUARD_MODULE_FLOOR,
  }).map(([rel, text]): [string, string] => [`lib/auth/guards/${rel}`, text]);
  return requireFloor(
    "auth guard modules",
    modules,
    GUARD_MODULE_FLOOR,
  ) as Array<[string, string]>;
}

function declares(text: string, name: string): boolean {
  return new RegExp(`(^|\\n)(export )?(async )?function ${name}\\s*[(<]`).test(
    text,
  );
}

/**
 * The guard module (relative to `src/`) that declares `function name(`.
 * Throws unless exactly one does.
 */
export function guardModuleOf(name: string): string {
  const found = authGuardModules()
    .filter(([, text]) => declares(text, name))
    .map(([rel]) => rel);
  if (found.length !== 1) {
    throw new Error(
      `guardModuleOf(${name}): expected exactly one module under ` +
        `${AUTH_GUARDS_DIR} to declare it, found ${found.length} ` +
        `(${found.join(", ") || "none"}).`,
    );
  }
  return found[0];
}

/**
 * The text of the module that declares `name`, read with `readSource` so the
 * name and every extra anchor must be present in it.
 */
export function guardSourceOf(
  name: string,
  extraAnchors: readonly (string | RegExp)[] = [],
): string {
  return readSource(`src/${guardModuleOf(name)}`, [name, ...extraAnchors]);
}

/** All guard modules joined, for counts that span the folder. */
export function authGuardsText(): string {
  return authGuardModules()
    .map(([, text]) => text)
    .join("\n");
}
