/**
 * The bare-destructive read-failure family: several settings cards rendered a
 * failed read as a bare `text-destructive` line with no way to recover. Each is
 * forced into its query error state and must now render the shared
 * `query-error-row` primitive with a retry control — an alert is foreground
 * content, and a read failure has to be retryable.
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
  useMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    reset: vi.fn(),
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
}));

// The reminders card reads the Coach capability off `/api/auth/me`; the
// react-query mock above carries no context for the real hook to read.
vi.mock("@/hooks/use-ai-capability", () => ({
  useAiCapability: () => ({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  }),
  // #1267 — the about-me save's abort, from the response-timeout setting.
  useAboutMeSaveTimeoutMs: () => 90_000,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings",
  useSearchParams: () => new URLSearchParams(),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { SecuritySessionsCard } from "../security-sessions-card";
import { SecurityActivityCard } from "../security-activity-card";
import { TrustedDevicesCard } from "../trusted-devices-card";
import { CoachMemorySection } from "../coach-memory-section";
import { CoachRemindersSection } from "../coach-reminders-section";
import { AboutMeNoteManager } from "@/components/records/about-me-note-manager";
import { AllergyFreeTextNote } from "@/components/records/allergy-free-text-note";
import { HealthConnectRemoteCard } from "../import-panel/health-connect-remote-card";
import { RecordFileImportCard } from "../import-panel/record-file-import-card";
import { FitImportCard } from "../import-panel/fit-import-card";
import { HealthConnectImportCard } from "../import-panel/health-connect-import-card";
import { DoseSnoozeCard } from "../dose-snooze-card";

function renderCard(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

const cases: Array<[string, () => React.ReactNode]> = [
  ["SecuritySessionsCard", () => <SecuritySessionsCard isAuthenticated />],
  ["SecurityActivityCard", () => <SecurityActivityCard isAuthenticated />],
  ["TrustedDevicesCard", () => <TrustedDevicesCard isAuthenticated />],
  ["CoachMemorySection", () => <CoachMemorySection isAuthenticated />],
  ["CoachRemindersSection", () => <CoachRemindersSection isAuthenticated />],
  ["AboutMeNoteManager", () => <AboutMeNoteManager />],
  ["AllergyFreeTextNote", () => <AllergyFreeTextNote />],
  // 1.49.0: the folder import showed an empty card, the file imports a
  // silent status, and the snooze setting its default as if it were stored.
  ["HealthConnectRemoteCard", () => <HealthConnectRemoteCard />],
  [
    "RecordFileImportCard (Gadgetbridge)",
    () => <RecordFileImportCard kind="gadgetbridge" />,
  ],
  ["FitImportCard", () => <FitImportCard />],
  ["HealthConnectImportCard", () => <HealthConnectImportCard />],
  ["DoseSnoozeCard", () => <DoseSnoozeCard isAuthenticated />],
];

describe("settings read-error family — a read failure is foreground and recoverable", () => {
  it.each(cases)("%s renders a query-error row with retry", (_name, node) => {
    const html = renderCard(node());
    expect(html).toContain('data-slot="query-error-row"');
    expect(html).toContain('data-slot="query-error-row-retry"');
    // No bare red line: the alert is the primitive now.
    expect(html).not.toContain('<p role="alert" class="text-destructive');
  });
});
