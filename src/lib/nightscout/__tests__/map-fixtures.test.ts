/**
 * What the Nightscout parse and mapping make of a fixed set of payloads,
 * pinned in `__golden__/map-*.json`.
 *
 * `__fixtures__/entries.json` is a synthetic `/api/v1/entries.json` answer in
 * the documented wire shape, mixing what an instance really returns: typed
 * and untyped SGV rows, meter-BG and calibration rows, a missing value or
 * timestamp, string-typed numbers, a non-string `_id`, non-object rows and
 * zero values. The URL builder, the SHA1 helper and the non-array payloads
 * run from small tables in this file.
 *
 * The golden was written before the mappers moved out of `client.ts`, so a
 * green run is the proof that the move changed nothing.
 */
import { describe, expect, it } from "vitest";
import { format } from "prettier";

import {
  buildEntriesUrl,
  externalIdFor,
  mapSgvEntryToMeasurement,
  parseSgvEntries,
  sha1Hex,
} from "../client";

import entriesFixture from "./__fixtures__/entries.json";

/** The golden is written in the repository's JSON format, so the format check passes on it unchanged. */
async function golden(value: unknown): Promise<string> {
  return format(JSON.stringify(value), { parser: "json" });
}

describe("Nightscout mappers against the golden fixtures", () => {
  it("parses SGV entries and maps each to a measurement", async () => {
    const parsed = parseSgvEntries(entriesFixture);
    const output = {
      parsed,
      mapped: parsed.map((entry) => ({
        externalId: externalIdFor(entry),
        measurement: mapSgvEntryToMeasurement(entry),
      })),
    };
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-entries.json",
    );
  });

  it("answers an empty list for payloads that are not an entry array", async () => {
    const payloads: Array<[string, unknown]> = [
      ["error object", { status: 401, message: "Unauthorized" }],
      ["login page", "<!doctype html><title>Nightscout</title>"],
      ["null", null],
      ["number", 7],
      ["empty array", []],
    ];
    const output = payloads.map(([name, payload]) => ({
      name,
      parsed: parseSgvEntries(payload),
    }));
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-non-array-payloads.json",
    );
  });

  it("builds the entries URL", async () => {
    const inputs: Array<[string, number, string | undefined]> = [
      ["https://ns.example.org", 288, undefined],
      ["https://ns.example.org/", 288, "reader-0123456789abcdef"],
      ["https://ns.example.org///", 1, ""],
      ["https://example.org/nightscout", 50, "token with spaces&more=1"],
      ["http://ns.example.org:1337", 0, "reader-token"],
    ];
    const output = inputs.map(([baseUrl, count, token]) => ({
      baseUrl,
      count,
      token: token ?? null,
      url: buildEntriesUrl(baseUrl, count, token),
    }));
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-entries-url.json",
    );
  });

  it("hashes the API secret", async () => {
    const inputs = ["", "example-api-secret", "secret-with-umlaut-äöü"];
    const output = inputs.map((value) => ({ value, sha1: sha1Hex(value) }));
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-sha1.json",
    );
  });
});
