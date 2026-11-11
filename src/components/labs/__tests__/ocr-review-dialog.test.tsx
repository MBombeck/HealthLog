import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";

import { ApiError } from "@/lib/api/api-fetch";

import {
  extractErrorMessage,
  handleFilePickerChange,
  OcrPageCoverageNote,
  OcrReadNotes,
  OcrReviewDialog,
  unitSkippedAnalytes,
} from "../ocr-review-dialog";
import { primeLocales } from "@/__tests__/helpers/prime-locales";

primeLocales("de");

const hookState = vi.hoisted(() => ({
  extractPending: false,
  runPhase: "idle" as "idle" | "running" | "waitingForWorker",
}));

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
    runPhase: hookState.runPhase,
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

vi.mock("@/hooks/use-grant-document-reading-consent", () => ({
  useGrantDocumentReadingConsent: () => ({
    isPending: false,
    isError: false,
    mutate: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function render(
  locale: "en" | "de" = "en",
  options: {
    mode?: "vision" | "text";
    pdfSupported?: boolean;
    consentRequired?: boolean;
  } = {},
): string {
  // The dialog reads the account's markers once rows are on screen (v1.43).
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale={locale}>
        <OcrReviewDialog
          open
          onOpenChange={() => {}}
          mode={options.mode ?? "vision"}
          pdfSupported={options.pdfSupported ?? true}
          consentRequired={options.consentRequired}
        />
      </I18nProvider>
    </QueryClientProvider>,
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

describe("<OcrReviewDialog> document-reading consent", () => {
  it("asks for the reading consent in place of the picker while it is missing", () => {
    const html = render("en", { consentRequired: true });
    expect(html).toContain('data-slot="document-reading-consent"');
    expect(html).not.toMatch(/<input[^>]*type="file"/);
  });

  it("shows the picker once consent is in place", () => {
    const html = render("en", { consentRequired: false });
    expect(html).not.toContain('data-slot="document-reading-consent"');
    expect(html).toMatch(/<input[^>]*type="file"/);
  });
});

/**
 * A lab scan's proposed rows live only in its run: nothing is stored until
 * the person confirms them here. So the waiting line must not promise that
 * the page can be left (the result would be lost, and a second scan costs
 * another rate slot). Mutation check: swap `aiRuns.backgroundScan` for
 * `aiRuns.backgroundDocument` in the dialog → both cases go red.
 */
describe("<OcrReviewDialog> background read", () => {
  afterEach(() => {
    hookState.extractPending = false;
    hookState.runPhase = "idle";
  });

  it.each([
    ["en", "With a slow model", "leave this page"],
    ["de", "Mit einem langsamen Modell", "Seite verlassen"],
  ] as const)(
    "(%s) says it reads in the background, never that the page can be left",
    (locale, expected, forbidden) => {
      hookState.extractPending = true;
      hookState.runPhase = "running";
      const html = render(locale);
      expect(html).toContain('data-slot="ocr-run-phase"');
      expect(html).toContain(expected);
      expect(html).not.toContain(forbidden);
    },
  );
});

describe("extractErrorMessage", () => {
  const t = (key: string) => key;
  const refusal = (errorCode: string, status = 403) =>
    new ApiError("refused", status, { errorCode });

  it("reads the refusal by its code, not by the status", () => {
    expect(extractErrorMessage(refusal("consent.ai.required"), t)).toBe(
      "labs.ocr.consentRequired",
    );
    expect(
      extractErrorMessage(refusal("assistant.disabled.documentAi"), t),
    ).toBe("labs.ocr.aiUnavailable");
    expect(extractErrorMessage(refusal("ai.record.notPermitted"), t)).toBe(
      "labs.ocr.aiUnavailable",
    );
    expect(extractErrorMessage(refusal("module.disabled"), t)).toBe(
      "labs.ocr.aiUnavailable",
    );
    expect(extractErrorMessage(refusal("ai.provider.none", 422), t)).toBe(
      "labs.ocr.providerUnsupported",
    );
  });

  it("names a read cut at the output limit instead of blaming the photo", () => {
    expect(extractErrorMessage(refusal("labs.ocr.outputLimit", 422), t)).toBe(
      "labs.ocr.outputLimit",
    );
    expect(extractErrorMessage(refusal("labs.ocr.tooLarge", 422), t)).toBe(
      "labs.ocr.tooLarge",
    );
  });

  it("never calls an unrelated 403 a missing consent", () => {
    expect(extractErrorMessage(new ApiError("forbidden", 403), t)).toBe(
      "labs.ocr.extractFailed",
    );
  });
});

describe("<OcrPageCoverageNote> — a long PDF read from its first pages", () => {
  it("says how many of the pages were read", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <OcrPageCoverageNote coverage={{ read: 10, total: 23 }} />
      </I18nProvider>,
    );
    expect(html).toContain('data-slot="ocr-page-coverage"');
    expect(html).toContain("Only the first 10 of 23 pages were read.");
  });

  it("renders nothing when the whole document was read", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <OcrPageCoverageNote coverage={null} />
      </I18nProvider>,
    );
    expect(html).toBe("");
  });
});

describe("<OcrReadNotes> — what a read could not give", () => {
  const render = (notes: Parameters<typeof OcrReadNotes>[0]["notes"]) =>
    renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <OcrReadNotes notes={notes} />
      </I18nProvider>,
    );

  it("names the pages a read was cut on, or the report when it was one read", () => {
    expect(render({ truncated: { pages: [2, 5] } })).toContain(
      "partway through these pages: 2, 5.",
    );
    expect(render({ truncated: { pages: [] } })).toContain(
      "before the end of the report",
    );
  });

  it("names the pages that were not read", () => {
    expect(render({ unreadPages: [3, 4] })).toContain(
      "not in this list: 3, 4.",
    );
    expect(render({ unreadPages: [] })).toContain("Part of the report");
  });

  it("says why a scan stopped early when it was not the provider", () => {
    expect(render({ unreadPages: [4], stoppedBy: "budget" })).toContain(
      "AI budget for today ran out",
    );
    expect(render({ unreadPages: [4], stoppedBy: "unavailable" })).toContain(
      "AI was turned off while the report was being read",
    );
    const failed = render({ unreadPages: [4], stoppedBy: "error" });
    expect(failed).toContain("because of a server error");
    expect(failed).not.toContain("AI was turned off");
  });

  it("says how many readings the report had when it ran past the cap", () => {
    expect(render({ rowsCapped: { kept: 400, found: 512 } })).toContain(
      "The report lists 512 readings. One scan takes 400",
    );
  });

  it("renders nothing for a clean read", () => {
    expect(render({})).toBe("");
  });
});

describe("unitSkippedAnalytes", () => {
  const unit = (analyte: string) => ({
    analyte,
    reason: "unit_mismatch" as const,
  });

  it("is null when nothing was skipped for a unit", () => {
    expect(unitSkippedAnalytes([])).toBeNull();
    expect(
      unitSkippedAnalytes([{ analyte: "LDL", reason: "duplicate" }]),
    ).toBeNull();
  });

  it("names the analytes skipped for a unit, ignoring duplicates", () => {
    expect(
      unitSkippedAnalytes([
        { analyte: "LDL", reason: "duplicate" },
        unit("Glucose"),
        unit("Creatinine"),
      ]),
    ).toBe("Glucose, Creatinine");
  });

  it("lists three and counts the rest, once each", () => {
    expect(
      unitSkippedAnalytes([
        unit("A"),
        unit("A"),
        unit("B"),
        unit("C"),
        unit("D"),
        unit("E"),
      ]),
    ).toBe("A, B, C +2");
  });
});
