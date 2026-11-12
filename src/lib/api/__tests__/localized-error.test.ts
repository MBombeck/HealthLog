import { describe, expect, it } from "vitest";

import { ApiError } from "../api-fetch";
import { localizedApiError } from "../localized-error";
import de from "../../../../messages/de.json";
import en from "../../../../messages/en.json";
import es from "../../../../messages/es.json";
import fr from "../../../../messages/fr.json";
import itCatalog from "../../../../messages/it.json";
import ko from "../../../../messages/ko.json";
import nl from "../../../../messages/nl.json";
import pl from "../../../../messages/pl.json";
import ptBR from "../../../../messages/pt-BR.json";
import ru from "../../../../messages/ru.json";

type Catalog = Record<string, unknown>;

function translator(catalog: Catalog) {
  return (key: string): string => {
    const value = key.split(".").reduce<unknown>((node, part) => {
      if (!node || typeof node !== "object") return undefined;
      return (node as Record<string, unknown>)[part];
    }, catalog);
    return typeof value === "string" ? value : key;
  };
}

const catalog = {
  measurements: { saveError: "Generic measurement failure" },
  mood: { saveError: "Generic mood failure" },
  apiErrors: {
    measurement: {
      create: { invalid: "Localized invalid measurement" },
      duplicate_timestamp: "Localized duplicate measurement",
    },
    mood: {
      create: { invalid: "Localized invalid mood" },
      not_found: "Localized missing mood",
    },
  },
};

describe("localizedApiError", () => {
  it("maps a stable hierarchical error code to localized copy", () => {
    const error = new ApiError("Validation failed", 422, {
      errorCode: "measurement.create.invalid",
    });

    expect(
      localizedApiError(error, translator(catalog), "measurements.saveError"),
    ).toBe("Localized invalid measurement");
  });

  it("never exposes the English server message for a handled code", () => {
    const error = new ApiError(
      "A mood entry with this data already exists",
      409,
      { errorCode: "mood.not_found" },
    );

    expect(
      localizedApiError(error, translator(catalog), "mood.saveError"),
    ).toBe("Localized missing mood");
  });

  it.each([
    new ApiError("raw database failure", 500),
    new ApiError("future server prose", 409, {
      errorCode: "mood.future.unknown",
    }),
    new TypeError("network details"),
  ])("uses the safe generic fallback for %s", (error) => {
    expect(
      localizedApiError(error, translator(catalog), "mood.saveError"),
    ).toBe("Generic mood failure");
  });

  it.each([
    ["de", de],
    ["en", en],
    ["es", es],
    ["fr", fr],
    ["it", itCatalog],
    ["pl", pl],
  ])(
    "resolves canonical codes in %s without exposing server prose",
    (_, locale) => {
      const error = new ApiError("raw English server prose", 422, {
        errorCode: "measurement.create.invalid",
      });
      const message = localizedApiError(
        error,
        translator(locale as Catalog),
        "measurements.saveError",
      );
      expect(message).not.toBe("raw English server prose");
      expect(message).not.toBe("apiErrors.measurement.create.invalid");
    },
  );

  it.each([
    ["de", de],
    ["en", en],
    ["es", es],
    ["fr", fr],
    ["it", itCatalog],
    ["pl", pl],
  ])("falls back safely in %s when no localized code exists", (_, locale) => {
    const error = new ApiError("raw English server prose", 409, {
      errorCode: "future.unknown",
    });
    expect(
      localizedApiError(
        error,
        translator(locale as Catalog),
        "measurements.saveError",
      ),
    ).toBe(translator(locale as Catalog)("measurements.saveError"));
  });

  describe("a refusal the client can act on", () => {
    const enT = translator(en as Catalog);

    it.each([
      ["an ended session", 401, "auth.missing", "Sign in again"],
      ["a rate limit", 429, "http.rate_limited", "too many requests"],
      ["a missing right", 403, "http.forbidden", "permission"],
      ["a rejected entry", 422, "http.invalid", "Check them"],
      ["a mistyped proof", 401, "auth.reproof.failed", "did not verify"],
      [
        "a password where a second factor is needed",
        422,
        "auth.reproof.too_weak",
        "second factor",
      ],
      [
        "an authenticator already set up",
        409,
        "auth.mfa.already_active",
        "Disable it first",
      ],
      ["nothing to test with", 422, "ai.provider.none", "No AI provider"],
      ["a spent AI budget", 429, "ai.budget.exceeded", "budget is used up"],
    ])("names %s instead of the save fallback", (_, status, code, text) => {
      const error = new ApiError("raw English server prose", status, {
        errorCode: code,
      });
      expect(localizedApiError(error, enT, "measurements.saveError")).toMatch(
        new RegExp(text, "i"),
      );
    });

    it("reads a refusal without a code by its status", () => {
      // A reverse proxy's 429 carries no envelope at all.
      const error = new ApiError("Request failed (429)", 429);
      expect(localizedApiError(error, enT, "measurements.saveError")).toBe(
        enT("apiErrors.http.rate_limited"),
      );
    });

    it.each([
      ["de", de],
      ["es", es],
      ["fr", fr],
      ["it", itCatalog],
      ["pl", pl],
    ])("has its own sentence in %s", (_, locale) => {
      const localT = translator(locale as Catalog);
      for (const code of [
        "auth.missing",
        "http.unauthenticated",
        "http.rate_limited",
        "http.forbidden",
        "http.invalid",
        "auth.reproof.too_weak",
        "auth.mfa.already_active",
        "ai.provider.none",
        "ai.budget.exceeded",
      ]) {
        const sentence = localT(`apiErrors.${code}`);
        expect(sentence).not.toBe(`apiErrors.${code}`);
        expect(sentence).not.toBe(enT(`apiErrors.${code}`));
      }
    });
  });

  describe("the refusals of the visit, vaccination, allergy, address-book and workout saves", () => {
    // Each of these is a code the route sends to a form that reads it through
    // `localizedApiError`; without a sentence the form says only "could not
    // save", which hides a fix the person can make.
    const codes = [
      "encounter.invalid",
      "encounter.practitioner-not-found",
      "encounter.reminder-not-found",
      "encounter.reminder-conflict",
      "vaccination.invalid",
      "vaccination.not-found",
      "vaccination.identity-required",
      "vaccination.practitioner-not-found",
      "vaccination.encounter-not-found",
      "vaccination.custom-vaccine-not-found",
      "vaccination.booster-invalid",
      "vaccination.booster-no-antigen",
      "vaccination.booster-out-of-scope",
      "allergy.invalid",
      "practitioner.invalid",
      "workout.batch.invalid",
      "workout.batch.too_large",
      "workout.batch.payload_too_large",
      "workout.batch.source_not_permitted",
    ];

    it.each([
      ["de", de],
      ["en", en],
      ["es", es],
      ["fr", fr],
      ["it", itCatalog],
      ["ko", ko],
      ["nl", nl],
      ["pl", pl],
      ["pt-BR", ptBR],
      ["ru", ru],
    ])("has a sentence of its own for each in %s", (_, locale) => {
      const localT = translator(locale as Catalog);
      for (const code of codes) {
        const error = new ApiError("raw English server prose", 422, {
          errorCode: code,
        });
        expect(localizedApiError(error, localT, "common.error"), code).not.toBe(
          localT("common.error"),
        );
      }
    });
  });
});
