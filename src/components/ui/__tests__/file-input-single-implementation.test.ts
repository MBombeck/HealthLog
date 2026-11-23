/**
 * `FileInput` (`ui/file-picker.tsx`) is the one file input in the tree
 * (#1215). A raw `<input type="file">` renders as the browser's own
 * "Choose File" text, which does not read as a button; a surface that takes a
 * file opens the hidden `FileInput` from a control of its own or uses
 * `FilePicker`. This sweep refuses a second raw file input anywhere under
 * `src/`.
 */
import { describe, expect, it } from "vitest";

const RAW_FILE_INPUT =
  /\btype\s*=\s*(?:"file"|'file'|\{\s*["'`]file["'`]\s*\})/g;

function rawFileInputs(source: string): number {
  return (source.match(RAW_FILE_INPUT) ?? []).length;
}

describe("one file input", () => {
  it("finds a raw file input only inside the shared component", async () => {
    const { join } = await import("node:path");
    const { readSourceText, stripComments, walkSourceFiles } =
      await import("@/__tests__/helpers/source-files");
    const src = join(__dirname, "../../..");
    const found = walkSourceFiles(src, { floor: 2000 })
      .filter((p) => p.endsWith(".tsx") || p.endsWith(".ts"))
      .filter((p) => !p.includes("__tests__/"))
      .filter(
        (p) => rawFileInputs(stripComments(readSourceText(join(src, p)))) > 0,
      )
      .sort();
    // The shared component itself must match, or the matcher is blind.
    expect(found).toEqual(["components/ui/file-picker.tsx"]);
  });

  it("counter-check: catches every spelling of a raw file input", () => {
    expect(rawFileInputs(`<input type="file" />`)).toBe(1);
    expect(rawFileInputs(`<input type='file' />`)).toBe(1);
    expect(rawFileInputs(`<input type={"file"} />`)).toBe(1);
    expect(rawFileInputs(`<input\n  type = "file"\n/>`)).toBe(1);
    expect(rawFileInputs(`<input type="text" />`)).toBe(0);
  });
});
