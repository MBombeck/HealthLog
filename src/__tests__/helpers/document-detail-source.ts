/**
 * The document detail sheet's source, for the checks that pin how it is
 * wired: the sheet (`document-detail-sheet.tsx`) and the hooks and sections
 * it is built from (`documents/detail/`). Read together, so a rule about the
 * sheet holds wherever in those modules the code sits. The folder read has a
 * floor and the sheet an anchor, so a rename fails instead of reading less.
 */
import { readSource, readSourceFolder } from "./source-files";

export function documentDetailSource(): string {
  return [
    readSource(
      "src/components/documents/document-detail-sheet.tsx",
      "DocumentDetailSheet",
    ),
    ...readSourceFolder("src/components/documents/detail", { floor: 4 }).map(
      ([, text]) => text,
    ),
  ].join("\n");
}
