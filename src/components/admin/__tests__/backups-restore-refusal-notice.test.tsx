/**
 * A refused backup has to tell the operator what to do next.
 *
 * The server refuses a file whose manifest claims a section the file does not
 * carry, before it deletes anything. That refusal reaches a person through the
 * `code` on the restore job's failure, and a bare "restore failed" toast
 * would waste it: the operator on the other end is frequently holding the only
 * copy of an account, and the two facts they can act on — which section is
 * missing, and that nothing was changed — have to stay on screen.
 *
 * Pinned here:
 *   1. the missing sections are named, not counted,
 *   2. the notice says nothing was changed and what to do instead,
 *   3. no sections means no notice — a panel that appears after every restore
 *      trains the operator to ignore it,
 *   4. the copy resolves in more than one locale,
 *   5. `missingSectionsOf` keys on the failure code and not on the message text,
 *      so rewording the server's prose cannot silently remove the panel.
 *
 * Mutation check: render a count instead of the list and case 1 goes red; drop
 * the remedy line and case 2 goes red; return the notice unconditionally and
 * case 3 goes red; match on the message string in `missingSectionsOf` and case
 * 5 goes red.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import {
  RestoreRefusalNotice,
  missingSectionsOf,
} from "@/components/admin/backups-section";
import type { MissingBackupSection } from "@/lib/export/restore-skips";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/backups",
}));

function render(
  sections: MissingBackupSection[],
  locale: "en" | "de" = "en",
): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <RestoreRefusalNotice sections={sections} onDismiss={() => {}} />
    </I18nProvider>,
  );
}

describe("RestoreRefusalNotice", () => {
  it("names every missing section", () => {
    const html = render(["documents", "consent"]);

    expect(html).toContain('data-slot="restore-refusal-notice"');
    expect(html).toContain("Documents");
    expect(html).toContain("Consent receipts");
  });

  it("says nothing was changed, and what to do instead", () => {
    const html = render(["documents"]);

    expect(html).toContain("Nothing was changed");
    expect(html).toContain("disaster-recovery snapshot");
  });

  it("renders nothing when no section was missing", () => {
    expect(render([])).toBe("");
  });

  it("speaks the operator's language", () => {
    const german = render(["documents", "mentalHealth"], "de");

    expect(german).toContain("Dokumente");
    expect(german).toContain("Psychische Fragebögen");
    expect(german).toContain("Es wurde nichts geändert");
  });
});

describe("missingSectionsOf", () => {
  it("reads the sections off the failed job", () => {
    expect(
      missingSectionsOf({
        code: "backup.section.missing",
        sections: ["documents"],
      }),
    ).toEqual(["documents"]);
  });

  it("ignores a failure whose message merely looks like one", () => {
    // The message is prose the server may reword. Only the code counts.
    expect(
      missingSectionsOf({ code: "something_else", sections: ["documents"] }),
    ).toEqual([]);
    expect(missingSectionsOf(null)).toEqual([]);
  });

  it("survives a refusal with no section list", () => {
    expect(missingSectionsOf({ code: "backup.section.missing" })).toEqual([]);
  });
});
