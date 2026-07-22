/**
 * v1.11.5 / v1.12.0 — coverage for the mood form + list.
 *
 * Project convention is SSR-only component tests (`renderToStaticMarkup`,
 * no `@testing-library/react`) plus source-string structural assertions
 * for the interactive plumbing that an SSR mount can't exercise.
 *
 * v1.12.0 rebuilt the logging surface into the "How are you?" 5-face
 * hero: the five mood faces are the primary input (rendered on a
 * pristine form), and the annotate panel — time, tags, factor ratings,
 * the note field + its counter — reveals only after a face is picked.
 * A pristine SSR mount therefore shows the hero but not the counter;
 * the counter / reset / note plumbing is pinned via source-string
 * assertions below.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { MoodForm } from "../mood-form";

function renderForm(footerSlot: HTMLElement | null = null): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 0 } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <MoodForm footerSlot={footerSlot} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const formSrc = readFileSync(resolve(__dirname, "../mood-form.tsx"), "utf8");
const listSrc = readFileSync(resolve(__dirname, "../mood-list.tsx"), "utf8");

describe("MoodForm — 5-face hero (v1.12.0)", () => {
  it("renders the five mood faces as a radiogroup on a pristine form", () => {
    const html = renderForm();
    // The "How are you?" hero is the primary input — present before any
    // mood is picked.
    expect(html).toContain('data-slot="mood-face-hero"');
    expect(html).toContain("How are you?");
    // Best-on-the-left order: every enum value renders one face button.
    for (const mood of ["SUPER_GUT", "GUT", "OKAY", "SCHLECHT", "LAUSIG"]) {
      expect(html).toContain(`data-mood="${mood}"`);
    }
    // The first face is SUPER_GUT (best on the left).
    expect(html.indexOf('data-mood="SUPER_GUT"')).toBeLessThan(
      html.indexOf('data-mood="LAUSIG"'),
    );
  });

  it("hides the annotate panel (and note counter) until a face is picked", () => {
    // A pristine SSR mount cannot pick a mood, so the panel stays closed.
    const html = renderForm();
    expect(html).not.toContain('data-slot="mood-annotate-panel"');
    expect(html).not.toContain('data-testid="mood-note-counter"');
    // The panel is gated on `moodPicked` (mood !== "").
    expect(formSrc).toContain('const moodPicked = mood !== ""');
    expect(formSrc).toMatch(
      /moodPicked &&[\s\S]*data-slot="mood-annotate-panel"/,
    );
  });
});

describe("MoodForm — note character counter (v1.11.5)", () => {
  it("ties the textarea cap to the shared NOTE_MAX_LENGTH constant", () => {
    expect(formSrc).toContain("const NOTE_MAX_LENGTH = 500");
    expect(formSrc).toContain("maxLength={NOTE_MAX_LENGTH}");
    // The counter reads off `note.length` against the same constant.
    expect(formSrc).toContain('t("mood.noteCharCount"');
    expect(formSrc).toMatch(/note\.length >= NOTE_MAX_LENGTH/);
  });
});

describe("MoodForm — Reset confirm when dirty (v1.11.5)", () => {
  it("detects dirty from the content fields, not the auto-filled timestamp", () => {
    // `isDirty` must exclude `moodLoggedAt` (always populated) so a
    // freshly opened form does not falsely warn on Reset.
    expect(formSrc).toMatch(/const isDirty =\s*\n?\s*mood !== ""/);
    expect(formSrc).toContain('tagsInput.trim() !== ""');
    expect(formSrc).toContain("tagKeys.length > 0");
    expect(formSrc).toContain("ratedFactors.length > 0");
    expect(formSrc).toContain('note.trim() !== ""');
    // The `isDirty` expression itself must not read `moodLoggedAt`.
    const isDirtyExpr = formSrc.slice(
      formSrc.indexOf("const isDirty ="),
      formSrc.indexOf('note.trim() !== ""') + 'note.trim() !== ""'.length,
    );
    expect(isDirtyExpr).not.toContain("moodLoggedAt");
  });

  it("routes Reset through requestReset, which gates the confirm dialog on dirty", () => {
    // The dropdown item calls `requestReset`, not `resetForm` directly.
    expect(formSrc).toContain("onClick={requestReset}");
    expect(formSrc).toMatch(
      /function requestReset\(\) \{[\s\S]*if \(isDirty\) \{[\s\S]*setResetConfirmOpen\(true\)/,
    );
    // A pristine form resets immediately (nothing to lose).
    expect(formSrc).toMatch(
      /if \(isDirty\) \{[\s\S]*\} else \{[\s\S]*resetForm\(\)/,
    );
  });

  it("mounts the confirm AlertDialog wired to resetForm on the destructive action", () => {
    expect(formSrc).toContain('t("mood.formResetConfirmTitle")');
    expect(formSrc).toContain('t("mood.formResetConfirmBody")');
    expect(formSrc).toContain('t("mood.formResetConfirmAction")');
    expect(formSrc).toMatch(/<AlertDialogAction[\s\S]*onClick={resetForm}/);
  });
});

describe("MoodForm — rated factors (v1.12.0)", () => {
  it("lifts a ratedFactors set and threads it to the tag picker", () => {
    expect(formSrc).toContain("const [ratedFactors, setRatedFactors]");
    expect(formSrc).toMatch(
      /function rateFactor\(key: string, rating: number \| null\)/,
    );
    // The picker receives both the binary toggle and the factor rate
    // callbacks so it can render BINARY chips and RATED controls.
    expect(formSrc).toMatch(
      /<MoodTagPicker[\s\S]*ratedFactors=\{ratedFactors\}[\s\S]*onRateFactor=\{rateFactor\}/,
    );
  });

  it("sends ratedFactors as a parallel array on POST (omitted when empty)", () => {
    expect(formSrc).toContain(
      "ratedFactors: ratedFactors.length > 0 ? ratedFactors : undefined,",
    );
    // The binary structured-tag contract stays byte-identical.
    expect(formSrc).toContain(
      "tagKeys: tagKeys.length > 0 ? tagKeys : undefined,",
    );
  });
});

describe("MoodList — rated factor editing", () => {
  it("hydrates, renders, and submits the entry's current ratedFactors", () => {
    expect(listSrc).toContain("ratedFactors: RatedFactor[];");
    expect(listSrc).toContain(
      "const [editRatedFactors, setEditRatedFactors] = useState<",
    );
    expect(listSrc).toContain(
      "ratedFactors: [...(entry.ratedFactors ?? [])].sort",
    );
    expect(listSrc).toContain("setEditRatedFactors(seed.ratedFactors)");
    expect(listSrc).toMatch(
      /<MoodTagPicker[\s\S]*ratedFactors=\{editRatedFactors\}[\s\S]*onRateFactor=\{rateEditFactor\}/,
    );
    expect(listSrc).toContain("ratedFactors: editRatedFactors,");
  });
});

describe("MoodList — delete failure toast (v1.11.5)", () => {
  it("surfaces a toast on a rejected delete instead of failing silently", () => {
    expect(listSrc).toContain('import { toast } from "sonner"');
    expect(listSrc).toMatch(
      /deleteMutation = useMutation\(\{[\s\S]*onError: \(\) => \{[\s\S]*toast\.error\(t\("mood\.deleteError"\)\)/,
    );
  });
});
