/**
 * A reply asked for as bare prose sometimes comes back wrapped:
 * `{"summary": "…"}`, the same in a fence, a fence around the text. Only the
 * text inside is the answer; prose that merely contains braces is left alone.
 */
import { describe, expect, it } from "vitest";

import { proseFromModelReply } from "../prose-reply";

const TEXT = "A lab report from a general practice, listing blood values.";

describe("proseFromModelReply", () => {
  it.each([
    ["a JSON object", `{"summary": "${TEXT}"}`],
    ["a fenced JSON object", "```json\n" + `{"summary": "${TEXT}"}` + "\n```"],
    ["unquoted keys", `{summary: "${TEXT}"}`],
    ["single quotes", `{'summary': '${TEXT}'}`],
    ["a different prose key", `{"text": "${TEXT}"}`],
    ["a lone field of any name", `{"zusammenfassung": "${TEXT}"}`],
    ["a fence around the text", "```\n" + TEXT + "\n```"],
    ["a JSON string", JSON.stringify(TEXT)],
    ["surrounding whitespace", `\n  {"summary": "${TEXT}"}  \n`],
  ])("unwraps %s", (_label, reply) => {
    expect(proseFromModelReply(reply, "summary")).toBe(TEXT);
  });

  it("keeps escaped line breaks as line breaks", () => {
    expect(proseFromModelReply('{"summary": "One.\\nTwo."}', "summary")).toBe(
      "One.\nTwo.",
    );
  });

  it("prefers the expected key over other text fields", () => {
    expect(
      proseFromModelReply(
        `{"title": "Report", "summary": "${TEXT}"}`,
        "summary",
      ),
    ).toBe(TEXT);
  });

  it.each([
    ["plain prose", TEXT],
    ["prose with braces inside", `The value {x} is listed. ${TEXT}`],
    ["an object with no single text answer", '{"a": "one", "b": "two"}'],
    ["an object with an empty field", '{"summary": ""}'],
    ["malformed JSON", '{"summary": "unterminated}'],
  ])("leaves %s as it is", (_label, reply) => {
    expect(proseFromModelReply(reply, "summary")).toBe(reply.trim());
  });
});
