/**
 * The directories under `src/lib` that hold a provider's client and sync,
 * derived from the connection keys the product knows (`CONNECTION_KEYS`),
 * so a guard over provider code cannot keep a list of its own that a new
 * integration slips past. Each key is checked to be a directory: a key that
 * names none fails here rather than narrowing a guard in silence.
 */
import { statSync } from "node:fs";
import { join } from "node:path";

import { CONNECTION_KEYS } from "@/lib/integrations/connection-health";

const LIB = join(process.cwd(), "src", "lib");

/** Keys whose code lives under another name. */
const DIR_OF: Partial<Record<string, string>> = {
  // The folder fetch is a second way into the Health Connect importer.
  "health-connect-remote": "import/health-connect",
  // The Android sync's routes and pairing.
  "health-connect-app": "health-connect",
};

export const PROVIDER_DIRS: readonly string[] = CONNECTION_KEYS.map((key) => {
  const dir = DIR_OF[key] ?? key;
  if (!statSync(join(LIB, dir), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`provider-dirs: src/lib/${dir} is not a directory`);
  }
  return dir;
});
