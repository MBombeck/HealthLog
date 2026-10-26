import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CONFIDENCE_TONE, ScorePill } from "../score-pill";

describe("<ScorePill>", () => {
  it("paints the pill anatomy with the tone's soft wash and no border", () => {
    const html = renderToStaticMarkup(
      <ScorePill tone="info">Medium</ScorePill>,
    );
    expect(html).toContain("rounded-full");
    expect(html).toContain("px-2 py-0.5 text-xs font-medium");
    expect(html).toContain("bg-info/15 text-info");
    expect(html).toContain('data-tone="info"');
    expect(html).not.toMatch(/\bborder\b/);
  });

  it("defaults to the neutral tone", () => {
    const html = renderToStaticMarkup(<ScorePill>Low</ScorePill>);
    expect(html).toContain("bg-secondary text-secondary-foreground");
    expect(html).toContain('data-tone="neutral"');
  });

  it("sets figures in tabular numerals when numeric", () => {
    const html = renderToStaticMarkup(
      <ScorePill tone="success" numeric>
        +4
      </ScorePill>,
    );
    expect(html).toContain("tabular-nums");
    expect(html).toContain("font-semibold");
  });

  it("lets a call site keep its own slot and override a tone token", () => {
    const html = renderToStaticMarkup(
      <ScorePill
        data-slot="target-status-pill"
        className="bg-(--status-pill-in)/10 text-(--status-pill-in)"
      >
        Optimal
      </ScorePill>,
    );
    expect(html).toContain('data-slot="target-status-pill"');
    expect(html).toContain("bg-(--status-pill-in)/10");
    expect(html).not.toContain("bg-secondary");
  });

  it("reads both confidence scales as the same three steps", () => {
    expect(CONFIDENCE_TONE.medium).toBe(CONFIDENCE_TONE.moderate);
    expect(CONFIDENCE_TONE.high).toBe("success");
    expect(CONFIDENCE_TONE.low).toBe("neutral");
  });
});
