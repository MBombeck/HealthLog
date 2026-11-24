/**
 * The fixed paths and closed values of the emergency card's Apple Wallet
 * contract (v1.50), apart from the code that resolves them, so the OpenAPI
 * registry can name them without loading the database layer.
 */

/** Where the app and the page download the pass. */
export const WALLET_DOWNLOAD_PATH = "/api/emergency-card/wallet/apple/pass";

/** Where a pass is made: the card page, on the web. */
export const WALLET_CREATE_PATH = "/emergency-card#wallet";

export const WALLET_UNAVAILABLE_REASONS = [
  "signer_off",
  "relay_not_ready",
  "no_https_origin",
  "api_disabled",
  "not_allowed",
] as const;
