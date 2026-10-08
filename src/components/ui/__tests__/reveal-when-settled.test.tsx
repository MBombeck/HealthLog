import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { RevealWhenSettled } from "../reveal-when-settled";

/**
 * The body mounts at once (so its reads start) but stays out of layout until
 * they settle; the fallback holds the place. Nothing inside a `display: none`
 * box can register a layout shift, which is the point.
 */
describe("<RevealWhenSettled>", () => {
  it("paints the fallback and keeps the mounted body out of layout", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <RevealWhenSettled fallback={<div data-testid="fallback" />}>
          <p data-testid="body">content</p>
        </RevealWhenSettled>
      </QueryClientProvider>,
    );
    expect(html).toContain('data-testid="fallback"');
    expect(html).toContain('data-testid="body"');
    expect(html).toMatch(
      /data-slot="reveal-when-settled" data-revealed="false" aria-busy="true" class="hidden"/,
    );
  });
});
