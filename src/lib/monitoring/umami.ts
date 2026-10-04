import { safeFetch } from "@/lib/safe-fetch";
import { isPublicUrl } from "@/lib/validations/notifications";

import { UMAMI_DEFAULT_COLLECT_PATH } from "./umami-paths";

/**
 * The endpoint template in a built tracker:
 * `` `${(hostUrl || …).replace(/\/$/,"")}/api/send` ``. The capture is the
 * path the build appends to the host.
 */
const COLLECT_PATH_PATTERN =
  /\.replace\(\/\\\/\$\/,\s*(?:""|'')\)\}(\/[\w\-./~]{1,128})`/;

/** A collect path is a plain absolute path: no traversal, no query. */
function isPlainPath(path: string): boolean {
  return /^\/[\w\-./~]{1,128}$/.test(path) && !path.split("/").includes("..");
}

/**
 * The collect path compiled into a tracker build, or Umami's default when
 * the build does not carry a recognisable endpoint template.
 */
export function extractUmamiCollectPath(script: string): string {
  const match = COLLECT_PATH_PATTERN.exec(script)?.[1];
  return match && isPlainPath(match) ? match : UMAMI_DEFAULT_COLLECT_PATH;
}

/**
 * Upstream URLs to try for an event, in order: the collect path under the
 * script's own directory (Umami served below a path prefix), at the host
 * root, and under the conventional `/umami` mount. Only public URLs survive.
 */
export function resolveUmamiSendUrls(
  scriptUrl: string | null,
  collectPath: string = UMAMI_DEFAULT_COLLECT_PATH,
): string[] {
  if (!scriptUrl || !isPlainPath(collectPath)) return [];
  try {
    const parsed = new URL(scriptUrl);
    const origin = parsed.origin;
    const segments = parsed.pathname.split("/").filter(Boolean);
    // Drop the script file itself (script.js, umami.js, …).
    if (segments.length > 0 && segments[segments.length - 1]?.includes(".")) {
      segments.pop();
    }
    const prefix = segments.length > 0 ? `/${segments.join("/")}` : "";
    const candidates = [
      `${origin}${prefix}${collectPath}`,
      `${origin}${collectPath}`,
      `${origin}/umami${collectPath}`,
    ];
    return Array.from(new Set(candidates.filter((url) => isPublicUrl(url))));
  } catch {
    return [];
  }
}

const COLLECT_PATH_TTL_MS = 60 * 60 * 1000;
const collectPathCache = new Map<string, { path: string; expiresAt: number }>();

export type UmamiScriptFetch =
  { ok: true; script: string } | { ok: false; reason: string };

/**
 * Fetch the operator's tracker. Fail-soft: an unreachable, slow, refused or
 * non-2xx upstream comes back as `{ ok: false, reason }`, never a throw. A
 * successful fetch also records the build's collect path, so the event proxy
 * learns it without a fetch of its own.
 */
export async function fetchUmamiScript(
  scriptUrl: string,
): Promise<UmamiScriptFetch> {
  try {
    const response = await safeFetch(
      scriptUrl,
      { next: { revalidate: 3600 } },
      // Operator-configured host: pin the connect-time IP so a low-TTL DNS
      // record cannot rebind the fetch at an internal range.
      { requirePublicHost: true },
    );
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    const script = await response.text();
    collectPathCache.set(scriptUrl, {
      path: extractUmamiCollectPath(script),
      expiresAt: Date.now() + COLLECT_PATH_TTL_MS,
    });
    return { ok: true, script };
  } catch (err) {
    return {
      ok: false,
      reason: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    };
  }
}

/**
 * The collect path of the configured tracker, from the cache when fresh,
 * otherwise by fetching the script. `null` when the script cannot be read,
 * so the caller can refuse rather than guess.
 */
export async function resolveUmamiCollectPath(
  scriptUrl: string,
): Promise<string | null> {
  const cached = collectPathCache.get(scriptUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.path;
  const fetched = await fetchUmamiScript(scriptUrl);
  return fetched.ok ? extractUmamiCollectPath(fetched.script) : null;
}

/** Test seam: forget every learnt collect path. */
export function resetUmamiCollectPathCache(): void {
  collectPathCache.clear();
}
