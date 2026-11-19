/**
 * v1.21.0 (NEW-C C-3) — Coach Learn-link post-filter.
 *
 * The Coach MAY point the user at a public `/learn/<slug>` guide, but only a
 * slug that appears in `learn-catalog.ts`. The system prompt instructs this
 * ("Only link a URL from this list — never invent a learn-guide URL"), but that is a
 * prompt instruction, not enforcement: a model could still hallucinate
 * `/learn/lower-your-cortisol` and ship a dead/wrong link.
 *
 * This deterministic post-filter runs on the assembled reply before
 * persistence and streaming. It scans for every `/learn/<slug>` reference
 * (relative or the absolute `healthlog.dev/learn/<slug>` form) and NEUTRALISES
 * any whose slug is not a published catalog entry — stripping the fabricated
 * URL out of the prose while leaving the surrounding sentence intact. A real
 * slug is kept verbatim. This converts the catalog's "impossible by
 * construction" claim from a prompt promise into an enforced guarantee.
 *
 * Cheap + read-only: a single regex pass over the reply, the slug set sourced
 * from the read-only `LEARN_GUIDES` catalog. No allocation on the common path
 * (a reply with no `/learn` mention returns the input unchanged).
 */
import { LEARN_GUIDES } from "./learn-catalog";

/** The set of published `/learn` slugs, lower-cased for case-insensitive match. */
const KNOWN_SLUGS: ReadonlySet<string> = new Set(
  LEARN_GUIDES.map((g) => g.slug.toLowerCase()),
);

/**
 * Match a `/learn/<slug>` reference, with or without the host. Captures the
 * slug so the caller can validate it. The slug is the URL-path segment after
 * `/learn/` — letters, digits, and hyphens (the catalog's slug grammar). A
 * trailing slash or punctuation ends the slug.
 *
 * Examples matched:
 *   https://healthlog.dev/learn/resting-heart-rate
 *   healthlog.dev/learn/made-up-slug
 *   /learn/another-fabrication
 */
const LEARN_LINK_RE =
  /(?:https?:\/\/)?(?:[a-z0-9.-]*healthlog\.dev)?\/learn\/([a-z0-9-]+)\/?/gi;

export interface LearnLinkScrubResult {
  /** The reply with every unknown `/learn/<slug>` reference removed. */
  text: string;
  /** The unknown slugs that were neutralised (lower-cased, deduped). */
  dropped: string[];
}

/**
 * Strip every `/learn/<slug>` reference whose slug is not in the published
 * catalog. A known slug is preserved verbatim; an unknown one (a fabrication)
 * is removed along with a common lead-in fragment ("more on this: ", "see "),
 * so the prose does not read as a broken link. Returns the input unchanged when
 * the reply contains no `/learn` reference.
 */
export function scrubUnknownLearnLinks(reply: string): LearnLinkScrubResult {
  if (!reply || !reply.includes("/learn/")) {
    return { text: reply, dropped: [] };
  }

  const dropped = new Set<string>();
  // First pass: collect the unknown slugs (so the result is reportable) and
  // build the cleaned string in one replace.
  const text = reply.replace(LEARN_LINK_RE, (match, slug: string) => {
    if (KNOWN_SLUGS.has(slug.toLowerCase())) {
      // Published guide — keep the link exactly as written.
      return match;
    }
    dropped.add(slug.toLowerCase());
    // Drop the fabricated URL. Leave the surrounding prose; a dangling
    // "more on this:" lead-in is cleaned by the post-pass below.
    return "";
  });

  if (dropped.size === 0) {
    // Every /learn link was valid — return the original (the replace above is a
    // no-op clone, but be explicit about the contract).
    return { text: reply, dropped: [] };
  }

  // Tidy the prose around a removed link: collapse a now-empty "more on this:"
  // / "see:" lead-in and any double spaces / stranded punctuation the removal
  // left behind. Conservative — only the well-known lead-in phrases the prompt
  // example seeds, plus whitespace normalisation.
  const tidied = text
    // Drop a now-empty "more on this:" / "read more:" / "see:" lead-in (EN+DE).
    .replace(
      /\b(?:more on this|read more|see|learn more|mehr dazu|mehr hier)\s*:?\s*(?=[\s).,;!?]|$)/gi,
      "",
    )
    // Collapse a doubled space + tidy a space-before-punctuation the gap left.
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([).,;!?])/g, "$1")
    // Drop an empty parenthesis pair left by a parenthesised link.
    .replace(/\(\s*\)/g, "")
    .trim();

  return { text: tidied, dropped: [...dropped] };
}
