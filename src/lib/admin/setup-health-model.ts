/**
 * 1.49 — the health of a server's setup, as signals.
 *
 * The same shape as the recovery readiness (`src/lib/recovery/
 * readiness-model.ts`): a closed list of signals, each with a state and a
 * closed reason code the card renders through
 * `admin.setupHealth.reason.<signal>.<reason>`, so nothing here carries prose
 * and nothing carries a secret. Pure: the loader (`./setup-health.ts`) reads
 * the environment and the request, this decides.
 *
 * It lives permanently on Admin → System status; the server setup's last step
 * shows the same card.
 */

export const SETUP_HEALTH_SIGNALS = [
  "encryption_keys",
  "secure_cookie",
  "app_url",
  "database_dump",
] as const;

export type SetupHealthSignalId = (typeof SETUP_HEALTH_SIGNALS)[number];

export type SetupHealthState = "ok" | "attention" | "failing";

/** Where each signal is fixed: an admin page, or the docs page that says how. */
export const SETUP_HEALTH_FIX: Record<
  SetupHealthSignalId,
  { path: string | null; docs: string }
> = {
  encryption_keys: {
    path: "/admin/encryption",
    docs: "https://docs.healthlog.dev/guides/encryption-key-rotation/",
  },
  secure_cookie: {
    path: null,
    docs: "https://docs.healthlog.dev/guides/reverse-proxy/",
  },
  app_url: {
    path: null,
    docs: "https://docs.healthlog.dev/reference/environment-variables/",
  },
  database_dump: {
    path: "/admin/backups",
    docs: "https://docs.healthlog.dev/guides/backups/",
  },
};

export interface SetupHealthSignal {
  id: SetupHealthSignalId;
  state: SetupHealthState;
  /** A closed code per signal; the card renders it, never prose here. */
  reason: string;
  /** Values the sentence interpolates. Never key material or a secret. */
  params: Record<string, string | number>;
  fixPath: string | null;
  docsUrl: string;
}

export interface SetupHealth {
  /** The worst state of the signals. */
  state: SetupHealthState;
  signals: SetupHealthSignal[];
}

export interface SetupHealthInputs {
  encryption: { configuredKeys: number; activeKeyId: string | null };
  /** Whether cookies carry the `Secure` flag (`shouldEmitSecureCookie()`). */
  secureCookie: boolean;
  /** How this request reached the server: `https`, `http`, or unknown. */
  requestProtocol: "https" | "http" | null;
  /**
   * Where that scheme came from (`resolveRequestOrigin`): a trusted proxy's
   * report, the configured public URL because the proxy did not say, or the
   * request URL. Null when the protocol is unknown.
   */
  requestProtocolFrom: "proxy" | "public_url" | "request" | null;
  /** The configured public URL (`NEXT_PUBLIC_APP_URL`, else `APP_URL`). */
  appUrl: string | null;
  /** The origin this request was made to, as the server saw it. */
  requestOrigin: string | null;
  backups: { enabled: boolean; persistent: boolean; cron: string };
}

function signal(
  id: SetupHealthSignalId,
  state: SetupHealthState,
  reason: string,
  params: Record<string, string | number> = {},
): SetupHealthSignal {
  return {
    id,
    state,
    reason,
    params,
    fixPath: SETUP_HEALTH_FIX[id].path,
    docsUrl: SETUP_HEALTH_FIX[id].docs,
  };
}

export function evaluateEncryptionKeys(
  input: SetupHealthInputs["encryption"],
): SetupHealthSignal {
  if (input.configuredKeys === 0) {
    return signal("encryption_keys", "failing", "missing");
  }
  return signal("encryption_keys", "ok", "present", {
    count: input.configuredKeys,
    active: input.activeKeyId ?? "",
  });
}

/**
 * The `Secure` flag against how the request arrived.
 *
 * - Secure over HTTPS, or no flag over plain HTTP (the documented LAN
 *   choice): fine.
 * - Secure over HTTPS that only the configured public URL vouches for: the
 *   cookie works, but the proxy in front does not report the scheme, so
 *   anything else that reads the request sees plain HTTP. Attention, with
 *   the one header to set.
 * - Secure over plain HTTP: attention, not failing. This card is read over
 *   an admin's cookie session, so the Secure cookie evidently stuck; plain
 *   HTTP here means a proxy that does not report HTTPS, or a loopback host.
 * - No flag over HTTPS: attention (it works, but the cookie could travel in
 *   clear on a downgrade).
 */
export function evaluateSecureCookie(
  secureCookie: boolean,
  protocol: SetupHealthInputs["requestProtocol"],
  protocolFrom: SetupHealthInputs["requestProtocolFrom"],
): SetupHealthSignal {
  if (protocol === null) {
    return signal("secure_cookie", "ok", secureCookie ? "on" : "off");
  }
  if (secureCookie && protocol === "https") {
    return protocolFrom === "public_url"
      ? signal("secure_cookie", "attention", "proxy_scheme_unreported")
      : signal("secure_cookie", "ok", "secure_over_https");
  }
  if (!secureCookie && protocol === "http") {
    return signal("secure_cookie", "ok", "plain_http");
  }
  if (secureCookie) {
    return signal("secure_cookie", "attention", "secure_over_http");
  }
  return signal("secure_cookie", "attention", "insecure_over_https");
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function evaluateAppUrl(
  appUrl: string | null,
  requestOrigin: string | null,
): SetupHealthSignal {
  if (!appUrl) return signal("app_url", "attention", "unset");
  const configured = originOf(appUrl);
  if (!configured) return signal("app_url", "attention", "invalid");
  if (requestOrigin && originOf(requestOrigin) !== configured) {
    return signal("app_url", "attention", "mismatch", {
      configured,
      request: originOf(requestOrigin) ?? requestOrigin,
    });
  }
  return signal("app_url", "ok", "matches", { url: configured });
}

export function evaluateDatabaseDump(
  input: SetupHealthInputs["backups"],
): SetupHealthSignal {
  if (!input.enabled) return signal("database_dump", "attention", "disabled");
  if (!input.persistent) {
    return signal("database_dump", "attention", "not_persistent");
  }
  return signal("database_dump", "ok", "scheduled", { cron: input.cron });
}

const RANK: Record<SetupHealthState, number> = {
  ok: 0,
  attention: 1,
  failing: 2,
};

export function evaluateSetupHealth(input: SetupHealthInputs): SetupHealth {
  const signals = [
    evaluateEncryptionKeys(input.encryption),
    evaluateSecureCookie(
      input.secureCookie,
      input.requestProtocol,
      input.requestProtocolFrom,
    ),
    evaluateAppUrl(input.appUrl, input.requestOrigin),
    evaluateDatabaseDump(input.backups),
  ];
  const state = signals.reduce<SetupHealthState>(
    (worst, s) => (RANK[s.state] > RANK[worst] ? s.state : worst),
    "ok",
  );
  return { state, signals };
}
