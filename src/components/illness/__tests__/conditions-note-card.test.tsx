/**
 * The chronic conditions written in the medical history show on the illness
 * page, read-only, with the way to where the note is edited; never inside a
 * shared record and never while the Coach (and with it the note's editor) is
 * off.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const state = vi.hoisted(() => ({
  coach: true,
  shared: false,
  data: { conditions: "Hypothyroidism\nMild scoliosis" } as
    { conditions: string | null } | undefined,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: { enabled: boolean }) => ({
    data: opts.enabled ? state.data : undefined,
    isError: false,
    refetch: () => {},
  }),
}));
vi.mock("@/hooks/use-module-enabled", () => ({
  useModuleEnabled: (key: string) => (key === "coach" ? state.coach : true),
}));
vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({ inSharedRecord: state.shared }),
}));
vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({ t: (key: string) => key, locale: "en" }),
}));

import { ConditionsNoteCard } from "../conditions-note-card";

const render = () => renderToStaticMarkup(<ConditionsNoteCard />);

describe("ConditionsNoteCard", () => {
  it("shows the note and links to where it is edited", () => {
    state.coach = true;
    state.shared = false;
    const html = render();
    expect(html).toContain("Hypothyroidism\nMild scoliosis");
    expect(html).toContain('href="/settings/anamnesis#conditions"');
    expect(html).toContain("records.conditions.conditionsLabel");
  });

  it("renders nothing without a note", () => {
    state.data = { conditions: "  " };
    expect(render()).toBe("");
    state.data = { conditions: "Hypothyroidism" };
  });

  it("renders nothing in a shared record or with the Coach off", () => {
    state.shared = true;
    expect(render()).toBe("");
    state.shared = false;
    state.coach = false;
    expect(render()).toBe("");
    state.coach = true;
  });
});
