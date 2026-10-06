/**
 * v1.11.2 — Settings → AI "What the Coach remembers" panel contract.
 *
 * Project convention is SSR-only tests (no `@testing-library/react`;
 * the Vitest environment is `node`). We pre-seed the `coachFacts`
 * query in a real `QueryClient` so `useQuery` resolves synchronously
 * during the `renderToStaticMarkup` pass, then assert the rendered
 * shape: facts grouped + labelled by category, the empty state, and
 * the per-fact + bulk "forget" controls that drive the DELETE
 * mutations.
 *
 * The mutation wiring itself (DELETE `/facts/{id}` and DELETE `/facts`
 * → `queryKeys.coachFacts()` invalidation + toast) is pinned by the
 * route-shape contract in the component plus the typecheck gate; this
 * suite guards the render contract the way the sibling
 * `disable-coach-card.test.tsx` does for the toggle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { CoachMemorySection } from "../coach-memory-section";

interface SeedFact {
  id: string;
  category:
    | "preference"
    | "condition"
    | "goal"
    | "constraint"
    | "context"
    | "medication";
  text: string;
  confidence: number;
  createdAt: string;
  source?: "user" | "coach" | "extracted" | "pattern";
}

const NOW = "2026-06-04T12:00:00.000Z";

function buildFacts(): SeedFact[] {
  return [
    {
      id: "fact-goal-1",
      category: "goal",
      text: "Wants to reach 80 kg by autumn",
      confidence: 0.9,
      createdAt: NOW,
    },
    {
      id: "fact-pref-1",
      category: "preference",
      text: "Prefers morning workouts",
      confidence: 0.8,
      createdAt: NOW,
    },
    {
      id: "fact-cond-1",
      category: "condition",
      text: "Takes ramipril for blood pressure",
      confidence: 0.95,
      createdAt: NOW,
    },
  ];
}

beforeEach(() => {
  // The component never fetches when the query is pre-seeded fresh, but
  // stub fetch so any background refetch can't escape to the network.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { facts: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function render(facts: SeedFact[] | "skip"): string {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: 0, staleTime: Infinity, gcTime: Infinity },
    },
  });
  if (facts !== "skip") {
    client.setQueryData(queryKeys.coachFacts(), facts);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <CoachMemorySection isAuthenticated />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("Settings — CoachMemorySection", () => {
  it("renders the facts grouped by category", () => {
    const html = render(buildFacts());
    // Each populated category surfaces its group heading...
    expect(html).toContain(
      'data-testid="settings-coach-memory-group-preference"',
    );
    expect(html).toContain('data-testid="settings-coach-memory-group-goal"');
    expect(html).toContain(
      'data-testid="settings-coach-memory-group-condition"',
    );
    // ...and the localized category labels render.
    expect(html).toContain("Preferences");
    expect(html).toContain("Goals");
    expect(html).toContain("Conditions");
    // The fact text appears verbatim.
    expect(html).toContain("Prefers morning workouts");
    expect(html).toContain("Wants to reach 80 kg by autumn");
    // No group rows for categories that have no facts.
    expect(html).not.toContain(
      'data-testid="settings-coach-memory-group-constraint"',
    );
  });

  it("renders a per-fact forget control and the bulk forget-all action", () => {
    const html = render(buildFacts());
    // The per-row control routes through `ConfirmButton`, which identifies
    // itself with `data-slot`; the bulk one is still a local dialog.
    expect(html).toContain('data-slot="settings-coach-memory-forget"');
    expect(html).toContain('data-testid="settings-coach-memory-forget-all"');
    // One forget button per fact (3 seeded).
    const forgetButtons = html.match(
      /data-slot="settings-coach-memory-forget"/g,
    );
    expect(forgetButtons).toHaveLength(3);
  });

  it("renders the empty state with the explainer when there are no facts", () => {
    const html = render([]);
    expect(html).toContain('data-testid="settings-coach-memory-empty"');
    // The bulk action hides when there is nothing to forget.
    expect(html).not.toContain(
      'data-testid="settings-coach-memory-forget-all"',
    );
    // No fact rows.
    expect(html).not.toContain('data-testid="settings-coach-memory-fact"');
  });

  it("always shows the rolling-summary note", () => {
    const withFacts = render(buildFacts());
    const empty = render([]);
    // The summary explainer is present in both states (it has no
    // per-row control — deleting a conversation removes its summary).
    expect(withFacts).toContain("rolling summary");
    expect(empty).toContain("rolling summary");
  });

  it("says where each fact came from, and offers to edit it", () => {
    const html = render([
      { ...buildFacts()[0], source: "user" },
      { ...buildFacts()[1], source: "coach" },
      { ...buildFacts()[2], source: "extracted" },
      {
        id: "fact-med-1",
        category: "medication",
        text: "Takes ramipril in the morning",
        confidence: 1,
        createdAt: NOW,
        source: "user",
      },
    ]);
    expect(
      html.match(/data-slot="settings-coach-memory-source"/g),
    ).toHaveLength(4);
    expect(html).toContain("from you");
    expect(html).toContain("from the Coach");
    expect(html.match(/data-slot="settings-coach-memory-edit"/g)).toHaveLength(
      4,
    );
    expect(html).toMatch(
      /data-slot="settings-coach-memory-edit"[^>]*aria-label="Edit"/,
    );
    // Medications get their own group.
    expect(html).toContain(
      'data-testid="settings-coach-memory-group-medication"',
    );
    expect(html).toContain("Medications");
    // The quick settings land here.
    expect(html).toMatch(/<section[^>]*id="coach-memory"/);
  });

  it("lists goals first", () => {
    const html = render(buildFacts());
    expect(html.indexOf("group-goal")).toBeLessThan(
      html.indexOf("group-preference"),
    );
  });
});
