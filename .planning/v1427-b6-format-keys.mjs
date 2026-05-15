#!/usr/bin/env node
// v1.4.27 B6 — commit 2.
// Add locale-native date format ordering as i18n strings.
// Each bundle documents its native ordering for date/time format
// patterns — DE/EN keep their existing ordering, FR/ES/IT use
// {day}/{month}/{year}, PL uses {day}.{month}.{year}.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");
const MESSAGES = join(ROOT, "messages");

const FORMATS = {
  de: {
    dateShort: "{day}.{month}.{year}",
    timeShort: "{hour}:{minute}",
    dateTime: "{day}.{month}.{year} {hour}:{minute}",
  },
  en: {
    dateShort: "{month}/{day}/{year}",
    timeShort: "{hour}:{minute}",
    dateTime: "{month}/{day}/{year} {hour}:{minute}",
  },
  fr: {
    dateShort: "{day}/{month}/{year}",
    timeShort: "{hour}:{minute}",
    dateTime: "{day}/{month}/{year} {hour}:{minute}",
  },
  es: {
    dateShort: "{day}/{month}/{year}",
    timeShort: "{hour}:{minute}",
    dateTime: "{day}/{month}/{year} {hour}:{minute}",
  },
  it: {
    dateShort: "{day}/{month}/{year}",
    timeShort: "{hour}:{minute}",
    dateTime: "{day}/{month}/{year} {hour}:{minute}",
  },
  pl: {
    dateShort: "{day}.{month}.{year}",
    timeShort: "{hour}:{minute}",
    dateTime: "{day}.{month}.{year} {hour}:{minute}",
  },
};

for (const [locale, fmt] of Object.entries(FORMATS)) {
  const path = join(MESSAGES, `${locale}.json`);
  const data = JSON.parse(readFileSync(path, "utf8"));
  // Insert `format` namespace at the top of the object after `common`,
  // preserving JSON object ordering by rebuilding.
  const reordered = {};
  for (const [k, v] of Object.entries(data)) {
    reordered[k] = v;
    if (k === "common") {
      reordered.format = fmt;
    }
  }
  if (!("format" in reordered)) reordered.format = fmt;
  writeFileSync(path, JSON.stringify(reordered, null, 2) + "\n", "utf8");
  console.log(`${locale}.json: added format namespace`);
}
