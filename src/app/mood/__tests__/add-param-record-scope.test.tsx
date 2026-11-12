import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

/**
 * `/mood?add=1` is the mood reminder's tap target. It opens the entry sheet
 * only in the caller's own record: a session that is inside a managed
 * profile or a shared record opens the page without the sheet, so a reminder
 * meant for the recipient never becomes a write form on somebody else.
 */

const caps = {
  current: {
    inSharedRecord: false,
    recordSessionPending: undefined as boolean | undefined,
    accessRefused: undefined as boolean | undefined,
    canManageDomain: (_d: string) => true,
  },
};
const params = { current: new URLSearchParams("add=1") };

vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => caps.current,
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { modules: {} },
    isAuthenticated: true,
    isLoading: false,
  }),
}));
vi.mock("@/hooks/use-mounted", () => ({ useMounted: () => true }));
vi.mock("@/hooks/use-pull-to-refresh", () => ({
  usePullToRefresh: () => ({}),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  useSearchParams: () => params.current,
}));
vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/ui/responsive-sheet", () => ({
  ResponsiveSheet: ({ open }: { open: boolean; children?: ReactNode }) =>
    open ? <div data-slot="mood-sheet-open" /> : null,
  sheetBodyHasUnsavedInput: () => false,
}));
vi.mock("@/components/mood/mood-form", () => ({ MoodForm: () => null }));
vi.mock("@/components/mood/mood-list", () => ({ MoodList: () => null }));
vi.mock("@/components/ui/pull-to-refresh-indicator", () => ({
  PullToRefreshIndicator: () => null,
}));

import MoodPageClient from "../page-client";

function sheetOpen(): boolean {
  return renderToStaticMarkup(<MoodPageClient />).includes(
    'data-slot="mood-sheet-open"',
  );
}

beforeEach(() => {
  params.current = new URLSearchParams("add=1");
  caps.current = {
    inSharedRecord: false,
    recordSessionPending: undefined,
    accessRefused: undefined,
    canManageDomain: () => true,
  };
});

describe("/mood ?add=1 and the record on screen", () => {
  it("opens the entry sheet in the caller's own record", () => {
    expect(sheetOpen()).toBe(true);
  });

  it("keeps the sheet closed without the param", () => {
    params.current = new URLSearchParams();
    expect(sheetOpen()).toBe(false);
  });

  it("does not open the sheet inside a managed profile the caller manages", () => {
    // A guardian switched into a managed profile holds MANAGE on mind, so
    // the sheet would otherwise open and save onto that profile.
    caps.current = { ...caps.current, inSharedRecord: true };
    expect(sheetOpen()).toBe(false);
  });

  it("does not open the sheet while the record context is pending or refused", () => {
    caps.current = {
      ...caps.current,
      inSharedRecord: true,
      recordSessionPending: true,
      canManageDomain: () => false,
    };
    expect(sheetOpen()).toBe(false);
    caps.current = {
      ...caps.current,
      recordSessionPending: undefined,
      accessRefused: true,
    };
    expect(sheetOpen()).toBe(false);
  });
});
