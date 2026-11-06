/**
 * Which calendar app last fetched a feed, from its User-Agent (#1350).
 *
 * Only a family is ever published: the settings card says "by Google
 * Calendar", and the wide event counts conditional fetches per family. The
 * stored User-Agent itself stays on the row, truncated, and never leaves the
 * server.
 */
export type FetcherFamily = "GOOGLE" | "APPLE" | "MICROSOFT" | "OTHER";

const FAMILIES: ReadonlyArray<[FetcherFamily, RegExp]> = [
  ["GOOGLE", /google/i],
  // iOS and macOS fetch through `dataaccessd` / `CalendarAgent`; older macOS
  // still says `iCal`.
  ["APPLE", /dataaccessd|calendaragent|ical\/|\bios\/|macos\/|mac os x/i],
  ["MICROSOFT", /microsoft|outlook|exchange/i],
];

export function fetcherFamily(ua: string | null): FetcherFamily | null {
  if (!ua) return null;
  for (const [family, re] of FAMILIES) if (re.test(ua)) return family;
  return "OTHER";
}
