import { describe, expect, it } from "vitest";

import {
  foldForMatch,
  isHit,
  markMatches,
  queryWords,
  scoreCandidate,
  snippetOf,
  WEIGHT,
  type SearchCandidate,
} from "../match";
import { normalizeSearchText } from "@/lib/encounters/procedures";

/** `scoreCandidate` for a raw query, the way the search route calls it. */
function scoreForQuery(
  c: Pick<SearchCandidate, "fields" | "contentWords">,
  query: string,
) {
  return scoreCandidate(c, queryWords(query), normalizeSearchText(query));
}

function candidate(
  fields: SearchCandidate["fields"],
): Pick<SearchCandidate, "fields"> {
  return { fields };
}

const hit = (text: string, query: string, weight: number = WEIGHT.primary) =>
  isHit(scoreForQuery(candidate([{ text, weight }]), query));

/** The marked substrings, for readable assertions. */
const marks = (text: string, query: string) =>
  markMatches(text, query).map(([s, e]) => text.slice(s, e));

describe("folding", () => {
  it("ignores case, accents and the German keyboard spellings", () => {
    expect(foldForMatch("Schulter")).toBe("schulter");
    expect(foldForMatch("Hüfte")).toBe(foldForMatch("Huefte"));
    expect(foldForMatch("Fuß")).toBe(foldForMatch("Fuss"));
    expect(foldForMatch("Müdigkeit")).toBe("mudigkeit");
    expect(foldForMatch("  FSME   Impfung ")).toBe("fsme impfung");
  });

  it("matches a term whatever way either side spells the umlaut", () => {
    expect(hit("Schulter links", "schulter")).toBe(true);
    expect(hit("schulter links", "SCHULTER")).toBe(true);
    expect(hit("Hüftschmerzen", "hueft")).toBe(true);
    expect(hit("Hueftschmerzen", "hüft")).toBe(true);
    expect(hit("Fußgelenk", "fuss")).toBe(true);
    expect(hit("Schläfrig", "schlaefrig")).toBe(true);
  });

  it("does not match what is not there", () => {
    expect(hit("Knie rechts", "schulter")).toBe(false);
    // A short word must start a word: "arm" is not inside "Darm".
    expect(hit("Darmspiegelung", "arm")).toBe(false);
    expect(hit("Armbruch", "arm")).toBe(true);
  });

  it("finds a body part across languages", () => {
    expect(hit("Schulter", "shoulder")).toBe(true);
    expect(hit("left shoulder", "Schulter")).toBe(true);
  });
});

describe("queryWords", () => {
  it("drops filler and keeps the tokeniser's form", () => {
    expect(queryWords("meine letzte Schulter OP")).toEqual(["schulter"]);
  });
});

describe("marks", () => {
  it("marks the original characters, not the folded ones", () => {
    expect(marks("Hüftgelenk und Hüfte", "hueft")).toEqual(["Hüft", "Hüft"]);
    expect(marks("Fußgelenk", "fuss")).toEqual(["Fuß"]);
    expect(marks("Huefte", "hüfte")).toEqual(["Huefte"]);
    expect(marks("SCHULTER links", "schulter")).toEqual(["SCHULTER"]);
  });

  it("marks a short word only at a word start", () => {
    expect(marks("Arm und Darm", "arm")).toEqual(["Arm"]);
  });

  it("marks a query too short for the tokeniser by itself", () => {
    expect(marks("Hb und HbA1c", "hb")).toEqual(["Hb", "Hb"]);
  });

  it("merges overlapping marks", () => {
    expect(markMatches("Schulterschmerz", "schulter schulterschmerz")).toEqual([
      [0, 15],
    ]);
  });

  it("keeps ranges inside the text for multi-unit characters", () => {
    const text = "😀 Schulter";
    const [[start, end]] = markMatches(text, "schulter");
    expect(text.slice(start, end)).toBe("Schulter");
  });
});

describe("snippetOf", () => {
  it("returns the whole short text with its marks", () => {
    const s = snippetOf("Schmerzen in der Schulter", "schulter");
    expect(s?.text).toBe("Schmerzen in der Schulter");
    expect(s?.marks).toEqual([[17, 25]]);
  });

  it("cuts a long text around the first match at word boundaries", () => {
    const filler = "Lorem ipsum dolor sit amet ".repeat(20);
    const s = snippetOf(`${filler}die Schulter tut weh ${filler}`, "schulter");
    expect(s).not.toBeNull();
    expect(s!.text.startsWith("…")).toBe(true);
    expect(s!.text.endsWith("…")).toBe(true);
    expect(s!.text.length).toBeLessThanOrEqual(142);
    const [[start, end]] = s!.marks;
    expect(s!.text.slice(start, end)).toBe("Schulter");
  });

  it("is null when the text does not contain the query", () => {
    expect(snippetOf("Knie", "schulter")).toBeNull();
  });
});

describe("ranking inputs", () => {
  it("a title hit scores above a note hit", () => {
    const title = scoreForQuery(
      candidate([{ text: "Schulter", weight: WEIGHT.primary }]),
      "schulter",
    );
    const note = scoreForQuery(
      candidate([{ text: "Schulter", weight: WEIGHT.tertiary, body: true }]),
      "schulter",
    );
    expect(title.score).toBeGreaterThan(note.score);
  });

  it("counts each matched word once", () => {
    const s = scoreCandidate(
      candidate([
        { text: "Schulter links", weight: WEIGHT.primary },
        { text: "links", weight: WEIGHT.secondary },
      ]),
      ["schulter", "links"],
      "schulter links",
    );
    expect(s.matched).toBe(2);
  });
});
