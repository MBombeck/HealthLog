/**
 * The places a person last opened from the palette, per account and per
 * browser: a convenience for the empty palette, nothing more. Storage can be
 * missing, full or refused (a private window, a blocked site); every access
 * is wrapped, and the palette works the same without it.
 */

const PREFIX = "healthlog-palette-recent:";
export const RECENT_LIMIT = 5;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The ids, newest first, for `account`. */
export function readRecent(account: string | null | undefined): string[] {
  if (!account) return [];
  try {
    const raw = storage()?.getItem(PREFIX + account);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

/** Put `id` first, keeping the list short and without repeats. */
export function pushRecent(
  account: string | null | undefined,
  id: string,
): void {
  if (!account) return;
  try {
    const next = [id, ...readRecent(account).filter((x) => x !== id)].slice(
      0,
      RECENT_LIMIT,
    );
    storage()?.setItem(PREFIX + account, JSON.stringify(next));
  } catch {
    // A refused write only costs the next empty state its history.
  }
}
