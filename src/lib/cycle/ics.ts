/**
 * A small, hand-rolled RFC 5545 writer for the cycle calendar feed (#1350).
 *
 * The feed needs one shape of calendar: all-day events, a published
 * subscription, no time zones and no recurrence. That is a few dozen lines of
 * the specification, so it is written here rather than taken from a
 * dependency whose defaults (descriptions, organisers, alarms, a VTIMEZONE)
 * would each be something to switch off.
 *
 * What the specification asks for and this does:
 *   * CRLF line endings (§3.1).
 *   * Lines folded at 75 octets, never inside a UTF-8 sequence, continued with
 *     a single space (§3.1).
 *   * TEXT escaping of backslash, semicolon, comma and newline (§3.3.11).
 *   * All-day events as `VALUE=DATE`, with DTEND exclusive (§3.6.1).
 *
 * Pure: no clock, no database. The caller hands in the stamp.
 */
import { createHash, createHmac } from "node:crypto";

export interface IcsEvent {
  /** Globally unique and stable across rebuilds of the same feed. */
  uid: string;
  /** First day, `YYYY-MM-DD`. */
  start: string;
  /** The day AFTER the last day, `YYYY-MM-DD` (DTEND is exclusive). */
  endExclusive: string;
  summary: string;
  description?: string;
}

export interface IcsCalendar {
  /** `X-WR-CALNAME`, the name a calendar app shows for the subscription. */
  name: string;
  events: readonly IcsEvent[];
}

const CRLF = "\r\n";
const MAX_OCTETS = 75;

/** The stamp a body is hashed with, so the hash never depends on the clock. */
const HASH_STAMP = "19700101T000000Z";

/** §3.3.11 — escape a TEXT value. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * §3.1 — fold a content line at 75 octets. Continuation lines begin with one
 * space, which counts toward their own 75. Splits only between code points,
 * so a multibyte character is never cut in half.
 */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = "";
  let octets = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, "utf8");
    if (octets + size > MAX_OCTETS) {
      out.push(current);
      current = " ";
      octets = 1;
    }
    current += ch;
    octets += size;
  }
  out.push(current);
  return out.join(CRLF);
}

/** `YYYY-MM-DD` → `YYYYMMDD`. */
function icsDate(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(`Not a calendar day: ${day}`);
  }
  return day.replace(/-/g, "");
}

/** A UTC instant as `YYYYMMDDTHHMMSSZ`. */
export function icsStamp(at: Date): string {
  return at
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lower case, unpadded. */
function base32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * A stable event UID: the feed's id keys an HMAC over the slot (`obs:<cycle
 * id>` or `pred:<k>`). Stable across rebuilds of one feed, so a calendar app
 * updates an event in place; unrelated across feeds, so a rotated link starts
 * a fresh set; and it carries neither a user id nor a host.
 */
export function eventUid(feedId: string, slot: string): string {
  const mac = createHmac("sha256", feedId).update(slot).digest();
  return `${base32(mac.subarray(0, 20))}@healthlog.invalid`;
}

function render(calendar: IcsCalendar, stamp: string): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//HealthLog//Calendar feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(calendar.name)}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
  ];
  for (const event of calendar.events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.uid}`,
      `DTSTAMP:${stamp}`,
      `LAST-MODIFIED:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(event.start)}`,
      `DTEND;VALUE=DATE:${icsDate(event.endExclusive)}`,
      `SUMMARY:${escapeText(event.summary)}`,
    );
    if (event.description) {
      lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    }
    lines.push("TRANSP:TRANSPARENT", "CLASS:PRIVATE", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join(CRLF) + CRLF;
}

/**
 * The SHA-256 of the calendar as it would render with a fixed stamp. Equal
 * inputs give an equal hash whatever the clock says, which is what lets the
 * feed move its stamps only when the content moved.
 */
export function icsContentHash(calendar: IcsCalendar): string {
  return createHash("sha256")
    .update(render(calendar, HASH_STAMP))
    .digest("hex");
}

/** The calendar, every event stamped with `changedAt`. */
export function renderIcs(calendar: IcsCalendar, changedAt: Date): string {
  return render(calendar, icsStamp(changedAt));
}
