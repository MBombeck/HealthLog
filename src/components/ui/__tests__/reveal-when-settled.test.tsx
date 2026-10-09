import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { RevealWhenSettled, scrollToHashTarget } from "../reveal-when-settled";

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

describe("scrollToHashTarget", () => {
  function setup(inside: boolean) {
    const target = { scrollIntoView: vi.fn() };
    const container = { contains: vi.fn(() => inside) };
    const doc = {
      getElementById: vi.fn((id: string) =>
        id === "insights-pill-order" ? target : null,
      ),
    };
    return {
      target,
      container,
      doc: doc as unknown as Pick<Document, "getElementById">,
    };
  }

  it("scrolls to a hash target the revealed body holds", () => {
    const { target, container, doc } = setup(true);
    expect(scrollToHashTarget(container, "#insights-pill-order", doc)).toBe(
      true,
    );
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });

  it("leaves a target outside the body to the browser", () => {
    const { target, container, doc } = setup(false);
    expect(scrollToHashTarget(container, "#insights-pill-order", doc)).toBe(
      false,
    );
    expect(target.scrollIntoView).not.toHaveBeenCalled();
  });

  it("does nothing without a hash or a target", () => {
    const { container, doc } = setup(true);
    expect(scrollToHashTarget(container, "", doc)).toBe(false);
    expect(scrollToHashTarget(container, "#", doc)).toBe(false);
    expect(scrollToHashTarget(container, "#nope", doc)).toBe(false);
    expect(scrollToHashTarget(container, "#%E0%A4%A", doc)).toBe(false);
  });
});
