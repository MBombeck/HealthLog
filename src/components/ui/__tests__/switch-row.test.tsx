import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Bell } from "lucide-react";

import { SwitchRow } from "../switch-row";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(node);
}

describe("<SwitchRow>", () => {
  it("binds the name to the switch and gives it no colon", () => {
    const html = render(
      <SwitchRow id="predictions" label="Predictions" checked={false} />,
    );
    expect(html).toMatch(
      /<label[^>]*data-no-colon="true"[^>]*for="predictions"|<label[^>]*for="predictions"[^>]*data-no-colon="true"/,
    );
    expect(html).toMatch(/<button[^>]*role="switch"[^>]*id="predictions"/);
  });

  it("keeps the switch beside the name at every width", () => {
    // The admin toggles stacked the switch under the text below `sm`. There
    // is no breakpoint in the row: one flex line, the switch never wraps.
    const html = render(
      <SwitchRow
        label="Offer the push relay"
        description="Each person decides in their own app."
        checked
      />,
    );
    const row = /<div[^>]*data-slot="switch-row"[^>]*class="([^"]*)"/.exec(
      html,
    )![1];
    expect(row.split(" ")).toEqual(
      expect.arrayContaining(["flex", "justify-between", "items-center"]),
    );
    expect(row).not.toMatch(/flex-col|flex-wrap|sm:|md:/);
    expect(html).toMatch(/<button[^>]*class="[^"]*shrink-0/);
  });

  it("renders the description as one muted fine-print line, announced with the switch", () => {
    const html = render(
      <SwitchRow
        id="discreet"
        label="Discreet notifications"
        description="Hide cycle details on your lock screen."
        checked={false}
      />,
    );
    expect(html).toContain(
      '<p id="discreet-description" class="text-muted-foreground text-xs">Hide cycle details on your lock screen.</p>',
    );
    expect(html).toMatch(/<button[^>]*aria-describedby="discreet-description"/);
  });

  it("centres the switch on a row that is only a name too", () => {
    const html = render(<SwitchRow label="Visits" checked />);
    expect(html).toMatch(/data-slot="switch-row"[^>]*class="[^"]*items-center/);
  });

  it("hands every other prop to the switch and the class to the row", () => {
    const html = render(
      <SwitchRow
        label="Reminders"
        icon={Bell}
        checked
        disabled
        className="py-3"
        data-slot="wizard-reminders-toggle"
        aria-label="Reminders on"
      >
        <p>Always on.</p>
      </SwitchRow>,
    );
    expect(html).toMatch(/<div[^>]*class="[^"]*py-3/);
    expect(html).toMatch(
      /<button[^>]*role="switch"[^>]*data-slot="wizard-reminders-toggle"|<button[^>]*data-slot="wizard-reminders-toggle"[^>]*role="switch"/,
    );
    expect(html).toMatch(/<button[^>]*disabled=""/);
    expect(html).toContain('aria-label="Reminders on"');
    expect(html).toContain("<svg");
    expect(html).toContain("<p>Always on.</p>");
  });
});
