/**
 * The admin error-box family rendered a failed read as a hand-rolled
 * destructive-tinted box (§13 drift). Each self-contained admin section is
 * forced into its query error state and must now render the shared
 * `query-error-row` primitive with retry.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: undefined,
    isLoading: false,
    isError: true,
    refetch: vi.fn(),
  }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { RecentAuditPreview } from "../recent-audit-preview";
import { CoachFeedbackSection } from "../coach-feedback-section";
import { AiQualitySection } from "../ai-quality-section";
import { PushRelaySection } from "../push-relay-section";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

const cases: Array<[string, () => React.ReactNode]> = [
  ["RecentAuditPreview", () => <RecentAuditPreview />],
  ["CoachFeedbackSection", () => <CoachFeedbackSection />],
  ["AiQualitySection", () => <AiQualitySection />],
  // Rendered nothing on a failed read, the same as a relay the operator
  // turned off.
  ["PushRelaySection", () => <PushRelaySection />],
];

describe("admin read-error family — a read failure is foreground and recoverable", () => {
  it.each(cases)("%s renders a query-error row with retry", (_name, node) => {
    const html = render(node());
    expect(html).toContain('data-slot="query-error-row"');
    expect(html).toContain('data-slot="query-error-row-retry"');
    expect(html).not.toContain("bg-destructive/10");
  });
});
