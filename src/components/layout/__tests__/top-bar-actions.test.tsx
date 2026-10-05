import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { TopBarActions, TopBarActionsOutlet } from "../top-bar-actions";

describe("top bar actions slot", () => {
  it("renders an empty outlet that takes itself out of the row", () => {
    const html = renderToStaticMarkup(
      <TopBarActionsOutlet className="ml-auto flex empty:hidden" />,
    );
    expect(html).toBe(
      '<div data-slot="top-bar-actions" class="ml-auto flex empty:hidden"></div>',
    );
  });

  it("renders nothing in place: page actions only ever appear in the outlet", () => {
    // On the server (and before the top bar has mounted) there is no outlet,
    // so the page's actions render nowhere rather than inline in the page.
    const html = renderToStaticMarkup(
      <div>
        <TopBarActions>
          <button type="button">Toggle</button>
        </TopBarActions>
      </div>,
    );
    expect(html).toBe("<div></div>");
  });
});
