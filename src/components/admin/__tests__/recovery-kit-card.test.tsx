/**
 * The recovery kit card and its dashboard banner.
 *
 *   1. the card lists every key with its id and fingerprint and never
 *      anything shaped like key material; the platform hint picks the open
 *      tab; the restore guide is linked;
 *   2. a retired key a backup still needs is listed with why, and a key this
 *      server does not hold says so;
 *   3. a due kit offers the confirmation and names what the confirmation
 *      does not cover, a confirmed one does not;
 *   4. the banner renders only for an admin and only while the kit is due;
 *   5. the copy resolves in German too.
 *
 * Mutation check: drop the `isAdmin` guard in the banner and case 4 goes red;
 * render the confirm button unconditionally and case 3 goes red.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  DISASTER_RECOVERY_GUIDE_URL,
  RecoveryKitCard,
} from "@/components/admin/recovery-kit-card";
import { RecoveryKitBanner } from "@/components/dashboard/recovery-kit-banner";
import type { KitKey, RecoveryKit } from "@/components/admin/use-recovery-kit";
import { primeLocales } from "@/__tests__/helpers/prime-locales";

primeLocales("de");

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/encryption",
}));

const need = (over: Partial<KitKey["need"]> = {}): KitKey["need"] => ({
  active: false,
  configured: true,
  storedCopies: 0,
  offhostUntil: null,
  localDumps: 0,
  offhostDumpsUntil: null,
  ...over,
});

const KEYS: KitKey[] = [
  {
    kind: "application",
    id: "v1",
    fingerprint: null,
    source: "ENCRYPTION_KEYS",
    need: need({ configured: false, storedCopies: 2 }),
    confirmed: false,
    problem: "not_configured",
  },
  {
    kind: "application",
    id: "v2",
    fingerprint: "a1b2c3d4e5f6",
    source: "ENCRYPTION_KEYS",
    need: need({ active: true }),
    confirmed: false,
    problem: null,
  },
  {
    kind: "backup",
    id: "0f0e0d0c0b0a",
    fingerprint: "0f0e0d0c0b0a",
    source: "BACKUP_ENCRYPTION_KEY",
    need: need({ active: true }),
    confirmed: true,
    problem: null,
  },
  {
    kind: "token",
    id: "API_TOKEN_HMAC_KEY",
    fingerprint: "112233445566",
    source: "API_TOKEN_HMAC_KEY",
    need: need({ active: true }),
    confirmed: true,
    problem: null,
  },
];

const DUE: RecoveryKit = {
  keys: KEYS,
  due: true,
  unconfirmed: [
    { kind: "application", id: "v1" },
    { kind: "application", id: "v2" },
  ],
  confirmedAt: "2026-10-03T10:00:00.000Z",
  confirmedBy: null,
  platformHint: "truenas",
};

const DONE: RecoveryKit = {
  ...DUE,
  keys: KEYS.map((k) => ({ ...k, confirmed: true })),
  due: false,
  unconfirmed: [],
  confirmedBy: { id: "u1", email: "admin@example.test" },
};

function render(
  node: React.ReactNode,
  kit: RecoveryKit | null,
  locale: "en" | "de" = "en",
): string {
  const client = new QueryClient();
  if (kit) client.setQueryData(queryKeys.adminRecoveryKit(), kit);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale={locale}>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("RecoveryKitCard", () => {
  it("lists every key by id and fingerprint, opens the hinted platform, links the guide, and shows no key material", () => {
    const html = render(<RecoveryKitCard />, DUE);
    for (const k of KEYS) {
      expect(html).toContain(
        `data-testid="recovery-kit-key-${k.kind}-${k.id}"`,
      );
    }
    expect(html).toContain("a1b2c3d4e5f6");
    expect(html).toContain("112233445566");
    expect(html).toContain("Apps, select HealthLog");
    expect(html).toContain(DISASTER_RECOVERY_GUIDE_URL);
    expect(html).not.toMatch(/[0-9a-f]{64}/);
  });

  it("says why a retired key is listed and that this server does not hold it", () => {
    const html = render(<RecoveryKitCard />, DUE);
    expect(html).toContain("Needed by 2 stored copies.");
    expect(html).toContain("Not on this server");
    expect(html).toContain("Application key v1");
  });

  it("offers the confirmation only while the kit is due, naming what is not covered", () => {
    const due = render(<RecoveryKitCard />, DUE);
    expect(due).toContain("I have a copy of every key");
    expect(due).toContain("v1, v2");
    const done = render(<RecoveryKitCard />, DONE);
    expect(done).not.toContain("I have a copy of every key");
    expect(done).toContain("admin@example.test");
  });

  it("speaks German", () => {
    expect(render(<RecoveryKitCard />, DUE, "de")).toContain(
      "Wiederherstellungs-Kit",
    );
  });
});

describe("RecoveryKitBanner", () => {
  it("renders for an admin while the kit is due", () => {
    expect(render(<RecoveryKitBanner isAdmin />, DUE)).toContain(
      'data-testid="recovery-kit-banner"',
    );
  });

  it("renders nothing for a non-admin, or once the kit is confirmed", () => {
    expect(render(<RecoveryKitBanner isAdmin={false} />, DUE)).toBe("");
    expect(render(<RecoveryKitBanner isAdmin />, DONE)).toBe("");
  });
});
