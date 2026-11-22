import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { classifySettingsDestination } from "@/lib/record-settings";
import { delegatedDomains } from "@/lib/sharing/domain-write-support";

const pathnameRef = { value: "/settings/security" };
const activeRecordRef = { value: true };
/** The record on screen. `managed` unless a case says otherwise. */
const recordRef: { value: { kind: "managed" | "shared"; level: string } } = {
  value: { kind: "managed", level: "manage" },
};

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameRef.value,
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: activeRecordRef.value
      ? {
          id: "guardian",
          modules: undefined,
          accountAccess: {
            active: {
              accountId: "managed-record",
              username: "managed-record",
              displayName: "Managed record",
              access: "write",
              level: recordRef.value.level,
              recordKind: recordRef.value.kind,
              sections: null,
              canWrite: true,
              // Bound as the server publishes it for a whole-record grant.
              manageableDomains: delegatedDomains(
                recordRef.value.level as "read" | "write" | "manage",
                null,
                "manage",
                recordRef.value.kind,
              ),
            },
            accounts: [],
            canSwitch: true,
          },
        }
      : null,
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-account-switch", () => ({
  useAccountSwitch: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

import {
  SETTINGS_SECTIONS,
  SettingsShell,
} from "@/components/settings/settings-shell";
import { SharedRecordBanner } from "@/components/layout/shared-record-banner";

function renderSettings(pathname = "/settings/security") {
  pathnameRef.value = pathname;
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <SettingsShell>
        <div>managed settings content</div>
      </SettingsShell>
    </I18nProvider>,
  );
}

/**
 * The destinations a record offers, by what kind of record it is.
 *
 * v1.37.0 — a managed profile offers guardian configuration AND the record
 * content a MANAGE holder may write, because a Guardian holds MANAGE. The
 * `manage-writable` kind is what carries the second half; before it existed
 * the anamnesis form had no page a Guardian could open, while the routes
 * behind it had admitted the write since the level shipped.
 */
const MANAGED_KINDS = new Set([
  "managed-guardian",
  "manage-writable",
  // A page of parts, each following its routes' guard: Health record holds
  // the report, its schedule and the care calendar, all three a guardian's.
  "record-surface",
]);

describe("managed record navigation", () => {
  it("shows only managed settings destinations while retaining an unavailable deep-link heading", () => {
    recordRef.value = { kind: "managed", level: "manage" };
    const html = renderSettings();
    const managedDestinations = SETTINGS_SECTIONS.filter((section) =>
      MANAGED_KINDS.has(classifySettingsDestination(section.slug).kind),
    );
    const unavailableDestinations = SETTINGS_SECTIONS.filter(
      (section) =>
        !MANAGED_KINDS.has(classifySettingsDestination(section.slug).kind),
    );

    // The partition is non-empty on both sides. A classification change that
    // emptied either would make one of the loops below prove nothing.
    expect(managedDestinations.length).toBeGreaterThan(1);
    expect(unavailableDestinations.length).toBeGreaterThan(1);
    // And the destinations opened for a guardian are really on the offered
    // side.
    expect(managedDestinations.map((s) => s.slug)).toContain("anamnesis");
    expect(managedDestinations.map((s) => s.slug)).toContain("health-record");

    expect(html).toContain('data-active-record-id="managed-record"');
    expect(html).toContain('id="settings-section-security-title"');
    expect(html).not.toMatch(/href="[^"]*managed-record/);

    for (const section of managedDestinations) {
      expect(
        html.match(new RegExp(`href="/settings/${section.slug}"`, "g"))
          ?.length ?? 0,
        // The sidebar carries the link; the phone's section sheet mounts its
        // list only when opened (v1.44).
      ).toBe(1);
    }

    for (const section of unavailableDestinations) {
      expect(html).not.toContain(`href="/settings/${section.slug}"`);
    }
  });

  it("offers an adult manager the record content and none of the configuration", () => {
    // The other half of the same classification, and the half that is easiest
    // to get wrong in the generous direction: a delegate manages somebody's
    // health record, not their account. Anamnese is offered; modules,
    // thresholds and notification routing are not, even though a Guardian
    // reaches all three.
    recordRef.value = { kind: "shared", level: "manage" };
    const html = renderSettings();

    expect(html).toContain('href="/settings/anamnesis"');
    for (const guardianOnly of [
      "account",
      "modules",
      "notifications",
      "thresholds",
      "coach",
    ]) {
      expect(html, guardianOnly).not.toContain(
        `href="/settings/${guardianOnly}"`,
      );
    }
  });

  it("offers a WRITE delegate no settings destination at all", () => {
    // The refusal side. `manage-writable` is admitted by LEVEL, not by being
    // in a shared record: a WRITE grant reaches no Settings page, and a
    // destination it could see would be one the route below refuses.
    recordRef.value = { kind: "shared", level: "write" };
    const html = renderSettings();

    expect(html).not.toContain('href="/settings/anamnesis"');
    for (const section of SETTINGS_SECTIONS) {
      expect(html, section.slug).not.toContain(
        `href="/settings/${section.slug}"`,
      );
    }
  });

  it("offers a managed entry below MANAGE nothing at all", () => {
    // A guardian grant is always MANAGE today, which is exactly why the level
    // check was easy to leave out of the managed branch. Without it a managed
    // entry that ever arrived below MANAGE would list destinations the section
    // gate refuses, sending somebody to a page that explains it cannot open.
    recordRef.value = { kind: "managed", level: "read" };
    const html = renderSettings();

    for (const section of SETTINGS_SECTIONS) {
      expect(html, section.slug).not.toContain(
        `href="/settings/${section.slug}"`,
      );
    }
  });

  it("keeps the exit control present while administering a managed record", () => {
    recordRef.value = { kind: "managed", level: "manage" };
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <SharedRecordBanner />
      </I18nProvider>,
    );

    expect(html).toContain('data-account-id="managed-record"');
    expect(html).toContain('data-slot="shared-record-banner-exit"');
  });
});
