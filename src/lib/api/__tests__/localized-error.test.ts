import { describe, expect, it } from "vitest";

import { ApiError } from "../api-fetch";
import { localizedApiError } from "../localized-error";
import de from "../../../../messages/de.json";
import en from "../../../../messages/en.json";
import es from "../../../../messages/es.json";
import fr from "../../../../messages/fr.json";
import itCatalog from "../../../../messages/it.json";
import pl from "../../../../messages/pl.json";

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
});
