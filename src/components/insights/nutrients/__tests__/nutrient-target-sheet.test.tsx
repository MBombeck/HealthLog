/**
 * The nutrient target sheet follows the threshold sheet's anatomy: the
 * shared decimal parser, the bounds under the field, an inline alert for an
 * out-of-bounds entry, and the footer confirmed remove | Cancel | Save.
 */
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";
import type { MessageBundle } from "@/lib/i18n/load-locale";
import de from "../../../../../messages/de.json";

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate: () => undefined, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: async () => undefined }),
}));

vi.mock("@/components/ui/responsive-sheet", () => ({
  ResponsiveSheet: ({
    children,
    title,
    description,
    footer,
  }: {
    children: ReactNode;
    title: string;
    description: string;
    footer: ReactNode;
  }) => (
    <section aria-label={title}>
      <p>{description}</p>
      {children}
      <footer>{footer}</footer>
    </section>
  ),
}));

import { NutrientTargetSheet } from "../nutrient-target-sheet";

function render(
  current: { value: number; direction: "target" | "limit" } | null,
  locale: "en" | "de" = "en",
) {
  return renderToStaticMarkup(
    <I18nProvider
      initialLocale={locale}
      initialMessages={
        locale === "de" ? (de as unknown as MessageBundle) : undefined
      }
    >
      <NutrientTargetSheet
        code="protein"
        name={locale === "de" ? "Eiweiß" : "Protein"}
        unit="g"
        windowDays={30}
        current={current}
        onOpenChange={() => undefined}
      />
    </I18nProvider>,
  );
}

describe("<NutrientTargetSheet>", () => {
  it("seeds the field the reader's way, without grouping", () => {
    expect(render({ value: 82.5, direction: "target" }, "de")).toContain(
      'value="82,5"',
    );
    expect(render({ value: 82.5, direction: "target" })).toContain(
      'value="82.5"',
    );
  });

  it("names the bounds and orders the footer remove, Cancel, Save", () => {
    const html = render({ value: 120, direction: "limit" });
    expect(html).toContain("Daily target: Protein");
    expect(html).toContain("Protein per day (g)");
    expect(html).toContain("Above 0, at most");
    const remove = html.indexOf('data-slot="nutrients-target-reset"');
    const cancel = html.indexOf(">Cancel<");
    const save = html.indexOf('data-slot="nutrients-target-save"');
    expect(remove).toBeGreaterThan(-1);
    expect(cancel).toBeGreaterThan(remove);
    expect(save).toBeGreaterThan(cancel);
    // Nothing invalid on open.
    expect(html).not.toContain('role="alert"');
  });

  it("offers no remove when no target is set", () => {
    const html = render(null);
    expect(html).not.toContain("nutrients-target-reset");
    expect(html).toContain('value=""');
  });
});
