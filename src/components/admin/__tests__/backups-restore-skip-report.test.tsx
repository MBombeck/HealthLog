/**
 * The restore's skip report has to reach a human.
 *
 * The server names every catalogue key it could not resolve, in the response
 * and in the audit row, and the integration suite proves that end. This is the
 * other end: a report that a person never sees is the same silence the naming
 * exists to end, so the panel gets its own coverage rather than riding on the
 * fact that a state setter is wired up somewhere.
 *
 * Pinned here:
 *   1. every skipped key is printed, not just a total,
 *   2. each key carries its own link count and its catalogue,
 *   3. an empty report renders nothing at all — a panel that appears after a
 *      clean restore trains the operator to ignore it,
 *   4. the copy resolves in more than one locale, so a self-hoster running the
 *      German UI is told the same thing.
 *
 * Mutation check: total the links instead of listing them (drop the `<ul>`) and
 * cases 1 and 2 go red; return the panel unconditionally and case 3 goes red.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { RestoreSkipReport } from "@/components/admin/backups/restore-notices";
import type { RestoreSkipSummary } from "@/lib/export/restore-skips";
import { primeLocales } from "@/__tests__/helpers/prime-locales";

primeLocales("de");

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/backups",
}));

const REPORT: RestoreSkipSummary = {
  links: 4,
  catalogueKeys: [
    { catalogue: "cycleSymptom", key: "cs.retired_symptom", links: 2 },
    { catalogue: "illnessSymptom", key: "ill.retired_symptom", links: 1 },
    { catalogue: "moodFactor", key: "mood.retired_factor", links: 1 },
  ],
};

function render(report: RestoreSkipSummary, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <RestoreSkipReport report={report} onDismiss={() => {}} />
    </I18nProvider>,
  );
}

describe("RestoreSkipReport", () => {
  it("names every skipped key rather than only the total", () => {
    const html = render(REPORT);
    expect(html).toContain('data-slot="restore-skip-report"');
    for (const entry of REPORT.catalogueKeys) {
      expect(html).toContain(entry.key);
    }
  });

  it("gives each key its own link count and catalogue", () => {
    const html = render(REPORT);
    // The cycle key cost two links and the other two cost one each. A panel
    // that printed the grand total against every row would read as six.
    expect(html).toContain("2 links");
    expect(html).toContain("1 links");
    expect(html).toContain("Cycle symptom");
    expect(html).toContain("Illness symptom");
    expect(html).toContain("Mood factor");
    expect(html).toContain("4 links were not restored");
  });

  it("renders nothing when the restore dropped nothing", () => {
    expect(render({ links: 0, catalogueKeys: [] })).toBe("");
  });

  it("speaks the operator's language", () => {
    const german = render(REPORT, "de");
    expect(german).toContain("4 Verknüpfungen wurden nicht wiederhergestellt");
    expect(german).toContain("Zyklussymptom");
    expect(german).toContain("cs.retired_symptom");
  });
});
