import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { Skeleton } from "../skeleton";

describe("<Skeleton>", () => {
  it("renders a presentation node so screen readers skip it", () => {
    const html = renderToStaticMarkup(<Skeleton className="h-4 w-32" />);
    expect(html).toContain('role="presentation"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("preserves caller classes alongside the pulse animation", () => {
    const html = renderToStaticMarkup(
      <Skeleton className="h-8 rounded-full" />,
    );
    // The pulse class drives the visual shimmer; honour reduce-motion.
    expect(html).toContain("animate-pulse");
    expect(html).toContain("motion-reduce:animate-none");
    // Caller's classes should survive the merge.
    expect(html).toContain("h-8");
    expect(html).toContain("rounded-full");
  });
});
