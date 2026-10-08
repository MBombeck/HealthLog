/**
 * Where the change-password card lives.
 *
 * It used to sit at the bottom of Settings → Account, under the profile form.
 * Changing a password is the same kind of decision as enrolling a second
 * factor, so it moved to Settings → Security. Two things have to hold for
 * that move to be real rather than a duplicate:
 *
 *   1. Security mounts it — and mounts it BEFORE the factor status resolves,
 *      because it is now the only way to change a password and must not
 *      depend on a query it does not need.
 *   2. Account does not, and no second copy of the dialog exists anywhere.
 *
 * The second claim is checked against the source tree rather than a render,
 * because a render of `<AccountSection>` proves the card is absent from the
 * one branch the test happened to reach. Sweeping the files proves there is
 * exactly one place in the app that can paint it.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isLoading: true }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: null,
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { PasswordCard } from "../password-card";
import { SecuritySection } from "../security-section";

const SLOT = 'data-slot="settings-password-card"';

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="de">{node}</I18nProvider>,
  );
}

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      walk(full, out);
    } else if (entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

describe("change-password card placement", () => {
  it("paints its slot", () => {
    // Positive control for the two assertions below — without it, a renamed
    // slot would make every "is it here / is it gone" check read green.
    expect(render(<PasswordCard />)).toContain(SLOT);
  });

  it("is mounted by Settings → Security even before the factor status lands", () => {
    // The mocked query never resolves, which is the case that matters: the
    // MFA read is still in flight (or failing) and the password card is
    // reachable regardless — it sits outside the status conditional.
    const html = render(<SecuritySection />);
    expect(html).toContain(SLOT);
  });

  it("orders the password card last, after the passkey list", () => {
    // The section reads authenticator → security keys → passkeys → password.
    // The order lives in one component and the resolved cards only render once
    // the status query settles (the render mock keeps it in flight), so the
    // guard reads the source: the password card must come after the passkey
    // list. Re-reported once as an order regression; this pins it.
    const source = readFileSync(
      join(ROOT, "src/components/settings/security-section/index.tsx"),
      "utf8",
    );
    const passkeyIdx = source.indexOf("<PasskeyListSection");
    const passwordIdx = source.indexOf("<PasswordCard");
    expect(passkeyIdx).toBeGreaterThan(-1);
    expect(passwordIdx).toBeGreaterThan(passkeyIdx);
  });

  it("has exactly one home in the tree", () => {
    const owners = walk(join(ROOT, "src"))
      .filter((file) => readFileSync(file, "utf8").includes("PasswordCard"))
      .map((file) => file.slice(ROOT.length + 1))
      .sort();
    expect(owners).toEqual([
      "src/components/settings/password-card.tsx",
      "src/components/settings/security-section/index.tsx",
    ]);
  });

  it("left no password form behind in the Account section", () => {
    const account = readFileSync(
      join(ROOT, "src/components/settings/account-section/index.tsx"),
      "utf8",
    );
    for (const marker of [
      "settings.passwordTitle",
      "settings.changePassword",
      "/api/auth/password",
      // A change-password form is the pair current + new. The Account form
      // asks for the CURRENT password alone, beside a new email address,
      // which is a proof and not a password change; the new-password half is
      // what would mean the old form came back.
      "new-password",
    ]) {
      expect(account, `Account still carries ${marker}`).not.toContain(marker);
    }
  });
});
