/**
 * One row of tiles, decided by CSS alone.
 *
 * The strip's track is `repeat(auto-fit, minmax(min(100%, 11rem), 1fr))`
 * with a 0.75 rem gap, so n columns fit once the strip is
 * (11.75 n - 0.75) rem wide; below two of those it is two compact columns,
 * never one. Columns = max(2, floor((width + 0.75 rem) / 11.75 rem)): two on
 * a phone, three from about 600 px, six at 1440. The tile at index i hides
 * while fewer than i + 1 columns fit, so the front of the list fills exactly
 * one row at every width, without measuring in script and without a partial
 * second row. The shell caps the content column at `max-w-screen-xl`, under
 * the 81.5 rem a seventh column needs; anything past the sixth tile waits
 * for "All values". The grid sits inside a size container (`@container`);
 * the class strings are literal so Tailwind sees them.
 */
export const ONE_ROW_GRID =
  "grid auto-rows-fr gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,11rem),1fr))] @max-[22.75rem]:grid-cols-2";

const ITEM_CLASSES = [
  "",
  "",
  "@max-[34.5rem]:hidden",
  "@max-[46.25rem]:hidden",
  "@max-[58rem]:hidden",
  "@max-[69.75rem]:hidden",
] as const;

/** Hides the "All values" switch once all n tiles fit, n = index + 3. */
const TOGGLE_CLASSES = [
  "@min-[34.5rem]:hidden",
  "@min-[46.25rem]:hidden",
  "@min-[58rem]:hidden",
  "@min-[69.75rem]:hidden",
] as const;

/** The class that keeps the tile at `index` out of the one row. */
export function oneRowItemClass(index: number): string {
  return ITEM_CLASSES[index] ?? "hidden";
}

/**
 * The class for the "All values" switch over `count` tiles: hidden once they
 * all fit one row. Null when there is nothing to open at any width.
 */
export function oneRowToggleClass(count: number): string | null {
  if (count < 3) return null;
  return TOGGLE_CLASSES[count - 3] ?? "";
}
