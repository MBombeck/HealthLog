import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The vault filter rail's procedure facet, pinned via single-pass static
 * renders (the project's component-test convention; the open-and-pick path is
 * the vault e2e). The facet mirrors the condition facet beside it: absent when
 * nothing is filed against a procedure, an icon-only trigger on a phone while
 * inactive, the procedure's own heading once one is picked, placed between the
 * condition and the year, and counted by the one clear control.
 *
 * Mutation checks (each run, each seen red):
 *   - render the trigger with no choices → "renders no procedure control"
 *     goes red;
 *   - drop the active tint → "shows the picked procedure" goes red.
 */
import { I18nProvider } from "@/lib/i18n/context";
import { DocumentFilterBar } from "../document-filter-bar";
import type { ProcedureFilterChoice } from "../vault-utils";

const KNEE: ProcedureFilterChoice = {
  encounterId: "enc-knee",
  name: "Knee arthroscopy",
  detail: "Knee (left) · 2 Oct 2025",
};

function render({
  procedures = [KNEE],
  activeEncounterId,
  activeCount = 0,
}: {
  procedures?: ProcedureFilterChoice[];
  activeEncounterId?: string;
  activeCount?: number;
} = {}) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <DocumentFilterBar
        searchValue=""
        onSearchChange={() => {}}
        searchInputRef={{ current: null }}
        activeKinds={new Set()}
        onToggleKind={() => {}}
        conditionChips={[{ episodeId: "ep-1", name: "Knee" }]}
        activeEpisodeId={undefined}
        onToggleEpisode={() => {}}
        procedureChips={procedures}
        activeEncounterId={activeEncounterId}
        onToggleEncounter={() => {}}
        years={[2025]}
        activeYear={undefined}
        onToggleYear={() => {}}
        activeCount={activeCount}
        onClearAll={() => {}}
      />
    </I18nProvider>,
  );
}

/** The opening tag of the element carrying `data-slot="<slot>"`. */
function triggerTag(html: string, slot: string): string {
  const at = html.indexOf(`data-slot="${slot}"`);
  expect(at).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
}

describe("<DocumentFilterBar> procedure facet", () => {
  it("renders no procedure control when nothing is filed against a procedure", () => {
    const html = render({ procedures: [] });
    expect(html).not.toContain('data-slot="document-procedure-filter"');
    // The positive control: the neighbouring facets still render.
    expect(html).toContain('data-slot="document-condition-filter"');
    expect(html).toContain('data-slot="document-year-filter"');
  });

  it("sits between the condition and the year facet on the one row", () => {
    const html = render();
    const condition = html.indexOf('data-slot="document-condition-filter"');
    const procedure = html.indexOf('data-slot="document-procedure-filter"');
    const year = html.indexOf('data-slot="document-year-filter"');
    expect(condition).toBeGreaterThan(-1);
    expect(procedure).toBeGreaterThan(condition);
    expect(year).toBeGreaterThan(procedure);
    expect(html).toContain("flex flex-nowrap items-center gap-2");
  });

  it("is an icon-only trigger on a phone while inactive, named for the facet", () => {
    const html = render();
    const tag = triggerTag(html, "document-procedure-filter");
    expect(tag).toContain('aria-label="All procedures"');
    expect(tag).not.toContain("border-primary/40");
    // Same trigger chrome as the condition facet: the label hides below `sm`.
    const conditionTag = triggerTag(html, "document-condition-filter");
    expect(tag.match(/class="([^"]*)"/)?.[1]).toBe(
      conditionTag.match(/class="([^"]*)"/)?.[1],
    );
    expect(html).toContain(
      '<span class="max-w-28 min-w-0 truncate hidden sm:inline">All procedures</span>',
    );
  });

  it("shows the picked procedure's heading, tinted, and visible on a phone", () => {
    const html = render({ activeEncounterId: "enc-knee", activeCount: 1 });
    const tag = triggerTag(html, "document-procedure-filter");
    expect(tag).toContain('aria-label="Knee arthroscopy"');
    expect(tag).toContain("border-primary/40 bg-primary/10 text-foreground");
    expect(html).toContain(
      '<span class="max-w-28 min-w-0 truncate inline">Knee arthroscopy</span>',
    );
    // The one clear control appears for it like for any other facet.
    expect(html).toContain('aria-label="Clear filters"');
  });

  it("leaves the trigger at rest for a filtered visit that is not a choice", () => {
    // A routine visit reached from its own row filters the list but is not a
    // procedure: the facet must not claim it.
    const html = render({ activeEncounterId: "enc-routine", activeCount: 1 });
    const tag = triggerTag(html, "document-procedure-filter");
    expect(tag).toContain('aria-label="All procedures"');
    expect(tag).not.toContain("border-primary/40");
  });
});
