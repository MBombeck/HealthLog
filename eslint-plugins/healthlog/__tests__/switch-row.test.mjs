/**
 * Unit tests for the `healthlog/switch-row` rule: a switch with a name is a
 * `SwitchRow`. Covers the bare switch, the header status slot that stays
 * legal, the per-file allowance in both directions, and the scope gating.
 */

import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import rule from "../switch-row.js";

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
const MATRIX = "src/components/settings/matrix.tsx";

ruleTester.run("switch-row", rule, {
  valid: [
    {
      code: '<SwitchRow label="Predictions" checked={on} onCheckedChange={set} />',
      filename: FILE,
    },
    // The card header's slot: a switch for the whole card.
    {
      code: "<SettingsCardHeader title={title} status={<Switch checked={on} />} />",
      filename: FILE,
    },
    {
      code: "<SettingsCardHeader status={<label><Switch checked={on} /><span>{word}</span></label>} />",
      filename: FILE,
    },
    // A counted exception, exactly as many as counted.
    {
      code: "<tr><td><Switch checked={a} /></td><td><Switch checked={b} /></td></tr>",
      filename: `/repo/${MATRIX}`,
      options: [{ allow: { [MATRIX]: 2 } }],
    },
    // The primitive itself, tests, and code outside the UI roots.
    {
      code: "<Switch checked={on} />",
      filename: "/repo/src/components/ui/switch-row.tsx",
    },
    {
      code: "<Switch checked={on} />",
      filename: "/repo/src/components/settings/__tests__/x.test.tsx",
    },
    { code: "<Switch checked={on} />", filename: "/repo/src/lib/x.tsx" },
  ],
  invalid: [
    // The five shapes all come down to this.
    {
      code: '<div className="flex items-center justify-between"><Label htmlFor="x">Predictions</Label><Switch id="x" checked={on} /></div>',
      filename: FILE,
      errors: [{ messageId: "bareSwitch" }],
    },
    {
      code: '<label className="flex justify-between"><span>Track intake</span><Switch checked={on} /></label>',
      filename: FILE,
      errors: [{ messageId: "bareSwitch" }],
    },
    // One more than the file's allowance: the extra one is reported.
    {
      code: "<div><Switch checked={a} /><Switch checked={b} /><Switch checked={c} /></div>",
      filename: `/repo/${MATRIX}`,
      options: [{ allow: { [MATRIX]: 2 } }],
      errors: [{ messageId: "bareSwitch" }],
    },
    // One fewer: the allowance has to come down with it.
    {
      code: "<div><Switch checked={a} /></div>",
      filename: `/repo/${MATRIX}`,
      options: [{ allow: { [MATRIX]: 2 } }],
      errors: [{ messageId: "staleAllow" }],
    },
    {
      code: '<SwitchRow label="x" checked={a} />',
      filename: `/repo/${MATRIX}`,
      options: [{ allow: { [MATRIX]: 1 } }],
      errors: [{ messageId: "staleAllow" }],
    },
  ],
});
