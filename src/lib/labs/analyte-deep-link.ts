/**
 * Where `/labs?analyte=<name>` goes (MCP deep links).
 *
 * MCP `search` and `fetch` link a lab value as `/labs?analyte=<name>`, the
 * analyte name exactly as stored on the reading. The labs page read nothing
 * from the query, so every such link showed the whole list. The page now asks
 * for the newest reading under that name and opens its marker's page; a name
 * with no reading, or one whose reading carries no marker, keeps the list.
 */

/** The analyte named in the query, or null when there is none to follow. */
export function analyteFromQuery(
  raw: string | null | undefined,
): string | null {
  const analyte = raw?.trim() ?? "";
  return analyte.length > 0 && analyte.length <= 120 ? analyte : null;
}

/** The marker page for the newest reading under that name, or null. */
export function labHrefForAnalyteReading(
  reading: { biomarkerId: string | null } | undefined,
): string | null {
  return reading?.biomarkerId
    ? `/labs/${encodeURIComponent(reading.biomarkerId)}`
    : null;
}
