import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { PriorityCard } from "../priority-card";
import {
  PRIORITY_ITEM_KINDS,
  type PriorityItem,
  type PriorityItemKind,
} from "@/lib/daily/priority-item";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

function item(
  over: Partial<PriorityItem> & { kind: PriorityItemKind },
): PriorityItem {
  return {
    title: "Something to look at",
    actions: [
      {
        labelKey: "daily.action.reconnect",
        intent: "sync.reconnect",
        href: "/settings/integrations",
      },
    ],
    ...over,
  };
}

describe("<PriorityCard>", () => {
  it("renders every kind of the discriminated union without throwing", () => {
    for (const kind of PRIORITY_ITEM_KINDS) {
      const html = render(<PriorityCard item={item({ kind })} />);
      expect(html).toContain(`data-kind="${kind}"`);
      expect(html).toContain("Something to look at");
    }
  });

  it("renders the grounded body one-liner", () => {
    const html = render(
      <PriorityCard
        item={item({ kind: "dose_window", body: "Ramipril is due today." })}
      />,
    );
    expect(html).toContain("Ramipril is due today.");
  });

  it("applies a semantic status wash (meaning, not decoration)", () => {
    const warn = render(
      <PriorityCard item={item({ kind: "sync_issue", status: "warning" })} />,
    );
    expect(warn).toContain("bg-warning/10");
    const info = render(
      <PriorityCard item={item({ kind: "preventive_care", status: "info" })} />,
    );
    expect(info).toContain("bg-info/10");
  });

  it("carries the metric-family accent for metric-flavoured kinds only", () => {
    const tension = render(
      <PriorityCard item={item({ kind: "tension_window" })} />,
    );
    expect(tension).toContain("metric-accent");
    expect(tension).toContain("--tile-hue:var(--tile-stress)");
    const ecg = render(
      <PriorityCard item={item({ kind: "ecg_new_recording" })} />,
    );
    expect(ecg).toContain("--tile-hue:var(--tile-strain)");
    // Utility kinds carry no metric identity — status alone speaks.
    const sync = render(<PriorityCard item={item({ kind: "sync_issue" })} />);
    expect(sync).not.toContain("metric-accent");
  });

  it("gives the milestone card the quiet reached treatment instead of the generic fade-in", () => {
    const html = render(
      <PriorityCard item={item({ kind: "milestone", status: "success" })} />,
    );
    expect(html).toContain("milestone-reached");
    expect(html).not.toContain("animate-insight-in");
    // The success wash still carries the semantic border.
    expect(html).toContain("border-success/25");
  });

  it("renders a navigation action as a link carrying the href", () => {
    const html = render(
      <PriorityCard
        item={item({
          kind: "sync_issue",
          actions: [
            {
              labelKey: "daily.action.reconnect",
              intent: "sync.reconnect",
              href: "/settings/integrations",
            },
          ],
        })}
      />,
    );
    expect(html).toContain('href="/settings/integrations"');
    expect(html).toContain("Reconnect");
  });

  it("renders a non-navigation action as a button (no href)", () => {
    const html = render(
      <PriorityCard
        item={item({
          kind: "coach_checkin",
          actions: [{ labelKey: "daily.action.logDose", intent: "dose.log" }],
        })}
        onAction={() => {}}
      />,
    );
    expect(html).toContain("<button");
    expect(html).toContain(">Take<");
  });

  it("omits a non-navigation action entirely when no handler is passed", () => {
    // v1.36.x — the caller withholds `onAction` inside somebody else's
    // record. The mutating half of the rail must then be absent, not an
    // inert button: `TodayHero` passes no handler at either grant level, and
    // a rendered control that calls nothing is worse than one that 403s.
    const html = render(
      <PriorityCard
        item={item({
          kind: "coach_checkin",
          actions: [
            { labelKey: "daily.action.logDose", intent: "dose.log" },
            {
              labelKey: "daily.action.viewCheckups",
              intent: "checkup.view",
              href: "/checkups",
            },
          ],
        })}
      />,
    );
    expect(html).not.toContain(">Take<");
    // Navigation is untouched — reading is never what a delegation withholds.
    expect(html).toContain('href="/checkups"');
  });

  it("resolves action label keys through the active locale", () => {
    const html = render(
      <PriorityCard
        item={item({
          kind: "preventive_care",
          actions: [
            {
              labelKey: "daily.action.viewCheckups",
              intent: "checkup.view",
              href: "/checkups",
            },
          ],
        })}
      />,
    );
    expect(html).toContain("Open Care");
  });

  // An appointment keeps the check-up label on the wire for the shipped iOS
  // app; the web names what the link opens. The check-up item above is the
  // negative control.
  it("names an appointment's action for the visit it opens", () => {
    const action = (href: string) => ({
      labelKey: "daily.action.viewCheckups",
      intent: "checkup.view",
      href,
    });
    const one = render(
      <PriorityCard
        item={item({
          kind: "upcoming_visit",
          actions: [action("/checkups?visit=v1")],
        })}
      />,
    );
    expect(one).toContain("View appointment");
    expect(one).not.toContain("Open Care");
    expect(one).toContain('href="/checkups?visit=v1"');
    const several = render(
      <PriorityCard
        item={item({
          kind: "upcoming_visit",
          actions: [action("/checkups?view=visits")],
        })}
      />,
    );
    expect(several).toContain("View appointments");
  });

  describe("dismiss affordance — observational kinds only", () => {
    const DISMISSIBLE: PriorityItemKind[] = [
      "milestone",
      "ecg_new_recording",
      "tension_window",
    ];
    const ACTIONABLE: PriorityItemKind[] = [
      "dose_window",
      "sync_issue",
      "preventive_care",
      "coach_checkin",
    ];

    it("renders the dismiss button on every observational kind that carries an itemKey", () => {
      for (const kind of DISMISSIBLE) {
        const html = render(
          <PriorityCard
            item={item({ kind, itemKey: `${kind}:instance-1` })}
            onDismiss={() => {}}
          />,
        );
        expect(html).toContain('data-slot="priority-card-dismiss"');
      }
    });

    it("never renders the dismiss button on an actionable kind, even if a caller wires onDismiss", () => {
      for (const kind of ACTIONABLE) {
        const html = render(
          <PriorityCard
            item={item({ kind, itemKey: `${kind}:instance-1` })}
            onDismiss={() => {}}
          />,
        );
        expect(html).not.toContain('data-slot="priority-card-dismiss"');
      }
    });

    it("does not render the dismiss button when the item carries no itemKey (server didn't stamp one)", () => {
      const html = render(
        <PriorityCard
          item={item({ kind: "milestone" })}
          onDismiss={() => {}}
        />,
      );
      expect(html).not.toContain('data-slot="priority-card-dismiss"');
    });

    it("does not render the dismiss button when the caller passes no onDismiss handler", () => {
      const html = render(
        <PriorityCard
          item={item({ kind: "milestone", itemKey: "milestone:instance-1" })}
        />,
      );
      expect(html).not.toContain('data-slot="priority-card-dismiss"');
    });
  });
});
