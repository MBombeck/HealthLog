/**
 * The dashboard's source, for the guards that pin how it is wired.
 *
 * The dashboard is a composer (`src/app/page-client.tsx`) over a tile
 * registry (`src/components/dashboard/tiles/`): the reads, the tile context,
 * the strip and chart definitions and the rendering of both rows each live in
 * their own module there. A guard that used to read the one page file reads
 * all of them through here, so a rule about the dashboard holds wherever in
 * the registry the code it watches sits, and moving code between the files
 * cannot turn a negative assertion green. The folder read carries a floor,
 * and the page read an anchor, so a rename fails loudly instead of returning
 * less text.
 */
import { readSource, readSourceFolder } from "./source-files";

export const DASHBOARD_PAGE = "src/app/page-client.tsx";
export const DASHBOARD_TILES_DIR = "src/components/dashboard/tiles";

/** Each dashboard module as `[repo-relative path, text]`. */
export function dashboardSourceFiles(): Array<[string, string]> {
  const page = readSource(DASHBOARD_PAGE, "DashboardPageClient");
  const tiles = readSourceFolder(DASHBOARD_TILES_DIR, {
    floor: 5,
    include: (rel) => !rel.includes("__tests__"),
  }).map(([rel, text]): [string, string] => [
    `${DASHBOARD_TILES_DIR}/${rel}`,
    text,
  ]);
  return [[DASHBOARD_PAGE, page], ...tiles];
}

/** The dashboard modules' text, concatenated in a stable order. */
export function dashboardSource(): string {
  return dashboardSourceFiles()
    .map(([, text]) => text)
    .join("\n");
}
