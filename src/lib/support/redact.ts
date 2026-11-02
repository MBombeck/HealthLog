/**
 * Redaction for the support report.
 *
 * The report is meant to be pasted into a public issue. It is built from
 * counts, states and closed codes, so in the ordinary case there is nothing
 * here to remove. These steps are the second layer: the free-text fields the
 * report does carry (an error class, a delivery reason, an action name) come
 * from places a future change could fill with something it should not, and
 * the whole rendered text runs through every step before it leaves.
 *
 * The steps are an ordered list rather than one function so the guard test
 * can drop each one in turn and prove it is load-bearing: with any single
 * step removed, a seeded value of its class reaches the output.
 *
 * Never an email address, an account id, a token, a host name, an address or
 * a value an account wrote.
 */
import { redactSecrets } from "@/lib/logging/redact";

/** Values that belong to this instance's accounts and must never appear. */
export interface SupportRedactionContext {
  /** Email addresses, usernames, display names, account ids. */
  knownValues: readonly string[];
}

export interface SupportRedactionStep {
  name: string;
  apply: (text: string, context: SupportRedactionContext) => string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Shortest known value replaced. Shorter usernames (`ann`, `max`) are left to
 * the structural rules: the report prints no username anywhere, and a
 * three-letter match would rewrite ordinary words of the report itself.
 */
const KNOWN_VALUE_MIN_LENGTH = 5;

/**
 * Top-level domains a host name in a self-hosted setup ends in: the generic
 * ones, the home-network suffixes, and the country codes of every place the
 * app's languages are at home (`HOST_TLD_LOCALE_REGIONS` in the test pins
 * that list against `locales`), plus the neighbours a self-hoster there is
 * as likely to register under. A second-level registry (`com.br`, `co.uk`)
 * needs nothing extra: the label before it is matched as a subdomain.
 */
export const HOST_TLDS = [
  // Generic.
  "com",
  "net",
  "org",
  "io",
  "dev",
  "app",
  "cloud",
  "info",
  "me",
  "co",
  "xyz",
  "online",
  "site",
  "eu",
  // Country codes.
  "de",
  "at",
  "ch",
  "li",
  "lu",
  "be",
  "nl",
  "fr",
  "es",
  "pt",
  "br",
  "ao",
  "mz",
  "it",
  "pl",
  "cz",
  "sk",
  "kr",
  "jp",
  "uk",
  "ie",
  "us",
  "ca",
  "au",
  "nz",
  "mx",
  "ar",
  "se",
  "dk",
  "no",
  "fi",
  "ru",
  "by",
  "kz",
  "ua",
  // Home-network and private suffixes.
  "local",
  "lan",
  "home",
  "internal",
  "arpa",
  "localdomain",
  "ts",
];

const HOST_TLD_PATTERN = HOST_TLDS.join("|");

export const SUPPORT_REDACTION_STEPS: readonly SupportRedactionStep[] = [
  {
    // Exact values of this instance's accounts, wherever they turn up.
    name: "known-values",
    apply: (text, context) => {
      let out = text;
      const values = [...new Set(context.knownValues)]
        .map((v) => v.trim())
        .filter((v) => v.length >= KNOWN_VALUE_MIN_LENGTH)
        // Longest first, so an email is replaced before the username in it.
        .sort((a, b) => b.length - a.length);
      for (const value of values) {
        out = out.replace(new RegExp(escapeRegExp(value), "gi"), "[account]");
      }
      return out;
    },
  },
  {
    // Bearer tokens, API keys, path and query secrets: the shared scrubber.
    name: "secrets",
    apply: (text) => redactSecrets(text),
  },
  {
    name: "urls",
    apply: (text) =>
      text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)>\]]+/gi, "[url]"),
  },
  {
    name: "emails",
    apply: (text) =>
      text.replace(
        /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
        "[email]",
      ),
  },
  {
    // UUIDs and cuid-shaped ids: account, record and request ids.
    name: "ids",
    apply: (text) =>
      text
        .replace(
          /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
          "[id]",
        )
        .replace(/\bc[a-z0-9]{20,32}\b/g, "[id]"),
  },
  {
    name: "ip-addresses",
    apply: (text) =>
      text
        // Not after a slash or a dot: `Chrome/128.0.0.0` is a version.
        .replace(/(?<![/\w.])(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]")
        // Four groups or more, so a clock time (`10:00:00`) is not one.
        .replace(/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, "[ip]")
        .replace(/(?:\b[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:?)+/gi, "[ip]"),
  },
  {
    name: "host-names",
    apply: (text) =>
      text.replace(
        new RegExp(
          `\\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${HOST_TLD_PATTERN})\\b`,
          "gi",
        ),
        "[host]",
      ),
  },
];

/** Run every step (or the given list) over the text, in order. */
export function redactSupportText(
  text: string,
  context: SupportRedactionContext,
  steps: readonly SupportRedactionStep[] = SUPPORT_REDACTION_STEPS,
): string {
  return steps.reduce((acc, step) => step.apply(acc, context), text);
}

/**
 * One line of free text, made safe to stand in the report: control
 * characters out, whitespace folded, cut to `max`. The content itself is
 * left to the redaction steps, which see the whole report.
 */
export function supportLine(value: unknown, max = 80): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const folded = String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return folded.length > max ? `${folded.slice(0, max - 1)}…` : folded;
}
