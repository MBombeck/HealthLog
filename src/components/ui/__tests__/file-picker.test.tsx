import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { FileInput, FilePicker } from "../file-picker";

/**
 * #1215 — the file picker reads as a button: a secondary (`outline`) Button
 * that opens the hidden native input, with the chosen file's name beside it
 * as the button's description.
 */
function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

/** The opening tag of the element carrying `data-slot="<slot>"`. */
function tag(html: string, slot: string): string {
  const match = html.match(new RegExp(`<[a-z]+[^>]*data-slot="${slot}"[^>]*>`));
  if (!match) throw new Error(`no ${slot}`);
  return match[0];
}

function attr(openingTag: string, name: string): string | null {
  return openingTag.match(new RegExp(` ${name}="([^"]*)"`))?.[1] ?? null;
}

describe("FilePicker", () => {
  it("is an outline button with the native input out of reach", () => {
    const html = render(
      <FilePicker id="f" accept=".csv" onChange={() => {}} fileName={null} />,
    );
    const button = tag(html, "file-picker-button");
    expect(button.startsWith("<button")).toBe(true);
    expect(attr(button, "type")).toBe("button");
    expect(attr(button, "id")).toBe("f");
    expect(attr(button, "data-variant") ?? attr(button, "class")).toMatch(
      /outline|border/,
    );
    expect(html).toContain("Choose file</button>");

    const input = tag(html, "file-picker-input");
    expect(attr(input, "type")).toBe("file");
    expect(attr(input, "accept")).toBe(".csv");
    expect(attr(input, "tabindex")).toBe("-1");
    expect(attr(input, "aria-hidden")).toBe("true");
    expect(attr(input, "class")).toBe("sr-only");

    const name = tag(html, "file-picker-name");
    expect(attr(button, "aria-describedby")).toBe(attr(name, "id"));
    expect(attr(name, "aria-live")).toBe("polite");
    expect(html).toContain(">No file chosen</span>");
  });

  it("shows the chosen file's name", () => {
    const html = render(<FilePicker onChange={() => {}} fileName="meds.csv" />);
    expect(html).toContain(">meds.csv</span>");
    expect(html).not.toContain("No file chosen");
  });

  it("disables the button with the input", () => {
    const html = render(
      <FilePicker onChange={() => {}} fileName={null} disabled />,
    );
    expect(tag(html, "file-picker-button")).toContain(' disabled=""');
    expect(tag(html, "file-picker-input")).toContain(' disabled=""');
  });
});

describe("FileInput", () => {
  it("is sr-only unless the caller lays it out", () => {
    expect(render(<FileInput />)).toContain('class="sr-only"');
    expect(render(<FileInput className="hidden" />)).toContain(
      'class="hidden"',
    );
  });
});
