/**
 * One row of tiles, decided by CSS alone.
 *
 * The strip's track is `repeat(auto-fit, minmax(min(100%, 10.5rem), 1fr))`
 * with a 0.75 rem gap, so n columns fit once the strip is
 * (11.25 n - 0.75) rem wide; below two of those it is two compact columns,
 * never one. Columns = max(2, floor((width + 0.75 rem) / 11.25 rem)): two on
 * a phone, three from about 530 px, six at 1440 (also beside the docked
 * day, whose strip leaves the content column about 1080 px wide there; the
 * score row above spans two of those six columns per score, so the floor
 * is 10.5 rem and not the 11 it was). The tile at index i hides
 * while fewer than i + 1 columns fit, so the front of the list fills exactly
 * one row at every width, without measuring in script and without a partial
 * second row. The shell caps the content column at `max-w-screen-xl`, under
 * the 78 rem a seventh column needs; anything past the sixth tile waits
 * for "All values". The grid sits inside a size container (`@container`);
 * the class strings are literal so Tailwind sees them.
 */
export const ONE_ROW_GRID =
  "grid auto-rows-fr gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,10.5rem),1fr))] @max-[21.75rem]:grid-cols-2";

const ITEM_CLASSES = [
  "",
  "",
  "@max-[33rem]:hidden",
  "@max-[44.25rem]:hidden",
  "@max-[55.5rem]:hidden",
  "@max-[66.75rem]:hidden",
] as const;

/** Hides the "All values" switch once all n tiles fit, n = index + 3. */
const TOGGLE_CLASSES = [
  "@min-[33rem]:hidden",
  "@min-[44.25rem]:hidden",
  "@min-[55.5rem]:hidden",
  "@min-[66.75rem]:hidden",
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
