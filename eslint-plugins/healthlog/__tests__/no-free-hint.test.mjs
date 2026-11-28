/**
 * Unit tests for the `healthlog/no-free-hint` rule: a muted paragraph with
 * translated text inside a card is a free hint. Covers the card names, the
 * class-string shapes, the hint elements that stay legal, the per-file
 * allowance in both directions, and the scope gating.
 */

import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import rule from "../no-free-hint.js";

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

const FILE = "/repo/src/components/settings/example-section.tsx";
const COUNTED = "src/components/settings/counted.tsx";

ruleTester.run("no-free-hint", rule, {
  valid: [
    // Outside a card.
    {
      code: '<div><p className="text-muted-foreground text-sm">{t("a.hint")}</p></div>',
      filename: FILE,
    },
    // Inside a card, but data rather than a translated sentence.
    {
      code: '<Card><p className="text-muted-foreground text-xs">{formatDate(at)}</p></Card>',
      filename: FILE,
    },
    // Translated, inside a card, but foreground content.
    {
      code: '<CardContent><p className="text-sm">{t("a.body")}</p></CardContent>',
      filename: FILE,
    },
    // A div is not flagged.
    {
      code: '<Card><div className="text-muted-foreground">{t("a.hint")}</div></Card>',
      filename: FILE,
    },
    // The hint element itself.
    {
      code: '<SettingsCard><InfoPopover content={<p className="text-muted-foreground">{t("a.hint")}</p>} /></SettingsCard>',
      filename: FILE,
    },
    {
      code: '<Card><FieldInfo><span className="text-muted-foreground">{t("a.hint")}</span></FieldInfo></Card>',
      filename: FILE,
    },
    // A prop slot of a header inside the card.
    {
      code: '<Card><SettingsCardHeader title={x} status={<span className="text-muted-foreground text-xs">{t("a.window")}</span>} /></Card>',
      filename: FILE,
    },
    // A counted file, exactly as many as counted.
    {
      code: '<Card><p className="text-muted-foreground">{t("a")}</p></Card>',
      filename: `/repo/${COUNTED}`,
      options: [{ allow: { [COUNTED]: 1 } }],
    },
    // The primitives, tests, and code outside the UI roots.
    {
      code: '<Card><p className="text-muted-foreground">{t("a")}</p></Card>',
      filename: "/repo/src/components/ui/card.tsx",
    },
    {
      code: '<Card><p className="text-muted-foreground">{t("a")}</p></Card>',
      filename: "/repo/src/components/settings/__tests__/x.test.tsx",
    },
    {
      code: '<Card><p className="text-muted-foreground">{t("a")}</p></Card>',
      filename: "/repo/src/lib/x.tsx",
    },
  ],
  invalid: [
    {
      code: '<Card><CardContent><p className="text-muted-foreground text-sm">{t("a.hint")}</p></CardContent></Card>',
      filename: FILE,
      errors: [{ messageId: "freeHint" }],
    },
    // cn(...) and a template literal; a name ending in Card.
    {
      code: '<TrendCard><span className={cn("text-xs", "text-muted-foreground")}>{t("a")}</span></TrendCard>',
      filename: FILE,
      errors: [{ messageId: "freeHint" }],
    },
    {
      code: '<ListGroup>{items.map((i) => <p key={i} className={`text-muted-foreground ${x}`}>{t("a")}</p>)}</ListGroup>',
      filename: "/repo/src/app/x/page.tsx",
      errors: [{ messageId: "freeHint" }],
    },
    {
      code: '<Ui.InsightSectionCard><p className="text-muted-foreground">Before {t("a")}</p></Ui.InsightSectionCard>',
      filename: FILE,
      errors: [{ messageId: "freeHint" }],
    },
    // One more than the allowance.
    {
      code: '<Card><p className="text-muted-foreground">{t("a")}</p><p className="text-muted-foreground">{t("b")}</p></Card>',
      filename: `/repo/${COUNTED}`,
      options: [{ allow: { [COUNTED]: 1 } }],
      errors: [{ messageId: "freeHint" }],
    },
    // One fewer: the allowance has to come down with it.
    {
      code: '<Card><p className="text-sm">{t("a")}</p></Card>',
      filename: `/repo/${COUNTED}`,
      options: [{ allow: { [COUNTED]: 1 } }],
      errors: [{ messageId: "staleAllow" }],
    },
  ],
});
