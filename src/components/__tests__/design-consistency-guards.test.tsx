import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { PageHeader } from "@/components/ui/page-header";
import { QueryErrorCard } from "@/components/ui/query-error-card";

/**
 * v1.26.0 — design-consistency guardrails.
 *
 * These pin the invariants the design-consistency wave established so a
 * later edit cannot silently undo them:
 *   1. the authenticated shell's scroll container keeps its
 *      scrollbar-gutter reservation and single centred max-width box (the
 *      width-stability contract — a 4th width-shift regression must not
 *      recur);
 *   2. the canonical `<PageHeader>` renders exactly one, correctly-styled
 *      `<h1>` (one-H1-per-page vocabulary);
 *   3. `<QueryErrorCard>` renders its retry affordance so a failed read
 *      never falls through to an honest-empty state.
 */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("width stability — auth-shell scroll container", () => {
  const source = readFileSync(
    join(process.cwd(), "src", "components", "layout", "auth-shell.tsx"),
    "utf8",
  );

  it("keeps [scrollbar-gutter:stable] on the scroll <main>", () => {
    // The reserved gutter is what stops the whole viewport widening by a
    // scrollbar's width when a short page (e.g. Integrations) hides the
    // scroll. Without it the centred container shifts on every route swap.
    expect(source).toContain("[scrollbar-gutter:stable]");
  });

  it("keeps the single centred `mx-auto max-w-screen-xl` container", () => {
    // Every authenticated surface shares ONE normalised content box. The
    // literal ordering `mx-auto max-w-screen-xl` is the class the shell
    // ships; a duplicate or differently-capped box would reintroduce the
    // per-route width drift this guard exists to prevent. The class lives
    // in `shell-metrics.ts` beside the shell's other boxes; the shell renders
    // it once.
    const metrics = readFileSync(
      join(process.cwd(), "src/components/layout/shell-metrics.ts"),
      "utf8",
    );
    expect(metrics).toMatch(
      /MAIN_CONTENT_WRAPPER_CLASS =\s*"mx-auto max-w-screen-xl /,
    );
    expect(metrics.split("mx-auto max-w-screen-xl").length - 1).toBe(1);
    expect(source).not.toContain("mx-auto max-w-screen-xl");
    expect(source.split(": MAIN_CONTENT_WRAPPER_CLASS").length - 1).toBe(1);
  });
});

describe("<PageHeader> — one canonical H1", () => {
  it("renders exactly one <h1> with the canonical type scale", () => {
    const html = render(<PageHeader title="Dashboard" />);
    const h1Count = (html.match(/<h1\b/g) ?? []).length;
    expect(h1Count).toBe(1);
    // The H1 carries the fixed header type scale used app-wide.
    expect(html).toMatch(
      /<h1[^>]*class="[^"]*text-2xl font-bold tracking-tight[^"]*"/,
    );
    expect(html).toContain("Dashboard");
  });

  it("renders no second heading when only a title is supplied", () => {
    const html = render(<PageHeader title="Settings" />);
    expect((html.match(/<h1\b/g) ?? []).length).toBe(1);
    expect(html).not.toContain("<h2");
  });
});

describe("<QueryErrorCard> — retry affordance", () => {
  it("renders a retry button when onRetry is provided", () => {
    const html = render(
      <QueryErrorCard error={new Error("boom")} onRetry={() => {}} />,
    );
    expect(html).toContain('data-slot="query-error-card"');
    expect(html).toContain('role="alert"');
    // The retry affordance is a real <button> so a failed read is
    // recoverable in-place.
    expect(html).toContain("<button");
    expect(html).toContain("Retry");
  });

  it("omits the retry button when no onRetry is supplied", () => {
    const html = render(<QueryErrorCard error={new Error("boom")} />);
    expect(html).toContain('data-slot="query-error-card"');
    expect(html).not.toContain("<button");
  });
});
