import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { Stepper } from "../stepper";

const STEPS = [
  { id: "medication", label: "Medication" },
  { id: "dose", label: "Dose" },
  { id: "schedule", label: "Schedule" },
  { id: "review", label: "Review" },
];

function render(props: Partial<Parameters<typeof Stepper>[0]> = {}) {
  return renderToStaticMarkup(
    <Stepper
      steps={STEPS}
      current={2}
      fraction={0.5}
      countLabel="Step 3 of 4"
      {...props}
    />,
  );
}

describe("<Stepper>", () => {
  it("lays out one equal column per step", () => {
    const html = render();
    expect(html.match(/data-slot="stepper-step"/g)).toHaveLength(4);
    expect(html).toContain("grid-template-columns:repeat(4, minmax(0, 1fr))");
  });

  it("names the band with the count and marks exactly one current step", () => {
    const html = render();
    expect(html).toMatch(/<nav aria-label="Step 3 of 4"/);
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="step"[^>]*data-step-id="schedule"/);
  });

  it("fills done steps, the current one by its fraction, and nothing ahead", () => {
    const html = render();
    const fills = [
      ...html.matchAll(/data-step-id="(\w+)"[^>]*data-fill="([\d.]+)"/g),
    ].map((m) => [m[1], Number(m[2])]);
    expect(fills).toEqual([
      ["medication", 1],
      ["dose", 1],
      ["schedule", 0.5],
      ["review", 0],
    ]);
    expect(html.match(/data-slot="stepper-fill"/g)).toHaveLength(4);
    expect(html.match(/forced-colors:border-2/g)).toHaveLength(3);
    expect(html).toContain("width:50%");
  });

  it("clamps a fraction outside 0..1", () => {
    expect(render({ fraction: 3 })).toContain(
      'data-step-id="schedule" data-state="current" data-fill="1"',
    );
    expect(render({ fraction: -1 })).toContain(
      'data-step-id="schedule" data-state="current" data-fill="0"',
    );
  });

  it("renders no buttons without onStepSelect", () => {
    expect(render()).not.toContain("<button");
  });

  it("makes reachable steps buttons, never the current one", () => {
    const html = render({ onStepSelect: () => {}, reachableUntil: 3 });
    expect(html.match(/data-slot="stepper-step-button"/g)).toHaveLength(3);
    expect(html).not.toMatch(/data-step-id="schedule"[^>]*>\s*<button/);
  });

  it("leaves steps past reachableUntil as plain text", () => {
    const html = render({ onStepSelect: () => {}, reachableUntil: 2 });
    expect(html.match(/data-slot="stepper-step-button"/g)).toHaveLength(2);
    expect(html).toMatch(/data-step-id="review"[^>]*><div/);
  });

  it("gives a tappable segment a 44 px hit area on a finger", () => {
    const html = render({ onStepSelect: () => {}, reachableUntil: 3 });
    expect(html).toContain("pointer-coarse:before:h-11");
  });

  it("animates the fill only without a reduced-motion preference", () => {
    const html = render();
    expect(html).toContain("motion-safe:transition-[width]");
    expect(html).not.toMatch(/(?<!motion-safe:)transition-\[width\]/);
  });

  it("uses the track token and keeps both marks in forced colours", () => {
    const html = render();
    expect(html).toContain("bg-progress-track");
    expect(html).toMatch(/forced-colors:border[\s"]/);
    expect(html).toContain("forced-colors:border-2");
  });

  it("shows the count at the top right on every width", () => {
    const html = render();
    expect(html).toMatch(/data-slot="stepper-count">Step 3 of 4</);
    expect(html).not.toMatch(/data-slot="stepper-count"[^>]*md:hidden/);
  });
});
