/**
 * v1.41 — the one quiet line under an answer that says the Coach kept
 * something, with Undo.
 */
import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { getServerTranslator } from "@/lib/i18n/server-translator";

const locale = vi.hoisted(() => ({ current: "en" as "en" | "de" }));
vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      getServerTranslator(locale.current).t(key, params),
  }),
}));

import { CoachMemoryNote, CoachMemoryNoteLine } from "../memory-note";

function render(node: ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      {node}
    </QueryClientProvider>,
  );
}

function find(
  node: ReactNode,
  slot: string,
): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, slot);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const el = node as ReactElement<Record<string, unknown>>;
  if (el.props["data-slot"] === slot) return el;
  return find(el.props.children as ReactNode, slot);
}

describe("<CoachMemoryNoteLine>", () => {
  it("says what was kept as one meta line, with Undo as a text button", () => {
    locale.current = "en";
    const html = render(
      <CoachMemoryNoteLine
        fact="You want to reach 75 kg by December."
        pending={false}
        onUndo={() => {}}
      />,
    );
    expect(html).toContain('data-slot="coach-memory-note"');
    expect(html).toContain("Remembered: You want to reach 75 kg by December.");
    expect(html).toMatch(/class="text-muted-foreground[^"]*text-xs/);
    expect(html).toContain(">Undo</button>");
    expect(html).not.toMatch(/\bbg-primary\b|text-muted-foreground\/\d/);
  });

  it("reads in German", () => {
    locale.current = "de";
    const html = render(
      <CoachMemoryNoteLine
        fact="Ziel 75 kg"
        pending={false}
        onUndo={() => {}}
      />,
    );
    locale.current = "en";
    expect(html).toContain("Gemerkt: Ziel 75 kg.");
    expect(html).toContain(">Rückgängig</button>");
  });

  it("Undo forgets the fact: one tap, one call", () => {
    const onUndo = vi.fn();
    const tree = CoachMemoryNoteLine({ fact: "x", pending: false, onUndo });
    const undo = find(tree, "coach-memory-note-undo");
    expect(undo).not.toBeNull();
    (undo?.props.onClick as () => void)();
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("locks Undo while the forget is on its way", () => {
    const tree = CoachMemoryNoteLine({
      fact: "x",
      pending: true,
      onUndo: () => {},
    });
    expect(find(tree, "coach-memory-note-undo")?.props.disabled).toBe(true);
  });
});

describe("<CoachMemoryNote>", () => {
  it("shows a saved fact from the live frame", () => {
    const html = render(
      <CoachMemoryNote
        note={{ proposal: false, factId: "f1", category: "goal" }}
        liveFact="Reach 75 kg by December"
      />,
    );
    expect(html).toContain("Remembered: Reach 75 kg by December.");
  });

  it("shows nothing for a proposal: the reply pills carry it", () => {
    const html = render(
      <CoachMemoryNote
        note={{ proposal: true, proposalId: "p1", category: "medication" }}
        liveFact="Takes ramipril"
      />,
    );
    expect(html).toBe("");
  });

  it("shows nothing for a persisted note whose fact is not in the list", () => {
    const html = render(
      <CoachMemoryNote
        note={{ proposal: false, factId: "gone", category: "goal" }}
      />,
    );
    expect(html).toBe("");
  });
});
