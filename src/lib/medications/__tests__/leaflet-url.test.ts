/**
 * #1430 — the saved leaflet link: any host, `https:` only, bounded, and the
 * same rule for the edit form, the request schema and the restore.
 */
import { describe, expect, it } from "vitest";

import {
  LEAFLET_URL_MAX_CHARS,
  isAcceptableLeafletUrl,
  restoredLeafletUrl,
} from "@/lib/medications/leaflet-url";
import { leafletUrlField } from "@/lib/validations/medication";

describe("isAcceptableLeafletUrl", () => {
  it.each([
    "https://cima.aemps.es/cima/pdfs/es/p/12345/P_12345.pdf",
    "https://www.example.org/leaflet?id=1&lang=de#page=2",
    "https://xn--bckerei-dxa.de/beipackzettel.pdf",
  ])("accepts %s", (url) => {
    expect(isAcceptableLeafletUrl(url)).toBe(true);
  });

  it.each([
    "http://example.org/leaflet.pdf",
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "ftp://example.org/leaflet.pdf",
    "example.org/leaflet.pdf",
    "https://user:pass@example.org/leaflet.pdf",
    "https://example.org/leaf let.pdf",
    "https://example.org/\nleaflet.pdf",
    "",
    `https://example.org/${"a".repeat(LEAFLET_URL_MAX_CHARS)}`,
  ])("refuses %j", (url) => {
    expect(isAcceptableLeafletUrl(url)).toBe(false);
  });
});

describe("leafletUrlField", () => {
  it("trims, accepts https, and lets an empty string or null clear it", () => {
    expect(leafletUrlField.parse("  https://example.org/a.pdf ")).toBe(
      "https://example.org/a.pdf",
    );
    expect(leafletUrlField.parse("")).toBe("");
    expect(leafletUrlField.parse(null)).toBeNull();
    expect(leafletUrlField.parse(undefined)).toBeUndefined();
  });

  it.each(["javascript:alert(1)", "http://example.org", "not a link"])(
    "refuses %j",
    (value) => {
      expect(leafletUrlField.safeParse(value).success).toBe(false);
    },
  );
});

describe("restoredLeafletUrl", () => {
  it("keeps an acceptable link and drops anything else", () => {
    expect(restoredLeafletUrl(" https://example.org/a.pdf ")).toBe(
      "https://example.org/a.pdf",
    );
    expect(restoredLeafletUrl("javascript:alert(1)")).toBeNull();
    expect(restoredLeafletUrl(null)).toBeNull();
    expect(restoredLeafletUrl(undefined)).toBeNull();
  });
});

describe("the data export", () => {
  it("carries the saved leaflet link, and an empty cell when there is none", async () => {
    const { formatMedicationsForExport } = await import("@/lib/export");
    const row = {
      name: "Ramipril",
      dose: "5 mg",
      active: true,
      trackIntake: true,
      note: null,
      schedules: [],
    };
    const [withLink, without] = formatMedicationsForExport([
      { ...row, leafletUrl: "https://example.org/leaflet.pdf" },
      { ...row, leafletUrl: null },
    ]);
    expect(withLink.leafletUrl).toBe("https://example.org/leaflet.pdf");
    expect(without.leafletUrl).toBe("");
  });
});
