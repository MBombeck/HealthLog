/**
 * Unit tests for the `healthlog/type-scale` rule: no arbitrary font sizes
 * and no `uppercase` outside the nav group labels. Covers the class-string
 * contexts, the colours that stay legal, the nav allowance, the per-file
 * allowance in both directions, and the scope gating.
 */

import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import rule from "../type-scale.js";

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

const FILE = "/repo/src/components/labs/example.tsx";
const NAV = "src/components/layout/rail-nav-groups.tsx";
const COUNTED = "src/components/settings/counted.tsx";

ruleTester.run("type-scale", rule, {
  valid: [
    {
      code: '<p className="text-2xs text-xs md:text-sm">x</p>',
      filename: FILE,
    },
    // Arbitrary colours are another rule's business.
    {
      code: '<p className="text-[var(--chart-1)] text-[#fff] normal-case">x</p>',
      filename: FILE,
    },
    // Prose and translation keys are not class strings.
    { code: 'const msg = "Use an uppercase letter";', filename: FILE },
    { code: 't("uppercase")', filename: FILE },
    { code: '<p title="uppercase text-[11px]">x</p>', filename: FILE },
    // The nav group labels.
    {
      code: '<div className={cn("text-xs tracking-wide uppercase")}>x</div>',
      filename: `/repo/${NAV}`,
      options: [{ allowUppercaseIn: [NAV] }],
    },
    // A counted file, exactly as many as counted.
    {
      code: '<p className="uppercase">x</p>',
      filename: `/repo/${COUNTED}`,
      options: [{ allow: { [COUNTED]: 1 } }],
    },
    // Tests and code outside the UI roots.
    {
      code: '<p className="uppercase text-[11px]">x</p>',
      filename: "/repo/src/components/labs/__tests__/x.test.tsx",
    },
    { code: '<p className="uppercase">x</p>', filename: "/repo/src/lib/x.tsx" },
  ],
  invalid: [
    {
      code: '<p className="text-muted-foreground text-xs tracking-wide uppercase">x</p>',
      filename: FILE,
      errors: [{ messageId: "uppercase" }],
    },
    {
      code: '<span className="text-[11px] md:text-[0.8rem] text-[length:12px] text-[10]">x</span>',
      filename: FILE,
      errors: [
        { messageId: "arbitrarySize" },
        { messageId: "arbitrarySize" },
        { messageId: "arbitrarySize" },
        { messageId: "arbitrarySize" },
      ],
    },
    // cn(...), a conditional, a template literal, cva variants.
    {
      code: '<p className={cn("text-xs", on && "sm:uppercase")}>x</p>',
      filename: FILE,
      errors: [{ messageId: "uppercase" }],
    },
    {
      code: '<p className={on ? `text-[11px] ${a}` : "b"}>x</p>',
      filename: "/repo/src/app/x/page.tsx",
      errors: [{ messageId: "arbitrarySize" }],
    },
    {
      code: 'const chip = cva("px-2", { variants: { size: { sm: "text-[10px]" } } });',
      filename: FILE,
      errors: [{ messageId: "arbitrarySize" }],
    },
    // A class constant.
    {
      code: 'export const SECTION_LABEL = "text-xs font-medium uppercase";',
      filename: FILE,
      errors: [{ messageId: "uppercase" }],
    },
    {
      code: 'const headingClass = "uppercase";',
      filename: FILE,
      errors: [{ messageId: "uppercase" }],
    },
    // The nav allowance covers caps only, not sizes.
    {
      code: '<div className="uppercase text-[11px]">x</div>',
      filename: `/repo/${NAV}`,
      options: [{ allowUppercaseIn: [NAV] }],
      errors: [{ messageId: "arbitrarySize" }],
    },
    // One more than the allowance, and one fewer.
    {
      code: '<p className="uppercase text-[11px]">x</p>',
      filename: `/repo/${COUNTED}`,
      options: [{ allow: { [COUNTED]: 1 } }],
      errors: [{ messageId: "arbitrarySize" }],
    },
    {
      code: '<p className="text-xs">x</p>',
      filename: `/repo/${COUNTED}`,
      options: [{ allow: { [COUNTED]: 1 } }],
      errors: [{ messageId: "staleAllow" }],
    },
  ],
});
