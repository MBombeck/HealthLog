/**
 * @fileoverview ESLint rule — a switch with a name is a `SwitchRow`
 * (`src/components/ui/switch-row.tsx`).
 *
 * Five shapes put a name beside a switch: the switch under the title, the
 * switch in a row of its own below the text on a phone, a name with a colon
 * and a 14 px description, a `<label>` wrapped around a span and the switch,
 * a bare `Label` beside it. `SwitchRow` owns the place of the switch, the
 * name without a colon and the size of the description, and this rule keeps
 * a sixth shape from being written next to it.
 *
 * FLAGGED, under `src/components/` and `src/app/` outside
 * `src/components/ui/` and test files: a `<Switch>` element.
 *
 * NOT FLAGGED: a `<Switch>` inside a `status={…}` prop. That is the card
 * header's slot, the one other place a switch stands, for a switch that
 * turns the whole card on or off.
 *
 * The switches that are not rows (a cell of a matrix, a list row that also
 * holds reorder buttons) and the rows not yet moved over are counted per
 * file in the `allow` option. A file with more switches than its number
 * fails, and so does a file with fewer, until the number is lowered or the
 * entry removed: the map only shrinks.
 *
 * WHAT THIS RULE DOES NOT CATCH
 *
 * A switch imported under another name, and a hand-built toggle that is not
 * the `Switch` primitive at all.
 */

"use strict";

const ENFORCED_ROOTS = ["src/components/", "src/app/"];
const EXEMPT_ROOTS = ["src/components/ui/"];

function toPosix(filename) {
  return filename.replace(/\\/g, "/");
}

function isTestFile(posix) {
  return (
    /\.test\.[cm]?[jt]sx?$/.test(posix) ||
    /\.spec\.[cm]?[jt]sx?$/.test(posix) ||
    posix.includes("/__tests__/") ||
    posix.includes("/__mocks__/")
  );
}

/** @type {import("eslint").Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "A switch with a name is a SwitchRow; a bare Switch stands only in a card header's status slot.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allow: {
            type: "object",
            additionalProperties: { type: "integer", minimum: 1 },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      bareSwitch:
        "A bare <Switch>. A switch with a name is a <SwitchRow> (label, description, the switch on the right at every width); a switch for a whole card goes in the card header's `status` slot (UI standards §6).",
      staleAllow:
        "This file has {{found}} bare <Switch> element(s) and an allowance of {{allowed}}. Lower the number in the rule's `allow` map in eslint.config.mjs, or remove the entry.",
    },
  },
  create(context) {
    const filename = toPosix(context.filename ?? context.getFilename?.() ?? "");
    if (!ENFORCED_ROOTS.some((root) => filename.includes(root))) return {};
    if (EXEMPT_ROOTS.some((root) => filename.includes(root))) return {};
    if (isTestFile(filename)) return {};

    const allow = (context.options[0] && context.options[0].allow) || {};
    const entry = Object.keys(allow).find((suffix) =>
      filename.endsWith(suffix),
    );
    const allowed = entry ? allow[entry] : 0;

    let statusDepth = 0;
    const bare = [];

    return {
      JSXAttribute(node) {
        if (node.name.name === "status") statusDepth++;
      },
      "JSXAttribute:exit"(node) {
        if (node.name.name === "status") statusDepth--;
      },
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "Switch") {
          return;
        }
        if (statusDepth > 0) return;
        bare.push(node);
      },
      "Program:exit"(program) {
        if (bare.length > allowed) {
          for (const node of bare.slice(allowed)) {
            context.report({ node, messageId: "bareSwitch" });
          }
        } else if (bare.length < allowed) {
          context.report({
            node: program,
            messageId: "staleAllow",
            data: { found: String(bare.length), allowed: String(allowed) },
          });
        }
      },
    };
  },
};
