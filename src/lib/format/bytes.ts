import type { useFormatters } from "@/lib/i18n/context";

/**
 * One spelling of "1.25 MB" for every surface that shows a byte count from
 * the admin backups response.
 *
 * It lives here rather than beside the card that happened to need it first:
 * the second reader was importing a formatter out of a thousand-line client
 * component, which is a dependency on a page's worth of code for four lines of
 * arithmetic. Both cards render on the same route today, so it costs nothing
 * today — and it becomes a cost the moment either one moves.
 */
export function formatBytes(
  bytes: number,
  fmt: ReturnType<typeof useFormatters>,
): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    return `${fmt.integer(Math.round(bytes / 1024))} KB`;
  }
  return `${fmt.number(bytes / 1024 / 1024, 2)} MB`;
}
