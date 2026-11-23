/**
 * @fileoverview ESLint rule — the action row of a card has one shape, and
 * `SettingsCardActions` owns it (UI standards §12).
 *
 * The row was a primitive, its buttons were not: 177 buttons in 121 rows
 * carried eight different class lists for the same job. Five new cards hung
 * `w-full sm:w-auto` on theirs and so stretched across the phone while the
 * other ninety-eight sat compact on the right; two dozen dropped
 * `size="sm"` and stood 8 px taller on a desktop; three put the primary
 * action on the left. The primitive now sets height and width on every
 * button inside it, so a caller has nothing left to spell, and this rule
 * refuses the spellings that used to diverge.
 *
 * Inside `<SettingsCardActions>` (dialog and popover content written inside
 * the row is skipped, it renders in a portal):
 *
 *   - `size`: a `Button` or `ConfirmButton` says `size="sm"`.
 *   - `sizing`: a button or link carries no width, height, self-alignment or
 *     auto-margin class. The row decides those.
 *   - `rowClass`: the row takes no `className` but `mt-auto` (a card in an
 *     equal-height grid pins its row to the bottom). A control that stands
 *     apart on the left goes in `leading`.
 *   - `startWithPrimary`: `align="start"` is for a row of links out of the
 *     card. A row with a primary or destructive action is right-aligned.
 *   - `saveIcon`: a save button carries its word and no disk glyph. The
 *     loading spinner still swaps in.
 *   - `notLast`: the row is the last thing in its parent. A status line or a
 *     result list goes above it.
 *
 * WHAT THIS RULE DOES NOT CATCH
 *
 * A wrapper component that renders a `Button` of another size in its own
 * file (the row's CSS still sets its height and width), a class list built
 * at runtime, a second primary action, and a row of buttons that never used
 * `SettingsCardActions` at all.
 */

"use strict";

const ROW = "SettingsCardActions";

/** Content that renders in a portal, wherever it is written. */
const PORTAL_RE =
  /^(?:AlertDialogContent|DialogContent|PopoverContent|DropdownMenuContent|SheetContent|ConfirmDialog|ResponsiveSheet)$/;
/** Siblings that may follow the row: they paint nothing in the card. */
const OVERLAY_RE = /(?:Dialog|Sheet|Popover|Drawer|DialogContent)$/;

const SIZED_TAG_RE = /(?:^button$|^a$|^Link$|Button$)/;
const SIZING_RE =
  /(?:^|\s)(?:[a-z0-9-]+:)*(?:w-|min-w-|max-w-|h-|min-h-|max-h-|size-|self-|basis-|grow(?:\s|$)|flex-1(?:\s|$)|m[lrx]-auto(?:\s|$))/;

function tagName(opening) {
  const name = opening.name;
  if (name.type === "JSXIdentifier") return name.name;
  if (name.type === "JSXMemberExpression") return name.property.name;
  return "";
}

function attribute(opening, name) {
  return opening.attributes.find(
    (attr) => attr.type === "JSXAttribute" && attr.name.name === name,
  );
}

/** Every string a class expression can resolve to, or null when unknown. */
function classStrings(node) {
  if (!node) return [];
  if (node.type === "Literal") {
    return typeof node.value === "string" ? [node.value] : [];
  }
  if (node.type === "JSXExpressionContainer") {
    return classStrings(node.expression);
  }
  if (node.type === "TemplateLiteral") {
    return node.quasis.map((quasi) => quasi.value.cooked ?? "");
  }
  if (node.type === "CallExpression") {
    return node.arguments.flatMap((arg) => classStrings(arg) ?? []);
  }
  if (node.type === "ConditionalExpression") {
    return [
      ...(classStrings(node.consequent) ?? []),
      ...(classStrings(node.alternate) ?? []),
    ];
  }
  if (node.type === "LogicalExpression") {
    return classStrings(node.right) ?? [];
  }
  return null;
}

/** Whether a `variant` attribute can resolve to a filled action. */
function isFilledVariant(attr, tag) {
  // ConfirmButton is outline unless it says otherwise.
  if (!attr) return tag === "Button";
  const value = attr.value;
  if (!value) return false;
  const strings = classStrings(value);
  if (strings === null) return true;
  return strings.some((s) => s === "default" || s === "destructive");
}

function isHiddenInput(node) {
  if (node.type !== "JSXElement") return false;
  const opening = node.openingElement;
  // `FileInput` (`ui/file-picker.tsx`) is the one file input in the tree; it
  // renders nothing visible unless a drop zone lays it out (#1215).
  if (tagName(opening) === "FileInput") return true;
  if (tagName(opening) !== "input") return false;
  const type = attribute(opening, "type");
  return type?.value?.type === "Literal" && type.value.value === "file";
}

/** Tags of the JSX elements a child slot can render. */
function renderedElements(node, out = []) {
  if (!node) return out;
  if (node.type === "JSXElement") {
    out.push(node);
  } else if (node.type === "JSXFragment") {
    node.children.forEach((child) => renderedElements(child, out));
  } else if (node.type === "JSXExpressionContainer") {
    renderedElements(node.expression, out);
  } else if (node.type === "LogicalExpression") {
    renderedElements(node.right, out);
  } else if (node.type === "ConditionalExpression") {
    renderedElements(node.consequent, out);
    renderedElements(node.alternate, out);
  }
  return out;
}

/** @type {import("eslint").Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "The action row of a card has one shape, owned by SettingsCardActions.",
    },
    schema: [],
    messages: {
      size: 'A button in a card\'s action row is size="sm" (UI standards §12). The row sets its height.',
      sizing:
        "`{{cls}}` on a button in a card's action row. SettingsCardActions owns height and width: every action is compact, at every viewport (UI standards §12).",
      rowClass:
        "SettingsCardActions takes no className but `mt-auto`. Its layout is the primitive's; a control that stands apart on the left goes in `leading`.",
      startWithPrimary:
        'align="start" is for a row of links out of the card. A row with a primary or destructive action is right-aligned (UI standards §12).',
      saveIcon:
        "A save button carries its word and no disk glyph (UI standards §12).",
      notLast:
        "The action row is the last thing in the card. Status lines and results go above it (UI standards §12).",
    },
  },
  create(context) {
    /** Depth of `SettingsCardActions` rows the walk is inside. */
    const rows = [];
    /** Portal content inside a row: its buttons are not the row's. */
    let portalDepth = 0;

    function checkRow(node) {
      const opening = node.openingElement;
      const cls = attribute(opening, "className");
      if (cls) {
        const strings = classStrings(cls.value);
        const only =
          strings !== null && strings.join(" ").trim().split(/\s+/).join(" ");
        if (only !== "mt-auto") {
          context.report({ node: cls, messageId: "rowClass" });
        }
      }

      // The slot the row fills in its parent: the row itself, or the
      // `{cond && <Row />}` expression around it.
      let slot = node;
      let parent = node.parent;
      while (
        parent &&
        (parent.type === "LogicalExpression" ||
          parent.type === "ConditionalExpression" ||
          parent.type === "JSXExpressionContainer")
      ) {
        slot = parent;
        parent = parent.parent;
      }
      if (parent && parent.type === "JSXElement") {
        const after = parent.children
          .slice(parent.children.indexOf(slot) + 1)
          .flatMap((child) =>
            renderedElements(child).filter(
              (el) =>
                !OVERLAY_RE.test(tagName(el.openingElement)) &&
                !isHiddenInput(el),
            ),
          );
        if (after.length > 0) {
          context.report({ node: node.openingElement, messageId: "notLast" });
        }
      }
    }

    return {
      JSXElement(node) {
        const tag = tagName(node.openingElement);
        if (tag === ROW) {
          checkRow(node);
          const align = attribute(node.openingElement, "align");
          rows.push({
            start:
              align?.value?.type === "Literal" && align.value.value === "start",
            node,
          });
          return;
        }
        if (rows.length > 0 && PORTAL_RE.test(tag)) portalDepth++;
      },
      "JSXElement:exit"(node) {
        const tag = tagName(node.openingElement);
        if (tag === ROW) {
          rows.pop();
          return;
        }
        if (rows.length > 0 && PORTAL_RE.test(tag)) portalDepth--;
      },
      // A prop that holds JSX of its own is not one of the row's actions: a
      // confirm dialog's `extra` renders in the dialog, and `leading` is the
      // control that stands apart from them.
      JSXAttribute(node) {
        if (rows.length > 0 && node.value?.type === "JSXExpressionContainer") {
          portalDepth++;
        }
      },
      "JSXAttribute:exit"(node) {
        if (rows.length > 0 && node.value?.type === "JSXExpressionContainer") {
          portalDepth--;
        }
      },
      JSXOpeningElement(node) {
        if (rows.length === 0 || portalDepth > 0) return;
        const tag = tagName(node);
        if (tag === ROW) return;
        const row = rows[rows.length - 1];

        if (tag === "Save") {
          context.report({ node, messageId: "saveIcon" });
          return;
        }

        if (tag === "Button" || tag === "ConfirmButton") {
          const size = attribute(node, "size");
          const isSm =
            size?.value?.type === "Literal" && size.value.value === "sm";
          if (!isSm) context.report({ node: size ?? node, messageId: "size" });
          if (row.start && isFilledVariant(attribute(node, "variant"), tag)) {
            context.report({ node, messageId: "startWithPrimary" });
          }
        }

        if (SIZED_TAG_RE.test(tag)) {
          const cls = attribute(node, "className");
          const strings = cls ? classStrings(cls.value) : [];
          for (const value of strings ?? []) {
            const hit = SIZING_RE.exec(value);
            if (hit) {
              context.report({
                node: cls,
                messageId: "sizing",
                data: { cls: value.trim() },
              });
              break;
            }
          }
        }
      },
    };
  },
};
