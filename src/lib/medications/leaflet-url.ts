/**
 * The saved leaflet link on a medication (#1430): the official leaflet the
 * person found, pasted back so it is one tap away.
 *
 * Any host, because the person chooses it, but only `https:`: no `http:`, no
 * `javascript:`, no `data:`. The server never fetches it and no page embeds
 * it; it renders only as an external link (`rel="noopener noreferrer"`).
 * Shared by the request schema and the edit form, so both refuse the same
 * text.
 */

/** Longest link stored; registry document links are far shorter. */
export const LEAFLET_URL_MAX_CHARS = 2048;

/** True when `value` (already trimmed) may be stored as a leaflet link. */
export function isAcceptableLeafletUrl(value: string): boolean {
  if (!value || value.length > LEAFLET_URL_MAX_CHARS) return false;
  // No whitespace or control characters anywhere: the URL parser would
  // quietly strip or encode them, and the stored text must be the link.
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.hostname.length > 0 &&
    parsed.username === "" &&
    parsed.password === ""
  );
}

/**
 * The link a backup carries, as the restore stores it (#1430): kept when the
 * write routes would accept it, otherwise dropped, so a hand-edited file
 * cannot plant a `javascript:` link the edit form refuses.
 */
export function restoredLeafletUrl(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return isAcceptableLeafletUrl(trimmed) ? trimmed : null;
}
