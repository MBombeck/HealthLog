/**
 * "Messwert erfassen" and "Messwert bearbeiten" show the same fields, the
 * same way. They used to be two copies that drifted: a "last value" line
 * under one, "Wert (cm)" against "Wert", two note labels, one counter. Both
 * now render `MeasurementEntryFields`; the add form alone puts the type
 * select above it.
 *
 * Two checks: the forms hold no field of their own besides that (the add
 * form's type select), and the shared body renders the same labelled fields
 * in either mode.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { readSource, stripComments } from "@/__tests__/helpers/source-files";
import { I18nProvider } from "@/lib/i18n/context";

import { MeasurementEntryFields } from "../entry/measurement-entry-fields";
import { BloodPressureFields } from "../measurement-form-parts";

const FIELD =
  /<(FieldGroup|Input|DateTimeField|Textarea|Label|GlucoseContextSelect)\b/g;

function ownFields(rel: string): string[] {
  const text = stripComments(readSource(rel, "<MeasurementEntryFields"));
  expect(text.match(/<MeasurementEntryFields\b/g)).toHaveLength(1);
  return [...text.matchAll(FIELD)].map((m) => m[1]);
}

function body(idPrefix: string, value = "88"): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <MeasurementEntryFields
        idPrefix={idPrefix}
        unit="cm"
        value={value}
        onValueChange={() => {}}
        measuredAt="2026-11-27T09:00"
        onMeasuredAtChange={() => {}}
        maxMeasuredAt="2026-11-27T10:00"
        notes=""
        onNotesChange={() => {}}
        invalid={false}
      />
    </I18nProvider>,
  );
}

function labels(idPrefix: string): string[] {
  const html = body(idPrefix);
  return [
    ...html.matchAll(/<label[^>]*for="([^"]+)"[^>]*>(.*?)<\/label>/g),
  ].map((m) => `${m[1].slice(idPrefix.length)}: ${m[2]}`);
}

describe("add and edit render one measurement form body", () => {
  it("the edit sheet has no field of its own", () => {
    expect(
      ownFields("src/components/measurements/list/measurement-edit-sheet.tsx"),
    ).toEqual([]);
  });

  it("the add form has only its type select besides the shared body", () => {
    const text = stripComments(
      readSource(
        "src/components/measurements/measurement-form.tsx",
        "measurement-type",
      ),
    );
    expect(
      ownFields("src/components/measurements/measurement-form.tsx"),
    ).toEqual(["FieldGroup"]);
    expect(text).toMatch(/<FieldGroup htmlFor="measurement-type"/);
  });

  it("renders the same labelled fields in either mode", () => {
    const add = labels("");
    expect(add.length).toBeGreaterThanOrEqual(3);
    expect(labels("edit-")).toEqual(add);
    expect(add[0]).toContain("Value (cm)");
  });

  it("leaves the value empty in add and edit: no last reading as a placeholder", () => {
    // The add sheet showed the last reading ("88") in grey in an empty
    // field, which read as a value already there. Both modes now open the
    // field empty; the body takes no placeholder to pass one through.
    for (const prefix of ["", "edit-"]) {
      const input = new RegExp(`<input[^>]*id="${prefix}value"[^>]*>`).exec(
        body(prefix, ""),
      )?.[0];
      expect(input, prefix || "add").toBeDefined();
      expect(input).not.toMatch(/placeholder=/);
      expect(input).toMatch(/value=""/);
    }
    const bp = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <BloodPressureFields
          sys=""
          dia=""
          pulse=""
          onSys={() => {}}
          onDia={() => {}}
          onPulse={() => {}}
          autoFocus={false}
          invalid={false}
        />
      </I18nProvider>,
    );
    for (const id of ["sys", "dia"]) {
      const input = new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(bp)?.[0];
      expect(input, id).toBeDefined();
      expect(input).not.toMatch(/placeholder=/);
    }
    for (const rel of [
      "src/components/measurements/measurement-form.tsx",
      "src/components/measurements/list/measurement-edit-sheet.tsx",
    ]) {
      const text = stripComments(readSource(rel, "<MeasurementEntryFields"));
      expect(text, rel).not.toMatch(/lastValuePlaceholder|placeholders?=\{/);
    }
  });
});
