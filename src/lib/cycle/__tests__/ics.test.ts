/**
 * #1350 — the RFC 5545 writer behind the calendar feed.
 */
import { describe, expect, it } from "vitest";

import {
  escapeText,
  eventUid,
  foldLine,
  icsContentHash,
  icsStamp,
  renderIcs,
  type IcsCalendar,
} from "../ics";

const CAL: IcsCalendar = {
  name: "HealthLog",
  events: [
    {
      uid: "abc@healthlog.invalid",
      start: "2026-11-10",
      endExclusive: "2026-11-17",
      summary: "●",
      description: "±2 days",
    },
  ],
};

const STAMP = new Date("2026-11-06T09:30:00.000Z");

describe("renderIcs", () => {
  it("matches the golden body", () => {
    expect(renderIcs(CAL, STAMP)).toBe(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//HealthLog//Calendar feed//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:HealthLog",
        "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
        "X-PUBLISHED-TTL:PT6H",
        "BEGIN:VEVENT",
        "UID:abc@healthlog.invalid",
        "DTSTAMP:20261106T093000Z",
        "LAST-MODIFIED:20261106T093000Z",
        "DTSTART;VALUE=DATE:20261110",
        "DTEND;VALUE=DATE:20261117",
        "SUMMARY:●",
        "DESCRIPTION:±2 days",
        "TRANSP:TRANSPARENT",
        "CLASS:PRIVATE",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n"),
    );
  });

  it("ends every line with CRLF and carries no bare LF", () => {
    const body = renderIcs(CAL, STAMP);
    expect(body.endsWith("\r\n")).toBe(true);
    expect(body.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("writes all-day events with an exclusive DTEND and no time zone", () => {
    const body = renderIcs(CAL, STAMP);
    expect(body).toContain("DTSTART;VALUE=DATE:20261110");
    expect(body).toContain("DTEND;VALUE=DATE:20261117");
    expect(body).not.toContain("VTIMEZONE");
    expect(body).not.toContain("TZID");
  });

  it("refuses a malformed day rather than writing a broken calendar", () => {
    expect(() =>
      renderIcs(
        { name: "x", events: [{ ...CAL.events[0], start: "2026-11-1" }] },
        STAMP,
      ),
    ).toThrow();
  });
});

describe("escapeText", () => {
  it("escapes backslash, semicolon, comma and newline", () => {
    expect(escapeText("a\\b;c,d\ne")).toBe("a\\\\b\\;c\\,d\\ne");
    expect(escapeText("x\r\ny")).toBe("x\\ny");
  });
});

describe("foldLine", () => {
  const octets = (s: string) => Buffer.byteLength(s, "utf8");

  it("leaves a short line alone", () => {
    expect(foldLine("SUMMARY:short")).toBe("SUMMARY:short");
  });

  it("folds at 75 octets with a leading space on each continuation", () => {
    const folded = foldLine(`DESCRIPTION:${"a".repeat(200)}`);
    const lines = folded.split("\r\n");
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(octets(line)).toBeLessThanOrEqual(75);
    for (const line of lines.slice(1)) expect(line.startsWith(" ")).toBe(true);
    expect(lines.map((l, i) => (i === 0 ? l : l.slice(1))).join("")).toBe(
      `DESCRIPTION:${"a".repeat(200)}`,
    );
  });

  it("never splits a multibyte character", () => {
    // Cyrillic and Hangul are two and three octets each; a byte-counted cut
    // would land inside one of them sooner or later.
    const value = `SUMMARY:${"Месячные 생리 ".repeat(12)}`;
    const lines = foldLine(value).split("\r\n");
    for (const line of lines) {
      expect(octets(line)).toBeLessThanOrEqual(75);
      // A cut through a sequence would leave a replacement character after a
      // round trip through bytes.
      expect(Buffer.from(line, "utf8").toString("utf8")).toBe(line);
      expect(line).not.toContain("�");
    }
    expect(lines.map((l, i) => (i === 0 ? l : l.slice(1))).join("")).toBe(
      value,
    );
  });
});

describe("eventUid", () => {
  it("is stable for a feed and a slot, and unrelated across feeds", () => {
    const a = eventUid("feed-1", "pred:1");
    expect(eventUid("feed-1", "pred:1")).toBe(a);
    expect(eventUid("feed-1", "pred:2")).not.toBe(a);
    expect(eventUid("feed-2", "pred:1")).not.toBe(a);
    expect(a).toMatch(/^[a-z2-7]{32}@healthlog\.invalid$/);
  });

  it("carries neither the feed id nor the slot", () => {
    const uid = eventUid("cmfeedid123", "obs:cmcycleid456");
    expect(uid).not.toContain("cmfeedid123");
    expect(uid).not.toContain("cmcycleid456");
  });
});

describe("icsContentHash", () => {
  it("does not depend on the stamp, only on the content", () => {
    expect(icsContentHash(CAL)).toBe(icsContentHash({ ...CAL }));
    expect(icsContentHash(CAL)).not.toBe(
      icsContentHash({ ...CAL, events: [] }),
    );
  });

  it("formats a stamp as basic UTC", () => {
    expect(icsStamp(STAMP)).toBe("20261106T093000Z");
  });
});
