import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * v1.16.8 — full-text mood notes on the management list. The note used to be
 * readable in full only through the edit sheet (desktop hover tooltip aside,
 * unreachable on touch). Each row now carries a toggle that expands the
 * clamped two-line preview into the complete text, line breaks preserved,
 * rendered as plain React text children (no markup interpretation).
 *
 * Project convention: SSR-only component tests (`renderToStaticMarkup`) plus
 * source-string structural assertions for the interactive branch.
 */

const LONG_NOTE =
  "Erster Absatz der Notiz mit etwas längerem Text, der über die Vorschau hinausgeht.\n" +
  "Zweiter Absatz mit weiteren Details, die nur in der Vollansicht lesbar sind.";

const baseEntries = [
  {
    id: "e-1",
    date: "2026-05-09",
    mood: "GUT",
    score: 4,
    tags: ["work"],
    tagKeys: [],
    note: LONG_NOTE,
    source: "MANUAL",
    moodLoggedAt: "2026-05-09T20:00:00.000Z",
  },
  {
    id: "e-2",
    date: "2026-05-08",
    mood: "OKAY",
    score: 3,
    tags: [],
    tagKeys: [],
    note: null,
    source: "MANUAL",
    moodLoggedAt: "2026-05-08T20:00:00.000Z",
  },
];

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/mood",
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: { entries: baseEntries, meta: { total: 2 } },
    isLoading: false,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "testuser", role: "USER" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { MoodList } from "../mood-list";

function render(locale: "en" | "de" = "de") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <MoodList />
    </I18nProvider>,
  );
}

describe("MoodList — full-text note affordance", () => {
  it("renders the note as a plain clamped paragraph with the COMPLETE text", () => {
    const html = render("de");
    // One note paragraph per surface (desktop table + mobile card) for the
    // noted row; the note-less row renders none. The note is a PARAGRAPH
    // sibling of the toggle — not button content — so the accessible name
    // of the toggle never swallows the whole note.
    const notes = html.match(/data-testid="mood-note-text"/g);
    expect(notes?.length).toBe(2);
    expect(html).toContain("line-clamp-2");
    // The complete text is in the row (the clamp is visual), both paragraphs.
    expect(html).toContain("Erster Absatz der Notiz");
    expect(html).toContain("Zweiter Absatz mit weiteren Details");
    // The toggle only mounts once the client measures an actual overflow
    // (`scrollHeight > clientHeight`); static SSR has no layout, so no
    // toggle — a short note never gets a dangling "show more" control.
    expect(html).not.toContain('data-testid="mood-note-toggle"');
  });

  it("wires the toggle as a small sibling button with state + target", () => {
    const src = readFileSync(
      join(process.cwd(), "src/components/mood/mood-list-rows.tsx"),
      "utf8",
    );
    // The toggle carries the disclosure contract: aria-expanded for the
    // state, aria-controls pointing at the paragraph's id.
    expect(src).toContain("aria-expanded={expanded}");
    expect(src).toContain("aria-controls={noteId}");
    expect(src).toContain('data-testid="mood-note-toggle"');
    // Clamp detection: measured overflow, re-checked on resize.
    expect(src).toContain("scrollHeight > el.clientHeight");
    expect(src).toContain("new ResizeObserver(updateClamped)");
    // Rendered only when the text actually overflows the clamp (or while
    // expanded, so it can collapse again).
    expect(src).toContain("{(expanded || clamped) && (");
  });

  it("expanded branch preserves line breaks and renders plain text children", () => {
    const src = readFileSync(
      join(process.cwd(), "src/components/mood/mood-list-rows.tsx"),
      "utf8",
    );
    // The expanded branch must keep the author's line breaks…
    expect(src).toContain("whitespace-pre-wrap");
    // …flip the collapse label…
    expect(src).toContain('t("mood.noteCollapse")');
    expect(src).toContain('t("mood.noteExpand")');
    // …and never interpret the note as markup.
    expect(src).not.toContain("dangerouslySetInnerHTML");
  });
});
