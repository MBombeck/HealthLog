import type { ReactNode } from "react";

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";

import { handleFilePickerChange, OcrReviewDialog } from "../ocr-review-dialog";

const hookState = vi.hoisted(() => ({ extractPending: false }));

vi.mock("@/components/ui/responsive-sheet", () => ({
  ResponsiveSheet: ({
    children,
    title,
    description,
  }: {
    children: ReactNode;
    title: string;
    description: string;
  }) => (
    <section aria-label={title}>
      <p>{description}</p>
      {children}
    </section>
  ),
}));

vi.mock("../use-ocr-extract", () => ({
  useOcrExtract: () => ({
    isPending: hookState.extractPending,
    mutate: vi.fn(),
    reset: vi.fn(),
  }),
  useOcrTextExtract: () => ({
    isPending: hookState.extractPending,
    mutate: vi.fn(),
    reset: vi.fn(),
  }),
  useOcrCommit: () => ({
    isPending: false,
    mutate: vi.fn(),
    reset: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function render(
  locale: "en" | "de" = "en",
  options: { mode?: "vision" | "text"; pdfSupported?: boolean } = {},
): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <OcrReviewDialog
        open
        onOpenChange={() => {}}
        mode={options.mode ?? "vision"}
        pdfSupported={options.pdfSupported ?? true}
        onCommitted={() => {}}
      />
    </I18nProvider>,
  );
}

function pickerMarkup(html: string): { input: string; label: string } {
  const input = html.match(/<input[^>]*type="file"[^>]*>/)?.[0];
  const label = html.match(/<label[^>]*>[\s\S]*?<\/label>/)?.[0];
  expect(input).toBeDefined();
  expect(label).toBeDefined();
  return { input: input!, label: label! };
}

afterEach(() => {
  hookState.extractPending = false;
});

describe("<OcrReviewDialog> file picker", () => {
  it.each([
    ["en", "Scan a report"],
    ["de", "Befund scannen"],
  ] as const)(
    "renders one natively labelled, localized picker in %s",
    (locale, localizedName) => {
      const html = render(locale);
      const { input, label } = pickerMarkup(html);
      const inputId = input.match(/id="([^"]+)"/)?.[1];

      expect(html.match(/<input[^>]*type="file"/g)).toHaveLength(1);
      expect(html).not.toContain("<button");
      expect(inputId).toBeTruthy();
      expect(label).toContain(`for="${inputId}"`);
      expect(label).toContain(localizedName);
    },
  );

  it("uses the native file input as the sole keyboard focus target and paints its focus on the visible label", () => {
    const html = render();
    const { input, label } = pickerMarkup(html);

    expect(input).not.toMatch(/\sdisabled(?:[=\s/>])/);
    expect(input).not.toContain('tabindex="-1"');
    expect(input).not.toContain("aria-hidden");
    expect(input).toContain("peer");
    expect(label).not.toContain("tabindex=");
    expect(label).toContain("peer-focus-visible:ring-2");
    expect(label).toContain("peer-focus-visible:ring-ring");
  });

  it("keeps the mode-specific MIME restrictions and disables the native picker while extracting", () => {
    const visionInput = pickerMarkup(render()).input;
    const textInput = pickerMarkup(
      render("en", { mode: "text", pdfSupported: true }),
    ).input;

    expect(visionInput).toContain(
      'accept="image/jpeg,image/png,image/webp,application/pdf"',
    );
    expect(textInput).toContain('accept="image/jpeg,image/png,image/webp"');

    hookState.extractPending = true;
    const pending = pickerMarkup(render());
    expect(pending.input).toMatch(/\sdisabled(?:[=\s/>])/);
    expect(pending.label).toContain("peer-disabled:cursor-not-allowed");
    expect(pending.label).toContain("Reading your report");
  });

  it("passes the first selected file to the callback and clears the native value", () => {
    const selected = { name: "report.pdf" } as File;
    const input = { files: [selected], value: "C:\\fakepath\\report.pdf" };
    const onFilePicked = vi.fn();
    handleFilePickerChange(input, onFilePicked);

    expect(onFilePicked).toHaveBeenCalledOnce();
    expect(onFilePicked).toHaveBeenCalledWith(selected);
    expect(input.value).toBe("");
  });
});
