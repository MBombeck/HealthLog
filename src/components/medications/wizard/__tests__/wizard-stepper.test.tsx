import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { WizardStepper } from "../wizard-stepper";

const STEPS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

function render() {
  return renderToStaticMarkup(
    <WizardStepper
      steps={STEPS}
      current={3}
      reachableUntil={4}
      labels={Object.fromEntries(STEPS.map((n) => [n, `Step ${n}`]))}
      onJump={() => {}}
      onFirst={() => {}}
      onLast={() => {}}
      firstEnabled
      lastEnabled={false}
      firstLabel="First step"
      lastLabel="Last step"
      srLabel="Step 3 of 8"
    />,
  );
}

/** Pixels of a spacing utility such as `p-2` or `before:-inset-y-2`. */
function px(classes: string[], pattern: RegExp): number {
  const token = classes.find((c) => pattern.test(c));
  if (!token) throw new Error(`no class matching ${pattern}`);
  return Number(token.slice(token.lastIndexOf("-") + 1)) * 4;
}

describe("<WizardStepper>", () => {
  it("renders one dot per step and marks the current one", () => {
    const html = render();
    expect(html.match(/data-slot="wizard-stepper-dot"/g)).toHaveLength(8);
    expect(html).toMatch(/data-step-dot="3"[^>]*aria-current="step"/);
  });

  it("gives every dot a 44 px tall touch target", () => {
    // The dot paints 12 px inside 8 px of padding, 28 px in all. A comment
    // used to call that a 44 px target. The hit area is what makes it one.
    const html = render();
    const dots = [
      ...html.matchAll(
        /<button[^>]*data-slot="wizard-stepper-dot"[^>]*class="([^"]*)"[^>]*><span class="([^"]*)"/g,
      ),
    ];
    expect(dots).toHaveLength(8);
    for (const [, button, dot] of dots) {
      const classes = button.split(" ");
      expect(classes).toContain("relative");
      expect(classes).toContain("before:absolute");
      const painted =
        px(dot.split(" "), /^h-\d+$/) + 2 * px(classes, /^p-\d+$/);
      const target = painted + 2 * px(classes, /^before:-inset-y-\d+$/);
      expect(target).toBeGreaterThanOrEqual(44);
    }
  });
});
