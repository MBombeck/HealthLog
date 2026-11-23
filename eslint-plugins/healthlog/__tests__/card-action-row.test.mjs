/**
 * Unit tests for the `healthlog/card-action-row` rule: the buttons of a
 * card's action row take their height, width and place from
 * `SettingsCardActions`. Covers each refused spelling, the content the row
 * does not own (dialogs written inside it, JSX-valued props), and the
 * documented shapes that stay legal.
 */

import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import rule from "../card-action-row.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const FILE = "/repo/src/components/settings/example-card.tsx";
const row = (inner, attrs = "") =>
  `<SettingsCard><SettingsCardActions${attrs}>${inner}</SettingsCardActions></SettingsCard>`;

ruleTester.run("card-action-row", rule, {
  valid: [
    // The reference shape: secondary, then the primary, both `sm`.
    {
      code: row(
        '<Button variant="outline" size="sm">Cancel</Button><Button size="sm">Save</Button>',
      ),
      filename: FILE,
    },
    // A loading spinner swaps in; an icon that names another verb stays.
    {
      code: row(
        '<Button size="sm">{busy ? <Loader2 className="size-3.5 animate-spin" /> : null}Save</Button>',
      ),
      filename: FILE,
    },
    {
      code: row(
        '<Button size="sm"><Download className="size-3.5" />Download</Button>',
      ),
      filename: FILE,
    },
    // A class that does not size or place the button.
    {
      code: row('<Button size="sm" className="shrink-0">Save</Button>'),
      filename: FILE,
    },
    // The row pinned to the bottom of an equal-height card.
    {
      code: row('<Button size="sm">Import</Button>', ' className="mt-auto"'),
      filename: FILE,
    },
    // A row of links out of the card reads on the left.
    {
      code: row(
        '<Button variant="outline" size="sm" asChild><a href="/privacy">Privacy</a></Button>',
        ' align="start"',
      ),
      filename: FILE,
    },
    // ConfirmButton is outline unless it says otherwise.
    {
      code: row('<ConfirmButton size="sm" label="Reset" />', ' align="start"'),
      filename: FILE,
    },
    // A dialog written inside the row renders in a portal: its buttons and
    // fields are not the row's.
    {
      code: row(
        '<AlertDialog><AlertDialogTrigger asChild><Button size="sm">Wipe</Button></AlertDialogTrigger><AlertDialogContent><Button className="w-full">Confirm</Button></AlertDialogContent></AlertDialog>',
      ),
      filename: FILE,
    },
    // So is JSX handed to a prop, the leading control included.
    {
      code: row(
        '<ConfirmButton size="sm" label="Sign out" extra={<Button className="w-full">More</Button>} />',
      ),
      filename: FILE,
    },
    {
      code: '<SettingsCard><SettingsCardActions leading={<button className="min-h-11">Details</button>}><Button size="sm">Sync</Button></SettingsCardActions></SettingsCard>',
      filename: FILE,
    },
    // What may follow the row paints nothing in the card.
    {
      code: '<SettingsCard><SettingsCardActions><Button size="sm">Save</Button></SettingsCardActions><ConfirmDialog open={open} /><input type="file" className="hidden" /></SettingsCard>',
      filename: FILE,
    },
    // A button outside a row is not this rule's business.
    {
      code: '<div><Button className="w-full sm:w-auto">Next</Button></div>',
      filename: FILE,
    },
  ],
  invalid: [
    // The 1.49 cards: full width on a phone.
    {
      code: row(
        '<Button size="sm" className="min-h-11 w-full sm:w-auto">Save</Button>',
      ),
      filename: FILE,
      errors: [{ messageId: "sizing" }],
    },
    // The height the row now sets.
    {
      code: row(
        '<Button size="sm" className="min-h-11 sm:min-h-9">Save</Button>',
      ),
      filename: FILE,
      errors: [{ messageId: "sizing" }],
    },
    {
      code: row(
        '<Button size="sm" className={cn("self-end", busy && "opacity-50")}>Save</Button>',
      ),
      filename: FILE,
      errors: [{ messageId: "sizing" }],
    },
    {
      code: row(
        '<ConfirmButton size="sm" className="w-full" label="Turn off" />',
      ),
      filename: FILE,
      errors: [{ messageId: "sizing" }],
    },
    // The default size stands 8 px taller on a desktop.
    {
      code: row('<Button type="submit">Save</Button>'),
      filename: FILE,
      errors: [{ messageId: "size" }],
    },
    {
      code: row('<Button size="default">Save</Button>'),
      filename: FILE,
      errors: [{ messageId: "size" }],
    },
    {
      code: row('<ConfirmButton label="Sign out everywhere" />'),
      filename: FILE,
      errors: [{ messageId: "size" }],
    },
    // The row's own layout.
    {
      code: row(
        '<Button size="sm">Save</Button>',
        ' className="flex-col items-stretch sm:flex-row"',
      ),
      filename: FILE,
      errors: [{ messageId: "rowClass" }],
    },
    {
      code: row(
        '<Button size="sm">Save</Button>',
        ' className="justify-between"',
      ),
      filename: FILE,
      errors: [{ messageId: "rowClass" }],
    },
    // A primary action on the left.
    {
      code: row('<Button size="sm">Create profile</Button>', ' align="start"'),
      filename: FILE,
      errors: [{ messageId: "startWithPrimary" }],
    },
    {
      code: row(
        '<Button size="sm" variant={connected ? "outline" : "default"}>Connect</Button>',
        ' align="start"',
      ),
      filename: FILE,
      errors: [{ messageId: "startWithPrimary" }],
    },
    // The disk glyph.
    {
      code: row(
        '<Button size="sm">{busy ? <Loader2 /> : <Save className="size-4" />}Save</Button>',
      ),
      filename: FILE,
      errors: [{ messageId: "saveIcon" }],
    },
    // Something after the row, directly or behind a condition.
    {
      code: '<SettingsCard><SettingsCardActions><Button size="sm">Save</Button></SettingsCardActions><p>Saved</p></SettingsCard>',
      filename: FILE,
      errors: [{ messageId: "notLast" }],
    },
    {
      code: '<SettingsCard>{data && (<SettingsCardActions><Button size="sm">Save</Button></SettingsCardActions>)}{status && <p role="status">{status}</p>}</SettingsCard>',
      filename: FILE,
      errors: [{ messageId: "notLast" }],
    },
  ],
});
