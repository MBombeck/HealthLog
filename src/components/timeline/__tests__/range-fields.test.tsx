/**
 * The chosen-range fields: two date fields with the record's limits, and
 * every change made honest before it leaves (never past today, never before
 * the first entry, never inverted).
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { DateFieldProps } from "@/components/ui/date-field";

const fields: DateFieldProps[] = [];
vi.mock("@/components/ui/date-field", () => ({
  DateField: (props: DateFieldProps) => {
    fields.push(props);
    return (
      <input
        aria-label={props["aria-label"]}
        data-testid={props["data-testid"]}
        data-min={props.min}
        data-max={props.max}
        value={props.value}
        readOnly
      />
    );
  },
}));

const { RangeFields } = await import("../range-fields");

const TODAY = "2026-10-07";

function render(onChange: (next: { from: string; to: string }) => void) {
  fields.length = 0;
  const html = renderToStaticMarkup(
    <I18nProvider initialLocale="de">
      <RangeFields
        range={{ from: "2026-03-01", to: "2026-04-15" }}
        today={TODAY}
        dataFrom="2019-03-10"
        onChange={onChange}
      />
    </I18nProvider>,
  );
  const [from, to] = fields;
  return { html, from, to };
}

describe("<RangeFields>", () => {
  it("names both ends and carries the record's limits", () => {
    const { html, from, to } = render(() => undefined);
    expect(html).toContain('data-slot="timeline-range"');
    expect(html).toContain('data-from="2026-03-01"');
    expect(html).toContain('data-to="2026-04-15"');
    expect(html).toContain('aria-label="Gewählter Zeitraum"');
    expect(from["aria-label"]).toBe("Von");
    expect(to["aria-label"]).toBe("Bis");
    expect(from.min).toBe("2019-03-10");
    expect(from.max).toBe("2026-04-15");
    expect(to.min).toBe("2026-03-01");
    expect(to.max).toBe(TODAY);
  });

  it("passes a valid change on as it is", () => {
    const onChange = vi.fn();
    const { from, to } = render(onChange);
    from.onChange?.("2026-02-01");
    expect(onChange).toHaveBeenLastCalledWith({
      from: "2026-02-01",
      to: "2026-04-15",
    });
    to.onChange?.("2026-05-31");
    expect(onChange).toHaveBeenLastCalledWith({
      from: "2026-03-01",
      to: "2026-05-31",
    });
  });

  it("clamps softly instead of refusing", () => {
    const onChange = vi.fn();
    const { from, to } = render(onChange);
    // Before the first entry: the first entry.
    from.onChange?.("2010-01-01");
    expect(onChange).toHaveBeenLastCalledWith({
      from: "2019-03-10",
      to: "2026-04-15",
    });
    // Past today: today.
    to.onChange?.("2027-01-01");
    expect(onChange).toHaveBeenLastCalledWith({
      from: "2026-03-01",
      to: TODAY,
    });
    // A start after the end: the end.
    from.onChange?.("2026-05-01");
    expect(onChange).toHaveBeenLastCalledWith({
      from: "2026-04-15",
      to: "2026-04-15",
    });
  });

  it("ignores a cleared field", () => {
    const onChange = vi.fn();
    const { from } = render(onChange);
    from.onChange?.("");
    expect(onChange).not.toHaveBeenCalled();
  });
});
