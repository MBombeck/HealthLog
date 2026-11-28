import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { readSource } from "@/__tests__/helpers/source-files";

vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({ t: (k: string) => k }),
}));

const { ActionPair } = await import("../action-pair");
const { ActionMenu } = await import("../action-menu");

describe("<ActionPair>", () => {
  it("takes an ActionMenu out of the pair and stands it beside it", () => {
    const html = renderToStaticMarkup(
      <ActionPair>
        <ActionMenu>
          <span>Reset</span>
        </ActionMenu>
        <button type="button">Cancel</button>
        <button type="button">Save</button>
      </ActionPair>,
    );
    const pair = html.slice(html.indexOf('data-slot="action-pair"'));
    expect(html).toContain('data-slot="action-menu"');
    expect(pair).not.toContain('data-slot="action-menu"');
    expect(pair).toContain("Cancel");
    expect(pair).toContain("Save");
  });

  // Every dialog, sheet and alert footer renders through action-pair.tsx, so
  // the dropdown it would import lands on every page with a dialog (about
  // 20 KB gz on first load). The menu and its dropdown live in action-menu.tsx.
  it("does not import the dropdown menu", () => {
    const src = readSource("src/components/ui/action-pair.tsx", [
      "function ActionPair(",
      "isActionMenu",
    ]);
    expect(src).not.toMatch(
      /from\s+["']@\/components\/ui\/(dropdown-menu|action-menu)["']/,
    );
    expect(src).not.toMatch(/from\s+["']radix-ui["']/);
  });
});
