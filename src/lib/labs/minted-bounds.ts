/**
 * The range a new marker is minted with: the printed window, unless it cannot
 * be true (low above high), when nothing says which of the two is wrong and
 * neither is kept. Every place that mints a marker, or pretends to for an
 * import preview, takes its bounds from here.
 *
 * Pure and dependency-free.
 */
export function mintedBounds(
  low: number | null,
  high: number | null,
): { lowerBound: number | null; upperBound: number | null } {
  if (low !== null && high !== null && low > high) {
    return { lowerBound: null, upperBound: null };
  }
  return { lowerBound: low, upperBound: high };
}
