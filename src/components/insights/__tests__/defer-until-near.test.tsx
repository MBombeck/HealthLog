import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { DeferUntilNear } from "../defer-until-near";

/**
 * The first paint of a deferred slot is the sentinel alone: the children,
 * and so every read they own, wait until the slot nears the visible area.
 * The mounted state is exercised in a real browser by the e2e specs that
 * reveal the Insights overview (`e2e/utils/deferred-sections.ts`).
 */
describe("<DeferUntilNear>", () => {
  it("paints only a 1 px sentinel, never the children, before it is near", () => {
    const html = renderToStaticMarkup(
      <DeferUntilNear id="labs-changes">
        <section data-slot="labs-changes-section">reads on mount</section>
      </DeferUntilNear>,
    );
    expect(html).toBe(
      '<div data-deferred-section="labs-changes" aria-hidden="true" class="h-px"></div>',
    );
  });
});
