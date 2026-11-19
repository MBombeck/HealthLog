/**
 * Both symptom icon pickers (the add chip's popover and the edit sheet) share
 * one shape: 44 px targets on a phone, 36 px from `sm`, and a translated
 * accessible name per icon rather than the raw Lucide component name.
 *
 * The popover and the sheet portal, and portals do not render server-side,
 * so both are replaced by pass-through wrappers that render their children
 * inline; what is measured is the picker inside them.
 *
 * Mutation checks (each run, each seen red):
 *   - put `size-7` back on the add chip's icon buttons → "the add chip's
 *     icon targets" goes red;
 *   - put `aria-label={name}` back on either picker → the label assertions
 *     go red ("HeartPulse" is a raw name, "Heartbeat" its English label).
 */
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/responsive-sheet", () => ({
  ResponsiveSheet: ({
    children,
    footer,
  }: {
    children: ReactNode;
    footer?: ReactNode;
  }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));

vi.mock("../use-symptoms", () => {
  const mutation = {
    mutateAsync: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  };
  return {
    useCreateSymptomDefinition: () => mutation,
    useUpdateSymptomDefinition: () => mutation,
    useUpdateSymptomEvent: () => mutation,
  };
});

import { I18nProvider } from "@/lib/i18n/context";
import { SYMPTOM_ICON_ALLOWLIST } from "@/lib/symptoms/shared";
import { AddSymptomChip } from "../add-symptom-chip";
import { EditSymptomDefinitionSheet } from "../symptom-edit-sheets";

function iconButtons(html: string): string[] {
  return html.match(/<button[^>]*role="radio"[^>]*>/g) ?? [];
}

function assertPicker(html: string) {
  const buttons = iconButtons(html);
  expect(buttons).toHaveLength(SYMPTOM_ICON_ALLOWLIST.length);
  for (const button of buttons) {
    expect(button).toContain("size-11");
    expect(button).toContain("sm:size-9");
    expect(button).not.toMatch(/\bsize-7\b/);
  }
  expect(html).toContain('aria-label="Heartbeat"');
  expect(html).toContain('aria-label="Low battery"');
  expect(html).not.toContain('aria-label="HeartPulse"');
  expect(html).not.toContain('aria-label="BatteryLow"');
}

describe("symptom icon pickers", () => {
  it("the add chip's icon targets are 44 px on a phone, with translated names", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <AddSymptomChip onCreated={() => {}} />
      </I18nProvider>,
    );
    assertPicker(html);
  });

  it("the edit sheet's picker matches, with translated names", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <EditSymptomDefinitionSheet
          definition={{
            id: "d1",
            label: "Aura",
            icon: "Zap",
            sortOrder: 0,
            isActive: true,
            code: null,
            recent: {
              count30d: 0,
              maxIntensity30d: null,
              lastOccurredAt: null,
            },
          }}
          onClose={() => {}}
        />
      </I18nProvider>,
    );
    assertPicker(html);
  });

  it("every allowlisted icon has a label in the English bundle", async () => {
    const en = (await import("../../../../messages/en.json")).default as {
      symptoms: { icons: Record<string, string> };
    };
    for (const name of SYMPTOM_ICON_ALLOWLIST) {
      expect(en.symptoms.icons[name], name).toBeTruthy();
    }
  });
});
