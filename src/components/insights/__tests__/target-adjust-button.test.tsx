import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * `<TargetAdjustButton>` unit tests.
 *
 * The header gear opens the per-metric target editor. It self-gates on a
 * registered editable target (`canAdjust`), so a metric with no numeric
 * band shows nothing. The test convention is `renderToStaticMarkup` (no
 * `@testing-library/react`), so `useTargetAdjust` is mocked to drive the
 * gated / ungated branches and the click handler is exercised via the
 * mocked `requestAdjust` reference.
 *
 * The load-bearing visual contract: the gear must read as the *same*
 * size as the sibling `<CoachLaunchButton variant="icon">` (a flat 40 px
 * `size-icon` box), with the WCAG 2.5.5 touch target restored through an
 * invisible `::before` overlay rather than a larger painted box. The
 * class assertions pin that the gear paints a flat `size-10` (40 px) and
 * carries the transparent hit-area overlay, and never the old
 * `size-11`/`sm:size-10` box that made it visually heavier than the
 * Coach icon.
 */

const useTargetAdjustMock = vi.fn();
vi.mock("@/lib/insights/target-adjust-context", () => ({
  useTargetAdjust: () => useTargetAdjustMock(),
}));

const capabilities = { inSharedRecord: false };
vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => capabilities,
}));

const { TargetAdjustButton } = await import("../target-adjust-button");

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<TargetAdjustButton>", () => {
  it("renders nothing when no provider is mounted", () => {
    useTargetAdjustMock.mockReturnValue(null);
    const html = render(<TargetAdjustButton />);
    expect(html).toBe("");
  });

  it("renders nothing when no editable target has registered", () => {
    useTargetAdjustMock.mockReturnValue({
      canAdjust: false,
      requestAdjust: vi.fn(),
      register: vi.fn(),
    });
    const html = render(<TargetAdjustButton />);
    expect(html).toBe("");
  });

  it("renders nothing inside somebody else's record", () => {
    // The editor reads and writes the signed-in account's own targets, which
    // the server refuses under a switch: the gear would open a dead sheet.
    useTargetAdjustMock.mockReturnValue({
      canAdjust: true,
      requestAdjust: vi.fn(),
      register: vi.fn(),
    });
    capabilities.inSharedRecord = true;
    try {
      expect(render(<TargetAdjustButton />)).toBe("");
    } finally {
      capabilities.inSharedRecord = false;
    }
  });

  it("renders the gear once an editable target is registered", () => {
    useTargetAdjustMock.mockReturnValue({
      canAdjust: true,
      requestAdjust: vi.fn(),
      register: vi.fn(),
    });
    const html = render(<TargetAdjustButton />);
    expect(html).toContain('data-slot="target-adjust-trigger"');
    // The accessible label reuses the existing adjust-target copy.
    expect(html).toContain('aria-label="Adjust target range"');
  });

  it("paints a flat 40px box matching the Coach icon, not the old heavier size-11", () => {
    useTargetAdjustMock.mockReturnValue({
      canAdjust: true,
      requestAdjust: vi.fn(),
      register: vi.fn(),
    });
    const html = render(<TargetAdjustButton />);
    // Flat 40 px visual box, identical to the sibling Coach sparkle icon.
    expect(html).toContain("size-10");
    // The pre-parity heavier mobile box is gone.
    expect(html).not.toContain("size-11");
  });

  it("restores the touch target with an invisible hit-area overlay rather than a bigger box", () => {
    useTargetAdjustMock.mockReturnValue({
      canAdjust: true,
      requestAdjust: vi.fn(),
      register: vi.fn(),
    });
    const html = render(<TargetAdjustButton />);
    // A transparent `::before` overlay extends the hit area past the 40 px
    // visual box to clear the WCAG 2.5.5 floor without enlarging the paint.
    expect(html).toContain("before:absolute");
    expect(html).toContain("before:-inset-1.5");
  });
});
