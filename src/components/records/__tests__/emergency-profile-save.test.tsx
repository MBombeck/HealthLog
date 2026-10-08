import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The emergency card's Save stayed enabled on an untouched, stored profile
// while every other Save on the medical-history page waits for a change.
// It now follows them: nothing edited, nothing to save.

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      bloodType: "A_POS",
      organDonor: null,
      advanceDirective: null,
      contacts: "A contact",
      implants: null,
      note: null,
      updatedAt: "2026-07-28T10:00:00.000Z",
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    setQueryData: vi.fn(),
  }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/api/api-fetch", () => ({ apiGet: vi.fn(), apiPatch: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { I18nProvider } from "@/lib/i18n/context";
import { EmergencyProfileManager } from "../emergency-profile-manager";

describe("<EmergencyProfileManager> Save", () => {
  it("stays disabled until a field differs from the stored profile", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <EmergencyProfileManager />
      </I18nProvider>,
    );
    const row = html.slice(html.indexOf('data-slot="settings-card-actions"'));
    expect(row).toMatch(/<button[^>]*disabled=""[^>]*>[^]*?Save<\/button>/);
  });
});
