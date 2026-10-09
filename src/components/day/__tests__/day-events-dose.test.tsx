/**
 * An intake under "What happened" reads as its name and the dose taken on
 * one line, "Ramipril 5mg", as the same medication does under Running that
 * day. The dose on a muted line of its own under the name read as
 * "Ramipril / 5mg".
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import type { DayEvent } from "@/lib/day/contract";

import { DayEvents } from "../day-sections";

function event(
  kind: DayEvent["kind"],
  title: string,
  meta: string | null,
): DayEvent {
  return {
    at: null,
    kind,
    section: "medications",
    id: `${kind}-1`,
    title,
    meta,
    note: null,
    docs: [],
    href: null,
  };
}

/** The text of each line under the event's time and icon: its <p>s. */
function lines(events: DayEvent[]): string[] {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">
        <DayEvents events={events} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return [...html.matchAll(/<p\b[^>]*>(.*?)<\/p>/g)].map((m) => m[1]);
}

describe("DayEvents dose", () => {
  it("names an intake with its dose on one line", () => {
    expect(lines([event("intake", "Ramipril", "5mg")])).toEqual([
      "Ramipril 5mg",
    ]);
  });

  it("names an intake without a dose by its name alone", () => {
    expect(lines([event("intake", "Ramipril", null)])).toEqual(["Ramipril"]);
  });

  it("keeps a dose change's new dose on its own line", () => {
    expect(lines([event("doseChange", "Ramipril", "10 mg")])).toEqual([
      "Ramipril",
      "10 mg",
    ]);
  });
});
