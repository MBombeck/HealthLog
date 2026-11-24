/**
 * The emergency card in Apple Wallet, made, downloaded and withdrawn in a
 * browser against a server that signs passes itself.
 *
 * The pieces have unit and integration coverage: the pass content, the
 * bundle, the CMS signature, the create and withdraw routes. What none of them
 * press is the card on `/emergency-card`: the form with the name ticked, the
 * re-proof it meets, the download the page starts, the live state with its
 * two actions and the withdrawal behind a confirmation. This journey walks
 * that once, end to end, and reads the signed file back:
 *
 *   1. The download IS a pass: `application/vnd.apple.pkpass`, a zip with
 *      `pass.json`, `manifest.json` and `signature`, the manifest naming the
 *      SHA-1 of every file it ships with, the pass signed under the server's
 *      Pass Type ID, its web service and QR link on the https origin, and the
 *      name the account carries.
 *   2. The live card keeps withdrawing secondary: an outline button before
 *      the primary, never a second filled one beside it.
 *   3. Withdrawing goes through a confirmation, the state turns to
 *      withdrawn, and the next download is the withdrawn version: no QR
 *      code, no name.
 *
 * Signing: the web server signs locally with the push relay's public test
 * chain (`e2e/setup/wallet-test-signer.ts`). A pass signed that way is valid
 * against the test root only, so this proves the web flow and the file, not
 * that Wallet accepts the pass. The device test (adding it on an iPhone, the
 * update push, the withdrawn pass on the lock screen) waits for the real Pass
 * Type ID certificate.
 *
 * Origin: a pass needs an https origin, and the suite's server speaks plain
 * http. Only this journey's requests to the Wallet routes and to
 * `/api/auth/me` claim https (`x-forwarded-proto`, the header a TLS proxy
 * sets); nothing is stubbed, every answer is the server's own. The other
 * specs keep seeing a server that cannot make passes.
 *
 * Its own account (`E2E_WALLET`): one live pass per record, and global setup
 * clears the account's Wallet links so every run starts at the form.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { Page } from "@playwright/test";
import { unzipSync } from "fflate";

import { WALLET_DOWNLOAD_PATH } from "@/lib/emergency-card/wallet-pass/constants";

import {
  E2E_WALLET,
  E2E_WALLET_FULL_NAME,
  WALLET_STORAGE_STATE_PATH,
} from "./setup/global-setup";
import {
  completeReproofWithPassword,
  useStaleSession,
} from "./setup/recent-proof";
import { expect, test } from "./setup/test";
import {
  WALLET_TEST_PASS_TYPE_ID,
  WALLET_TEST_TEAM_ID,
} from "./setup/wallet-test-signer";

const PKPASS = "application/vnd.apple.pkpass";

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** The routes whose answer depends on the origin the request reached. */
function claimsHttps(url: URL): boolean {
  return (
    url.pathname === "/api/auth/me" ||
    url.pathname.startsWith("/api/emergency-card/wallet/")
  );
}

/**
 * Send this page's Wallet and account requests as if through a TLS proxy,
 * and keep each pass download the page receives. The download is fetched
 * here and handed to the browser unchanged, so the bytes read below are the
 * bytes the browser got.
 */
async function overHttps(page: Page): Promise<Captured[]> {
  const downloads: Captured[] = [];
  await page.route(claimsHttps, async (route) => {
    const headers = {
      ...route.request().headers(),
      "x-forwarded-proto": "https",
    };
    if (new URL(route.request().url()).pathname !== WALLET_DOWNLOAD_PATH) {
      await route.continue({ headers });
      return;
    }
    const response = await route.fetch({ headers });
    downloads.push({
      status: response.status(),
      headers: response.headers(),
      body: await response.body(),
    });
    await route.fulfill({ response });
  });
  return downloads;
}

type PassJson = Record<
  "passTypeIdentifier" | "teamIdentifier" | "webServiceURL",
  string
> & {
  voided: boolean;
  barcodes?: Array<{ message: string }>;
  featuredActions?: unknown[];
  posterGeneric?: { primaryFields: unknown[] };
  generic?: { primaryFields: unknown[] };
};

/** Open a `.pkpass` and check what holds it together. */
function readPass(bytes: Buffer): { pass: PassJson; passText: string } {
  // A zip starts with a local file header.
  expect(bytes.subarray(0, 4).toString("latin1")).toBe("PK\x03\x04");
  const files = unzipSync(new Uint8Array(bytes));
  for (const name of ["pass.json", "manifest.json", "signature", "icon.png"]) {
    expect(files[name], name).toBeDefined();
  }
  expect(
    Object.keys(files).some((p) => /^[\w-]+\.lproj\/pass\.strings$/.test(p)),
    "a pass.strings table",
  ).toBe(true);

  // The manifest names every other file by its SHA-1, pass.json included.
  const manifest = JSON.parse(
    Buffer.from(files["manifest.json"]).toString("utf8"),
  ) as Record<string, string>;
  const shipped = Object.keys(files).filter(
    (p) => p !== "manifest.json" && p !== "signature",
  );
  expect(Object.keys(manifest).sort()).toEqual(shipped.sort());
  for (const path of shipped) {
    expect(manifest[path], path).toBe(
      createHash("sha1").update(files[path]).digest("hex"),
    );
  }

  // A detached CMS signature: DER, a SEQUENCE at the top.
  const signature = files["signature"];
  expect(signature[0]).toBe(0x30);
  expect(signature.length).toBeGreaterThan(1000);

  const passText = Buffer.from(files["pass.json"]).toString("utf8");
  return { pass: JSON.parse(passText) as PassJson, passText };
}

test.describe("emergency card in Apple Wallet", () => {
  test.use({ storageState: WALLET_STORAGE_STATE_PATH });

  let endStaleSession: (() => Promise<void>) | null = null;
  test.afterEach(async () => {
    await endStaleSession?.();
    endStaleSession = null;
  });

  test("makes, downloads and withdraws a signed pass", async ({ page }) => {
    // Making a pass asks for a recent proof. A session of its own, signed in
    // ten minutes ago, meets the dialog on every run whatever the clock says.
    endStaleSession = await useStaleSession(page, E2E_WALLET.username);
    const downloads = await overHttps(page);

    await page.goto("/emergency-card");
    const card = page.locator('[data-slot="emergency-card-wallet-card"]');
    await expect(card).toBeVisible();

    // The form, with the name ticked by default and the note not.
    const create = card.locator('[data-slot="wallet-create"]');
    await expect(create).toBeEnabled();
    await expect(card.locator("#wallet-field-NAME")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    const note = card.locator("#wallet-field-NOTE");
    await expect(note).toHaveAttribute("aria-checked", "false");
    await note.click();
    await expect(note).toHaveAttribute("aria-checked", "true");

    // The server signs itself, so no signing notice; the re-proof opens, and
    // once it is answered the page makes the pass and starts the download.
    const downloadEvent = page.waitForEvent("download");
    await create.click();
    await completeReproofWithPassword(page, E2E_WALLET.password);
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe(
      "healthlog-emergency-card.pkpass",
    );

    await expect.poll(() => downloads.length).toBe(1);
    const [live] = downloads;
    expect(live.status).toBe(200);
    expect(live.headers["content-type"]).toBe(PKPASS);
    expect(live.headers["hl-wallet-state"]).toBe("live");
    // The file the browser saved is the file the server sent.
    const saved = await readFile(await download.path());
    expect(saved.equals(live.body)).toBe(true);

    const origin = `https://${new URL(page.url()).host}`;
    const { pass, passText } = readPass(live.body);
    expect(pass.passTypeIdentifier).toBe(WALLET_TEST_PASS_TYPE_ID);
    expect(pass.teamIdentifier).toBe(WALLET_TEST_TEAM_ID);
    expect(pass.webServiceURL).toBe(`${origin}/api/wallet/apple/`);
    expect(pass.voided).toBe(false);
    expect(pass.barcodes).toHaveLength(1);
    expect(pass.barcodes?.[0].message.startsWith(`${origin}/e/hlm_`)).toBe(
      true,
    );
    expect(pass.posterGeneric?.primaryFields.length).toBeGreaterThan(0);
    expect(pass.generic?.primaryFields.length).toBeGreaterThan(0);
    expect(passText).toContain(E2E_WALLET_FULL_NAME);

    // The record holds the ticked items, frozen on the pass.
    const status = await page.evaluate(async () => {
      const res = await fetch("/api/emergency-card/wallet/apple");
      return (await res.json()).data as {
        apple: { pass: { state: string; fields: string[] } | null };
      };
    });
    expect(status.apple.pass?.state).toBe("live");
    expect(status.apple.pass?.fields).toEqual(
      expect.arrayContaining(["NAME", "NOTE"]),
    );

    // Live: the pass's state, the primary action to add it, and withdrawing
    // as the secondary action before it, never a second filled button.
    const state = card.locator('[data-slot="wallet-pass-state"]');
    await expect(state).toHaveAttribute("data-state", "live");
    const add = card.locator('[data-slot="wallet-add"]');
    const withdraw = card.locator('[data-slot="wallet-withdraw"]');
    await expect(add).toBeVisible();
    await expect(withdraw).toBeVisible();
    await expect(add).toHaveAttribute("data-variant", "default");
    await expect(withdraw).toHaveAttribute("data-variant", "outline");
    const order = await card.evaluate((root) => {
      const slots = [...root.querySelectorAll("[data-slot]")].map((el) =>
        el.getAttribute("data-slot"),
      );
      return [slots.indexOf("wallet-withdraw"), slots.indexOf("wallet-add")];
    });
    expect(order[0], "withdraw comes before the primary action").toBeLessThan(
      order[1],
    );

    // Withdrawing asks first, then ends the pass.
    await withdraw.click();
    const confirm = page.locator('[data-slot="wallet-withdraw-confirm"]');
    await expect(confirm).toBeVisible();
    await confirm.click();
    await expect(state).toHaveAttribute("data-state", "voided");
    await expect(add).toHaveCount(0);

    // The next download is the withdrawn version: no code, no name. Fetched
    // outside the page; the download route reads no origin.
    const res = await page.request.get(WALLET_DOWNLOAD_PATH);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe(PKPASS);
    expect(res.headers()["hl-wallet-state"]).toBe("voided");
    const voided = readPass(await res.body());
    expect(voided.pass.voided).toBe(true);
    expect(voided.pass.barcodes).toBeUndefined();
    expect(voided.pass.featuredActions).toBeUndefined();
    expect(voided.passText).not.toContain(E2E_WALLET_FULL_NAME);
  });
});
