/**
 * Public clinician-view page gating.
 * Passphrase gate: the page checks gate state first, gates a
 * protected link until the unlock cookie is valid, and never bumps access
 * counters on a gate-blocked hit.
 *
 * Asserts the page answers a flat `notFound()` (404) whenever the gate
 * resolver yields null — the single blunt response for unknown / revoked /
 * expired / malformed tokens; renders the scoped view for a legacy (no
 * passphrase) link and for a protected link with a valid unlock cookie; and
 * shows the gate (no record load) for a protected link without the cookie.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const TEST_HMAC_KEY = "test-hmac-key-at-least-32-chars-long-xxxxx";

class NotFoundError extends Error {
  digest = "NEXT_HTTP_ERROR_FALLBACK;404";
}

let cookieValue: string | undefined;

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new NotFoundError("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({ get: () => ({ value: cookieValue }) })),
}));
vi.mock("@/lib/clinician-share/resolve-share-token", () => ({
  resolveShareToken: vi.fn(),
  resolveShareGateState: vi.fn(),
}));
vi.mock("@/lib/clinician-share/share-view-data", () => ({
  loadShareViewData: vi.fn(),
}));
// Issue #490 — the page resolves the share OWNER's timezone for the date
// rendering; the Prisma-backed resolver is stubbed like the data loader.
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn(async () => "Europe/Berlin"),
}));
vi.mock("@/components/clinician/clinician-view", () => ({
  ClinicianView: () => null,
}));
vi.mock("@/components/clinician/share-unlock-gate", () => ({
  ShareUnlockGate: () => "GATE",
}));

import ClinicianSharePage from "../page";
import {
  resolveShareToken,
  resolveShareGateState,
} from "@/lib/clinician-share/resolve-share-token";
import { loadShareViewData } from "@/lib/clinician-share/share-view-data";
import { mintUnlockValue } from "@/lib/clinician-share/unlock-cookie";
import { notFound } from "next/navigation";

const resolve = resolveShareToken as ReturnType<typeof vi.fn>;
const gateState = resolveShareGateState as ReturnType<typeof vi.fn>;
const loadData = loadShareViewData as ReturnType<typeof vi.fn>;

const TOKEN_HASH = "f".repeat(64);

function pageProps(token: string) {
  return { params: Promise.resolve({ token }) };
}

/** The page returns a `<ShareUnlockGate>` element when it gates. */
function isGate(out: unknown): boolean {
  return (
    typeof out === "object" &&
    out !== null &&
    "props" in out &&
    typeof (out as { props?: { token?: unknown } }).props?.token === "string"
  );
}

/**
 * Returns the props the page handed to the gate element. A client component
 * boundary can only carry serializable props — issue #374 was a `t` FUNCTION
 * crossing it, which throws at render.
 */
function gateProps(out: unknown): Record<string, unknown> {
  return (out as { props: Record<string, unknown> }).props;
}

function resolvedContext() {
  return {
    shareLinkId: "link-1",
    ownerUserId: "owner-1",
    label: "Clinic",
    rangeStart: new Date(),
    rangeEnd: null,
    sectionsJson: {},
    expiresAt: new Date(Date.now() + 86_400_000),
  };
}

describe("clinician share page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("API_TOKEN_HMAC_KEY", TEST_HMAC_KEY);
    cookieValue = undefined;
  });

  it("404s when the token resolves to null (revoked / expired / unknown)", async () => {
    gateState.mockResolvedValue(null);
    await expect(
      ClinicianSharePage(pageProps(`hls_${"a".repeat(48)}`)),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(notFound).toHaveBeenCalledTimes(1);
    // No data load and no counter-bumping resolve on a failed gate.
    expect(loadData).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("renders a legacy (no-passphrase) link without a gate", async () => {
    gateState.mockResolvedValue({
      tokenHash: TOKEN_HASH,
      passphraseHash: null,
    });
    resolve.mockResolvedValue(resolvedContext());
    loadData.mockResolvedValue({ report: {}, sections: {} });
    await ClinicianSharePage(pageProps(`hls_${"b".repeat(48)}`));
    expect(notFound).not.toHaveBeenCalled();
    expect(loadData).toHaveBeenCalledTimes(1);
  });

  it("gates a protected link with NO unlock cookie (no record load)", async () => {
    gateState.mockResolvedValue({
      tokenHash: TOKEN_HASH,
      passphraseHash: "stored-hash",
    });
    const out = await ClinicianSharePage(pageProps(`hls_${"c".repeat(48)}`));
    // The gate island is returned; the record is never resolved or loaded.
    expect(isGate(out)).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
    expect(loadData).not.toHaveBeenCalled();

    // Issue #374 contract: every prop crossing the server→client boundary must
    // be serializable. NO prop value may be a function (a `t` function here
    // throws "Server Components render error"), and the copy must arrive as a
    // pre-resolved plain object.
    const props = gateProps(out);
    for (const value of Object.values(props)) {
      expect(typeof value).not.toBe("function");
    }
    expect(typeof props.token).toBe("string");
    const strings = props.strings as Record<string, unknown>;
    expect(strings).toBeTypeOf("object");
    expect(strings).not.toBeNull();
    expect(Object.values(strings).length).toBeGreaterThan(0);
    for (const value of Object.values(strings)) {
      expect(typeof value).toBe("string");
    }
  });

  it("renders a protected link WITH a valid unlock cookie", async () => {
    gateState.mockResolvedValue({
      tokenHash: TOKEN_HASH,
      passphraseHash: "stored-hash",
    });
    cookieValue = mintUnlockValue(TOKEN_HASH);
    resolve.mockResolvedValue(resolvedContext());
    loadData.mockResolvedValue({ report: {}, sections: {} });
    await ClinicianSharePage(pageProps(`hls_${"d".repeat(48)}`));
    expect(loadData).toHaveBeenCalledTimes(1);
  });

  it("gates a protected link with an INVALID / cross-token cookie", async () => {
    gateState.mockResolvedValue({
      tokenHash: TOKEN_HASH,
      passphraseHash: "stored-hash",
    });
    // A cookie minted for a different token must not unlock this one.
    cookieValue = mintUnlockValue("a".repeat(64));
    const out = await ClinicianSharePage(pageProps(`hls_${"e".repeat(48)}`));
    expect(isGate(out)).toBe(true);
    expect(loadData).not.toHaveBeenCalled();
  });
});
