import type { Page } from "@playwright/test";

import type { TextBlock } from "./repeated-text";

/**
 * Reads what a reader meets in `<main>`: the text blocks, the headings, the
 * page title, and the explanatory text. Shared by the text-budget spec (the
 * explainer count) and `no-repeated-text.spec.ts`.
 *
 * A block is the outermost visible element in `<main>` that holds text of its
 * own. Left out: data rows (list items, table rows, user content), anything
 * hidden or screen-reader only, open dialogs, skeletons, form controls.
 *
 * An explainer is a visible `[data-slot="hint"]` (the (i) trigger, the rare
 * inline `Hint`) or a free paragraph: a muted `<p>` (or a card description)
 * of four words or more that is not inside a hint or a data row. Free
 * paragraphs are the ones `healthlog/no-free-hint` is retiring; counting them
 * here means a page cannot dodge the budget by writing a sentence by hand.
 */
export interface PageText {
  h1: string | null;
  blocks: TextBlock[];
  headings: TextBlock[];
  hints: number;
  freeParagraphs: string[];
}

export async function readPageText(page: Page): Promise<PageText> {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main)
      return {
        h1: null,
        blocks: [],
        headings: [],
        hints: 0,
        freeParagraphs: [],
      };
    const EXEMPT = [
      '[data-slot="list-item"]',
      '[data-slot="list-row"]',
      "tr",
      "[data-user-content]",
      '[data-slot="skeleton"]',
      '[role="dialog"]',
      "select",
      "svg",
      ".sr-only",
    ].join(",");
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return false;
      const cs = getComputedStyle(el);
      return (
        cs.visibility !== "hidden" &&
        cs.display !== "none" &&
        Number(cs.opacity) > 0
      );
    };
    const ownText = (el: Element) =>
      Array.from(el.childNodes).some(
        (n) =>
          n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "",
      );
    const text = (el: Element) =>
      ((el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim();

    const blocks: { text: string; kind: string }[] = [];
    const taken = new Set<Element>();
    for (const el of Array.from(main.querySelectorAll("*"))) {
      if (!ownText(el) || el.closest(EXEMPT) || !visible(el)) continue;
      let p = el.parentElement;
      let nested = false;
      while (p && p !== main) {
        if (taken.has(p)) {
          nested = true;
          break;
        }
        p = p.parentElement;
      }
      if (nested) continue;
      taken.add(el);
      const t = text(el);
      if (t)
        blocks.push({
          text: t,
          kind: el.getAttribute("data-slot") ?? el.tagName.toLowerCase(),
        });
    }

    const h1El = Array.from(
      main.querySelectorAll('h1, [role="heading"][aria-level="1"]'),
    ).find(visible);
    const headings = Array.from(
      main.querySelectorAll(
        'h2, h3, h4, [role="heading"]:not([aria-level="1"]), [data-slot="card-title"], [data-slot="section-heading"], [data-slot="tile-header-title"]',
      ),
    )
      .filter((el) => visible(el) && !el.closest('[role="dialog"]'))
      .map((el) => ({
        text: text(el),
        kind: el.getAttribute("data-slot") ?? el.tagName.toLowerCase(),
      }));

    const hints = Array.from(
      main.querySelectorAll('[data-slot="hint"]'),
    ).filter((el) => visible(el) && !el.closest('[role="dialog"]')).length;

    const probe = document.createElement("span");
    probe.className = "text-muted-foreground";
    main.appendChild(probe);
    const muted = getComputedStyle(probe).color;
    probe.remove();
    const freeParagraphs = Array.from(
      main.querySelectorAll('p, [data-slot="card-description"]'),
    )
      .filter(
        (el) =>
          visible(el) &&
          !el.closest('[data-slot="hint"]') &&
          // A detail page's meta line is record data, not an explanation.
          el.getAttribute("data-slot") !== "page-header-meta" &&
          !el.closest(EXEMPT) &&
          getComputedStyle(el).color === muted &&
          text(el).split(" ").length >= 4,
      )
      .map(text);

    return {
      h1: h1El ? text(h1El) : null,
      blocks,
      headings,
      hints,
      freeParagraphs,
    };
  });
}
