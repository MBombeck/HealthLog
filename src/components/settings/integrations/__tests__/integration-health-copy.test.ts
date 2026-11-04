import { describe, expect, it } from "vitest";

import { locales, type Locale } from "@/lib/i18n/config";
import { makeFormatters } from "@/lib/format-locale";
import {
  CONNECTION_HEALTH_REASONS,
  CONNECTION_HEALTH_STATES,
} from "@/lib/integrations/connection-health";

import de from "../../../../../messages/de.json";
import ru from "../../../../../messages/ru.json";
import en from "../../../../../messages/en.json";
import es from "../../../../../messages/es.json";
import fr from "../../../../../messages/fr.json";
import itMessages from "../../../../../messages/it.json";
import ko from "../../../../../messages/ko.json";
import nl from "../../../../../messages/nl.json";
import pl from "../../../../../messages/pl.json";
import ptBR from "../../../../../messages/pt-BR.json";

import {
  diagnosticsText,
  formatHealthInstant,
  healthBadgeLabel,
  healthSentence,
  namedItemList,
} from "../integration-health-copy";
import { healthFixture } from "./health-fixture";

const CATALOGS: Record<Locale, unknown> = {
  de,
  en,
  es,
  fr,
  it: itMessages,
  pl,
  nl,
  ko,
  "pt-BR": ptBR,
  ru: ru,
};

function translator(locale: Locale) {
  return (key: string, params?: Record<string, string | number>) => {
    const value = key
      .split(".")
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        CATALOGS[locale],
      );
    if (typeof value !== "string") return key;
    return value.replace(/\{(\w+)\}/g, (_, name: string) =>
      String(params?.[name] ?? `{${name}}`),
    );
  };
}

const NOW = new Date("2026-10-15T12:00:00.000Z");
const fmt = makeFormatters("de", "Europe/Berlin", "AUTO", "AUTO");
const t = translator("de");

describe("formatHealthInstant", () => {
  it("reads today and yesterday with the time, older instants with the date", () => {
    expect(formatHealthInstant("2026-10-15T05:12:00.000Z", t, fmt, NOW)).toBe(
      "heute, 07:12",
    );
    expect(formatHealthInstant("2026-10-14T16:40:00.000Z", t, fmt, NOW)).toBe(
      "gestern, 18:40",
    );
    expect(formatHealthInstant("2026-10-12T12:00:00.000Z", t, fmt, NOW)).toBe(
      "12.10., 14:00",
    );
  });

  it("buckets the day in the reader's zone, not UTC", () => {
    // 23:30 UTC on the 14th is already the 15th in Berlin.
    expect(formatHealthInstant("2026-10-14T23:30:00.000Z", t, fmt, NOW)).toBe(
      "heute, 01:30",
    );
  });
});

describe("namedItemList", () => {
  it("names up to three types", () => {
    expect(
      namedItemList(
        [
          { item: "spo2", cause: "plan" },
          { item: "vascularAge", cause: "plan" },
          { item: "ecg", cause: "plan" },
        ],
        t,
        "de",
      ),
    ).toBe("SpO2, Gefäßalter und EKG und Vorhofflimmern");
  });

  it("names two and counts the rest beyond three", () => {
    expect(
      namedItemList(
        ["spo2", "vascularAge", "ecg", "vo2Max", "weight"].map((item) => ({
          item,
          cause: "plan" as const,
        })),
        t,
        "de",
      ),
    ).toBe("SpO2, Gefäßalter und 3 weitere Werte");
  });

  it("names the Withings activity scope gap", () => {
    expect(
      namedItemList(
        [
          { item: "activity", cause: "permission" },
          { item: "sleep", cause: "permission" },
        ],
        t,
        "de",
      ),
    ).toBe("Aktivität und Schlaf");
  });
});

describe("healthSentence", () => {
  const opts = { provider: "Oura", locale: "de" as const, fmt, now: NOW };

  it("uses the dated sentence when the server dates the condition", () => {
    expect(
      healthSentence(
        healthFixture({
          state: "degraded",
          reason: "no_new_data",
          since: "2026-10-14T16:40:00.000Z",
        }),
        t,
        opts,
      ),
    ).toBe("Seit gestern, 18:40 sind keine neuen Daten gekommen.");
  });

  it("falls back to an undated sentence rather than printing nothing", () => {
    expect(
      healthSentence(
        healthFixture({ state: "degraded", reason: "provider_errors" }),
        t,
        opts,
      ),
    ).toBe(
      "Oura antwortet gerade nicht zuverlässig. HealthLog versucht es weiter, du musst nichts tun.",
    );
  });

  it("tells an Apple Health user to open the app", () => {
    expect(
      healthSentence(
        healthFixture({
          state: "degraded",
          reason: "no_new_data",
          since: "2026-10-12T12:00:00.000Z",
        }),
        t,
        { ...opts, provider: "Apple Health", appleHealth: true },
      ),
    ).toBe(
      "Seit 12.10., 14:00 sind keine neuen Daten gekommen. Öffne HealthLog einmal auf dem iPhone.",
    );
  });

  it.each(locales)(
    "has a sentence and a badge word for every state and reason in %s",
    (locale) => {
      const tl = translator(locale);
      const f = makeFormatters(locale, "Europe/Berlin", "AUTO", "AUTO");
      for (const state of CONNECTION_HEALTH_STATES) {
        const word = healthBadgeLabel(state, tl);
        expect(word).not.toContain("settings.");
      }
      for (const reason of CONNECTION_HEALTH_REASONS) {
        for (const since of [null, "2026-10-14T16:40:00.000Z"]) {
          const sentence = healthSentence(
            healthFixture({
              reason,
              since,
              unavailable: [
                { item: "spo2", cause: "plan" },
                { item: "activity", cause: "permission" },
              ],
            }),
            tl,
            { provider: "Oura", locale, fmt: f, now: NOW },
          );
          expect(sentence, `${locale} ${reason}`).not.toMatch(
            /settings\.|\{\w+\}| · | — | – /,
          );
          expect(sentence.length).toBeGreaterThan(5);
        }
      }
    },
  );
});

describe("diagnosticsText", () => {
  it("prints the draft's block from health alone", () => {
    const text = diagnosticsText(
      {
        version: "1.42.4",
        provider: "Oura",
        health: healthFixture({
          state: "degraded",
          reason: "provider_errors",
          since: "2026-10-14T18:40:00.000Z",
          lastSuccessAt: "2026-10-14T18:12:00.000Z",
          lastDataAt: "2026-10-14T07:55:00.000Z",
          unavailable: [{ item: "spo2", cause: "permission" }],
          diagnostics: {
            ledgerState: "error_transient",
            failingLegs: ["sleep"],
            failingSince: "2026-10-14T18:40:00.000Z",
            lastAttemptAt: "2026-10-15T09:15:00.000Z",
            verdict: "failing",
            recentCalls: [
              {
                endpoint: "sleep",
                status: "transient",
                at: "2026-10-15T09:15:00.000Z",
                errorCode: "503",
              },
              {
                endpoint: "readiness",
                status: "ok",
                at: "2026-10-15T08:15:00.000Z",
                errorCode: null,
              },
            ],
          },
        }),
      },
      t,
    );
    expect(text.split("\n")).toEqual([
      "HealthLog 1.42.4  Oura",
      "Zustand: degraded / provider_errors seit 2026-10-14 18:40 UTC",
      "Letzte Synchronisierung: 2026-10-14 18:12 UTC",
      "Letzte Daten: 2026-10-14 07:55 UTC",
      "Ledger: error_transient, fehlende Teile: sleep",
      "Letzte Aufrufe:",
      "  2026-10-15 09:15  sleep      transient        503",
      "  2026-10-15 08:15  readiness  ok",
      "Nicht verfügbar: spo2 (Freigabe)",
    ]);
  });

  it("leaves out what the server does not know instead of inventing it", () => {
    const text = diagnosticsText(
      {
        version: "",
        provider: "Apple Health",
        health: healthFixture({
          lastSuccessAt: null,
          lastDataAt: null,
          diagnostics: {
            ledgerState: null,
            failingLegs: [],
            failingSince: null,
            lastAttemptAt: null,
            verdict: "fresh",
            recentCalls: [],
          },
        }),
      },
      t,
    );
    expect(text.split("\n")).toEqual([
      "HealthLog  Apple Health",
      "Zustand: ok / data_arriving",
      "Letzte Synchronisierung: keine",
      "Letzte Daten: keine",
    ]);
  });
});
