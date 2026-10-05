import type { AIProvider, CompletionResult } from "./types";
import { bindResponseTimeout } from "./effective-timeout";
import { bindReasoningEffort } from "./reasoning-effort";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { CodexClient, resolveCodexVisionSlug } from "./codex-client";
import { OpenAIClient } from "./openai-client";
import { AnthropicClient } from "./anthropic-client";
import { LocalOpenAICompatibleClient } from "./local-client";
import {
  refreshDeviceTokens,
  encryptCodexCreds,
  decryptCodexCreds,
  encryptAdminCodexCreds,
  decryptAdminCodexCreds,
} from "./codex-oauth";
import { isPublicUrl } from "@/lib/validations/notifications";
import { isLocalAiHostAllowed } from "./local-host-allowlist";
import {
  parseProviderChain,
  PROVIDER_CHAIN_TYPES,
  type ProviderChainType,
} from "./provider-chain";
import type { ProviderChainResolved } from "./provider-runner";
import {
  providerCredentialPolicy,
  providerWorkAuthorityForRecord,
  type ProviderCredentialPolicy,
  type ProviderWorkAuthority,
} from "@/lib/sharing/provider-work-authority";
import { memoizePerRequest } from "@/lib/request-cache";
import type { AiModality } from "@/lib/ai/capabilities/types";
import type {
  ProviderEntryPresence,
  ProviderPresence,
} from "@/lib/ai/capabilities/resolve";
import {
  supportsVisionForConfig,
  type VisionProviderType,
} from "./vision-capability";

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

class NoProvider implements AIProvider {
  readonly type = "none" as const;

  async generateCompletion(): Promise<CompletionResult> {
    throw new Error(
      "No AI provider configured. Connect ChatGPT or set an API key in settings.",
    );
  }
}

type UserAIRow = {
  aiProvider: string | null;
  aiModel: string | null;
  aiBaseUrl: string | null;
  aiAnthropicKeyEncrypted: string | null;
  aiLocalKeyEncrypted: string | null;
  aiOpenaiKeyEncrypted: string | null;
  aiCompatBaseUrl: string | null;
  aiCompatKeyEncrypted: string | null;
  aiCompatModel: string | null;
  /**
   * v1.39.3 — the owning account's role. Provider settings saved on an admin
   * account are the operator's own, and only those (plus the instance-wide
   * admin provider) are still covered by the deprecated
   * `ALLOW_LOCAL_AI_PRIVATE_HOSTS=true`.
   */
  role: string;
};

/** v1.39.3 — see `UserAIRow.role`. */
function isOperatorOwned(row: { role: string } | null | undefined): boolean {
  return row?.role === "ADMIN";
}

/**
 * v1.33.1 (#470) — build the OpenAI-compatible gateway client from the user's
 * three dedicated columns. The signature names every column this provider is
 * allowed to read: the OpenAI key and `aiBaseUrl` are absent on purpose, so a
 * future edit that wants to hand it either has to widen this shape first and
 * answer for it.
 *
 * Returns null when the gateway cannot be addressed — no base URL, or no
 * model anywhere. An unconfigured entry is SKIPPED by the chain runner rather
 * than erroring, exactly like an `anthropic` entry with no key.
 *
 * Model resolution: `aiCompatModel` is the override; absent, the shared
 * `aiModel` applies (a gateway usually routes the same model name the user
 * already types for their other providers). Nothing is invented — with
 * neither set there is no model to send, so the entry does not resolve.
 *
 * The key is OPTIONAL: a LAN LiteLLM without a master key needs no bearer,
 * and the client omits the header entirely for an empty string. The base URL
 * passed the SSRF floor at write time (`/api/user/ai-provider`); the client
 * re-applies the Local provider's host policy at call time.
 */
function buildCompatProvider(row: {
  aiModel: string | null;
  aiCompatBaseUrl: string | null;
  aiCompatKeyEncrypted: string | null;
  aiCompatModel: string | null;
  role: string;
}): AIProvider | null {
  const model = row.aiCompatModel?.trim() || row.aiModel?.trim() || null;
  if (!row.aiCompatBaseUrl || !model) return null;
  return new OpenAIClient({
    apiKey: row.aiCompatKeyEncrypted ? decrypt(row.aiCompatKeyEncrypted) : "",
    model,
    baseUrl: row.aiCompatBaseUrl,
    providerType: "openai-compatible",
    operatorTrusted: isOperatorOwned(row),
  });
}

/**
 * Build a provider from a user-level config row. Returns null if the row does
 * not select a usable per-user provider (caller falls back to admin/codex).
 */
function buildUserProvider(row: UserAIRow): AIProvider | null {
  const choice = row.aiProvider?.toUpperCase();
  if (!choice) return null;

  switch (choice) {
    case "ANTHROPIC": {
      if (!row.aiAnthropicKeyEncrypted) return null;
      // Belt-and-braces: even if a stale `aiBaseUrl` from a prior LOCAL
      // configuration survived in the row, refuse to forward an Anthropic
      // key to it. Anthropic has no per-tenant base URL the UI exposes;
      // the SDK default is correct.
      return new AnthropicClient({
        apiKey: decrypt(row.aiAnthropicKeyEncrypted),
        model: row.aiModel ?? "claude-sonnet-4-6",
      });
    }
    case "LOCAL": {
      if (!row.aiBaseUrl) return null;
      return new LocalOpenAICompatibleClient({
        apiKey: row.aiLocalKeyEncrypted
          ? decrypt(row.aiLocalKeyEncrypted)
          : null,
        model: row.aiModel ?? "local-model",
        baseUrl: row.aiBaseUrl,
        operatorTrusted: isOperatorOwned(row),
      });
    }
    case "OPENAI_COMPATIBLE": {
      // v1.33.1 (#470) — the gateway provider. Reads its own three columns
      // and nothing else; the OpenAI arm below stays pinned.
      return buildCompatProvider(row);
    }
    case "OPENAI": {
      // v1.4.3: user-level OpenAI key gets first crack — only fall back
      // to the admin key if the user hasn't supplied their own. The
      // model-default mirrors the admin path for consistency so a saved
      // user "OPENAI" without an explicit model still produces an
      // OpenAIClient with the current full-size default `gpt-4o`.
      // Belt-and-braces: ignore any persisted `aiBaseUrl`. The column is
      // shared with LOCAL, so a stale LAN URL there would otherwise
      // redirect the user's OpenAI key to a private host.
      if (!row.aiOpenaiKeyEncrypted) return null;
      return new OpenAIClient({
        apiKey: decrypt(row.aiOpenaiKeyEncrypted),
        model: row.aiModel ?? "gpt-4o",
        baseUrl: "https://api.openai.com/v1",
      });
    }
    case "CHATGPT_OAUTH":
      // Caller handles Codex OAuth via the dedicated branch; signal here.
      return null;
    default:
      return null;
  }
}

/**
 * True when a base URL addresses Anthropic's API: the host itself or any
 * subdomain of `anthropic.com`, case-insensitively. Parsed rather than
 * substring-matched, so `https://anthropic.com.attacker.example/v1` and
 * `https://evil.example/?x=api.anthropic.com` both answer false.
 *
 * An unparseable value answers false and keeps the OpenAI path, which is the
 * behaviour that value had before this function existed.
 */
function isAnthropicBaseUrl(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "anthropic.com" || host.endsWith(".anthropic.com");
}

/**
 * The operator's global provider — one key, one model, one base URL in the
 * admin settings, serving every user who has configured nothing themselves.
 *
 * The base URL decides the wire. An operator who fills these fields with an
 * Anthropic endpoint and an Anthropic key used to get OpenAI-shaped requests
 * posted at Anthropic, which fails every call with nothing pointing at the
 * cause; the host check routes them to the same `AnthropicClient` the
 * per-user `ANTHROPIC` arm builds. Every other host stays on `OpenAIClient`,
 * which is also the right client for an OpenAI-compatible endpoint (a local
 * server, a gateway) — the admin base URL is host-allowlisted at write time
 * in `/api/admin/ai-settings`.
 *
 * The chain still reports this entry as `admin-openai` whichever client it
 * builds. That tag names the SLOT — "the operator's shared credential, last
 * in the chain" — not the wire: it is persisted in `User.aiProviderChain`,
 * offered in the chain editor, and pinned by the OpenAPI enum, so splitting
 * it per wire would rewrite stored chains and widen a structural allowlist to
 * express something the runtime provider type (`admin-key` / `anthropic` on
 * the instance, which is what the wide events and the budget classifier read)
 * already carries.
 */
async function resolveAdminProvider(): Promise<AIProvider> {
  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
  });

  if (settings?.adminAiKeyEncrypted) {
    const baseUrl = settings.adminAiBaseUrl ?? "https://api.openai.com/v1";
    if (isAnthropicBaseUrl(baseUrl)) {
      return new AnthropicClient({
        apiKey: decrypt(settings.adminAiKeyEncrypted),
        model: settings.adminAiModel ?? "claude-sonnet-4-6",
        baseUrl,
      });
    }
    return new OpenAIClient({
      apiKey: decrypt(settings.adminAiKeyEncrypted),
      model: settings.adminAiModel ?? "gpt-4o",
      baseUrl,
      // The instance-wide provider is the operator's own configuration.
      operatorTrusted: true,
    });
  }

  return new NoProvider();
}

/**
 * Codex provider — device-code path.
 *
 * `codexAccessTokenEncrypted` stores an encrypted JSON blob with the
 * OAuth access token AND the `chatgpt_account_id` claim from the
 * id_token (the latter is mandatory in the `ChatGPT-Account-ID`
 * header). `codexRefreshTokenEncrypted` continues to hold just the
 * refresh token. See `codex-oauth.ts` for the storage codec.
 *
 * Old v1.4.7-v1.4.11 rows that stored a raw token string instead of
 * the JSON envelope cannot be revived (the account id was never
 * captured), so `decryptCodexCreds` returns null and we treat the
 * connection as expired — the user re-runs the connect flow once.
 */
async function resolveCodexProvider(
  userId: string,
): Promise<AIProvider | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      codexAccessTokenEncrypted: true,
      codexRefreshTokenEncrypted: true,
      codexConnectionStatus: true,
    },
  });

  if (
    user?.codexConnectionStatus !== "connected" ||
    !user.codexAccessTokenEncrypted ||
    !user.codexRefreshTokenEncrypted
  ) {
    return null;
  }

  const stored = decryptCodexCreds({
    accessEncrypted: user.codexAccessTokenEncrypted,
    refreshEncrypted: user.codexRefreshTokenEncrypted,
  });
  if (!stored) {
    // Pre-v1.4.12 record without account_id — the token cannot
    // satisfy the ChatGPT-Account-ID header. Mark the row as
    // disconnected so the UI prompts the user to re-link.
    await prisma.user.update({
      where: { id: userId },
      data: { codexConnectionStatus: "expired" },
    });
    return null;
  }

  let active = stored;

  // Proactive refresh if the access token is within 5 min of expiry.
  if (stored.expiresAt.getTime() < Date.now() + TOKEN_REFRESH_BUFFER_MS) {
    try {
      const fresh = await refreshDeviceTokens(stored.refreshToken);
      active = fresh;

      const enc = encryptCodexCreds(fresh);
      await prisma.user.update({
        where: { id: userId },
        data: {
          codexAccessTokenEncrypted: enc.accessEncrypted,
          codexRefreshTokenEncrypted: enc.refreshEncrypted,
          codexTokenExpiresAt: fresh.expiresAt,
        },
      });
    } catch {
      // Fall through — CodexClient will trigger an on-401 refresh
      // and persist there.
    }
  }

  return new CodexClient({
    accessToken: active.accessToken,
    accountId: active.accountId,
    onTokenRefresh: async () => {
      const freshUser = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          codexAccessTokenEncrypted: true,
          codexRefreshTokenEncrypted: true,
        },
      });
      if (
        !freshUser?.codexAccessTokenEncrypted ||
        !freshUser.codexRefreshTokenEncrypted
      ) {
        throw new Error("No refresh token available");
      }
      const decoded = decryptCodexCreds({
        accessEncrypted: freshUser.codexAccessTokenEncrypted,
        refreshEncrypted: freshUser.codexRefreshTokenEncrypted,
      });
      if (!decoded) {
        throw new Error("Codex token storage corrupt; user must re-link");
      }
      const fresh = await refreshDeviceTokens(decoded.refreshToken);
      const enc = encryptCodexCreds(fresh);
      await prisma.user.update({
        where: { id: userId },
        data: {
          codexAccessTokenEncrypted: enc.accessEncrypted,
          codexRefreshTokenEncrypted: enc.refreshEncrypted,
          codexTokenExpiresAt: fresh.expiresAt,
        },
      });
      return { accessToken: fresh.accessToken, accountId: fresh.accountId };
    },
  });
}

/**
 * Operator-shared central Codex provider — the `admin-codex` chain entry.
 *
 * Mirrors `resolveCodexProvider` but reads the operator's singleton credential
 * from `AppSettings.adminCodex*` (three dedicated encrypted columns) instead of
 * the per-user `codex*Encrypted` columns, and writes any refreshed tokens back
 * to the same singleton row. Returns null unless the operator has actually
 * connected the central Codex (`adminCodexConnectionStatus === "connected"` with
 * all three token columns present) — the per-user `useCentralCodex` opt-in is
 * enforced by the caller before this is ever invoked.
 *
 * Never called with any user identity: the credential and every token refresh
 * belong to the operator's account, so cost + rate limits land on the operator
 * (billed against the operator cap, not the user plan).
 */
async function resolveAdminCodexProvider(): Promise<AIProvider | null> {
  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: {
      adminCodexConnectionStatus: true,
      adminCodexAccessTokenEncrypted: true,
      adminCodexRefreshTokenEncrypted: true,
      adminCodexAccountIdEncrypted: true,
      adminCodexTokenExpiresAt: true,
    },
  });

  if (
    settings?.adminCodexConnectionStatus !== "connected" ||
    !settings.adminCodexAccessTokenEncrypted ||
    !settings.adminCodexRefreshTokenEncrypted ||
    !settings.adminCodexAccountIdEncrypted
  ) {
    return null;
  }

  const stored = decryptAdminCodexCreds({
    accessEncrypted: settings.adminCodexAccessTokenEncrypted,
    refreshEncrypted: settings.adminCodexRefreshTokenEncrypted,
    accountIdEncrypted: settings.adminCodexAccountIdEncrypted,
    expiresAt: settings.adminCodexTokenExpiresAt,
  });
  if (!stored) {
    // Corrupt / undecryptable credential (e.g. a rotated-out key) — mark the
    // singleton expired so the admin UI prompts a re-link. Never plaintext.
    await prisma.appSettings.update({
      where: { id: "singleton" },
      data: { adminCodexConnectionStatus: "expired" },
    });
    return null;
  }

  let active = stored;

  if (stored.expiresAt.getTime() < Date.now() + TOKEN_REFRESH_BUFFER_MS) {
    try {
      const fresh = await refreshDeviceTokens(stored.refreshToken);
      active = fresh;
      const enc = encryptAdminCodexCreds(fresh);
      await prisma.appSettings.update({
        where: { id: "singleton" },
        data: {
          adminCodexAccessTokenEncrypted: enc.accessEncrypted,
          adminCodexRefreshTokenEncrypted: enc.refreshEncrypted,
          adminCodexAccountIdEncrypted: enc.accountIdEncrypted,
          adminCodexTokenExpiresAt: enc.expiresAt,
        },
      });
    } catch {
      // Fall through — CodexClient triggers an on-401 refresh and persists via
      // the callback below.
    }
  }

  return new CodexClient({
    accessToken: active.accessToken,
    accountId: active.accountId,
    onTokenRefresh: async () => {
      const fresh = await prisma.appSettings.findUnique({
        where: { id: "singleton" },
        select: {
          adminCodexAccessTokenEncrypted: true,
          adminCodexRefreshTokenEncrypted: true,
          adminCodexAccountIdEncrypted: true,
          adminCodexTokenExpiresAt: true,
        },
      });
      if (
        !fresh?.adminCodexAccessTokenEncrypted ||
        !fresh.adminCodexRefreshTokenEncrypted ||
        !fresh.adminCodexAccountIdEncrypted
      ) {
        throw new Error("No central-codex refresh token available");
      }
      const decoded = decryptAdminCodexCreds({
        accessEncrypted: fresh.adminCodexAccessTokenEncrypted,
        refreshEncrypted: fresh.adminCodexRefreshTokenEncrypted,
        accountIdEncrypted: fresh.adminCodexAccountIdEncrypted,
        expiresAt: fresh.adminCodexTokenExpiresAt,
      });
      if (!decoded) {
        throw new Error(
          "Central-codex token storage corrupt; re-link required",
        );
      }
      const refreshed = await refreshDeviceTokens(decoded.refreshToken);
      const enc = encryptAdminCodexCreds(refreshed);
      await prisma.appSettings.update({
        where: { id: "singleton" },
        data: {
          adminCodexAccessTokenEncrypted: enc.accessEncrypted,
          adminCodexRefreshTokenEncrypted: enc.refreshEncrypted,
          adminCodexAccountIdEncrypted: enc.accountIdEncrypted,
          adminCodexTokenExpiresAt: enc.expiresAt,
        },
      });
      return {
        accessToken: refreshed.accessToken,
        accountId: refreshed.accountId,
      };
    },
  });
}

/**
 * Resolve the AI provider for a given user.
 *
 * Priority:
 *   1. User selected ANTHROPIC / LOCAL with valid creds → that provider.
 *   2. User selected CHATGPT_OAUTH (or no explicit choice but Codex tokens
 *      are connected) → Codex.
 *   3. User selected OPENAI (or no creds for the chosen provider) → admin
 *      OpenAI key from app_settings.
 *   4. Nothing configured → NoProvider().
 */
export async function resolveProvider(userId: string): Promise<AIProvider> {
  const authority = providerWorkAuthorityForRecord(userId);
  if (providerCredentialPolicy(authority) === "deny") return new NoProvider();

  const userRow = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      aiProvider: true,
      aiModel: true,
      aiBaseUrl: true,
      aiAnthropicKeyEncrypted: true,
      aiLocalKeyEncrypted: true,
      aiOpenaiKeyEncrypted: true,
      aiCompatBaseUrl: true,
      aiCompatKeyEncrypted: true,
      aiCompatModel: true,
      role: true,
      managedProfileAt: true,
      aiResponseTimeoutSeconds: true,
      aiProviderChain: true,
    },
  });
  // The record's response-timeout setting rides on whatever this returns, on
  // every branch, the operator-key fallback for a managed profile included:
  // the person waiting on the record is who the call serves. The reasoning
  // effort (#1126) rides the same way; it only lands on a Local or gateway
  // instance, so the operator fallback never picks one up.
  const bind = (provider: AIProvider): AIProvider =>
    bindReasoningEffort(
      bindResponseTimeout(provider, userRow?.aiResponseTimeoutSeconds),
      userRow?.aiProviderChain,
    );
  const policy = providerCredentialPolicy(
    authority,
    userRow?.managedProfileAt ?? null,
  );
  if (policy === "operator-default") return bind(await resolveAdminProvider());

  // 1. Per-user Anthropic / Local
  if (userRow) {
    const userProvider = buildUserProvider(userRow);
    if (userProvider) return bind(userProvider);
  }

  // 2. Codex OAuth (either explicitly selected or implicit fallback)
  const explicitChoice = userRow?.aiProvider?.toUpperCase();
  const tryCodex = explicitChoice === "CHATGPT_OAUTH" || !explicitChoice;
  if (tryCodex) {
    const codex = await resolveCodexProvider(userId);
    if (codex) return bind(codex);
  }

  // 3. Admin OpenAI key (also acts as fallback for user-OPENAI selection)
  return bind(await resolveAdminProvider());
}

/**
 * The record owner's `aiResponseTimeoutSeconds` and `aiProviderChain`, for
 * `resolveProviderForTest`, whose many branches (saved config, unsaved
 * override, the chain) are bound in one place on the way out. The other two
 * resolvers read them with their row.
 */
async function readBoundSettings(userId: string): Promise<{
  aiResponseTimeoutSeconds: number | null;
  aiProviderChain: unknown;
}> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { aiResponseTimeoutSeconds: true, aiProviderChain: true },
  });
  return {
    aiResponseTimeoutSeconds: row?.aiResponseTimeoutSeconds ?? null,
    aiProviderChain: row?.aiProviderChain ?? null,
  };
}

/**
 * v1.4.16 phase B5b — resolve a chain of providers in priority order
 * for the multi-provider fallback runner. Each entry pairs a logical
 * `providerType` with a constructed `AIProvider` instance ready to
 * accept `generateCompletion()` calls.
 *
 * Steps:
 *   1. Read `User.aiProviderChain` (or `PROVIDER_CHAIN_DEFAULT` when
 *      null). Already sorted + deduplicated by `parseProviderChain`.
 *   2. For each enabled entry, attempt to materialise the provider
 *      from the user's saved credentials. Drop entries that have no
 *      usable credential (e.g. chain says `anthropic` but
 *      `aiAnthropicKeyEncrypted` is null).
 *   3. Returns the surviving array — possibly empty if the user has
 *      no configured providers anywhere. Caller raises 422 in that
 *      case.
 *
 * Reused by the regular insight-generate route (B5b) AND the v1.4.17
 * feedback-attribution path (B5e) — both need the same resolution
 * semantics. `resolveProvider()` keeps its single-result shape for
 * the legacy `weight-status.ts` / `mood-status.ts` / etc. consumers
 * that have not migrated to the chain runner yet.
 */
export async function resolveProviderChain(
  userId: string,
): Promise<ProviderChainResolved[]> {
  const authority = providerWorkAuthorityForRecord(userId);
  if (providerCredentialPolicy(authority) === "deny") return [];

  const userRow = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      aiProvider: true,
      aiModel: true,
      aiBaseUrl: true,
      aiAnthropicKeyEncrypted: true,
      aiLocalKeyEncrypted: true,
      aiOpenaiKeyEncrypted: true,
      aiCompatBaseUrl: true,
      aiCompatKeyEncrypted: true,
      aiCompatModel: true,
      role: true,
      aiProviderChain: true,
      useCentralCodex: true,
      managedProfileAt: true,
      aiResponseTimeoutSeconds: true,
    },
  });
  // See `resolveProvider`: every instance carries the record's settings.
  const bind = (provider: AIProvider): AIProvider =>
    bindReasoningEffort(
      bindResponseTimeout(provider, userRow?.aiResponseTimeoutSeconds),
      userRow?.aiProviderChain,
    );
  const policy = providerCredentialPolicy(
    authority,
    userRow?.managedProfileAt ?? null,
  );
  if (policy === "operator-default") {
    const provider = await resolveAdminProvider();
    return provider.type === "none"
      ? []
      : [{ providerType: "admin-openai", instance: bind(provider) }];
  }

  const rawChain = userRow?.aiProviderChain ?? null;
  const chain = parseProviderChain(rawChain).filter((e) => e.enabled);

  const resolved: ProviderChainResolved[] = [];
  for (const entry of chain) {
    const instance = await resolveProviderForType(entry.providerType, {
      userId,
      userRow,
      policy,
    });
    if (instance) {
      resolved.push({
        providerType: entry.providerType,
        instance: bind(instance),
      });
    }
  }

  // Operator-shared central Codex — appended LAST, and ONLY when the user opted
  // in AND the operator has connected it. It is never part of the persisted
  // chain (a persisted `admin-codex` entry resolves to null above), so this is
  // the single place the opt-in gate is enforced. As a trailing fallback the
  // user's own providers are tried first; a user with no personal provider
  // resolves to `[admin-codex]` and is billed against the operator cap.
  if (userRow?.useCentralCodex) {
    const centralCodex = await resolveAdminCodexProvider();
    if (centralCodex) {
      resolved.push({
        providerType: "admin-codex",
        instance: bind(centralCodex),
      });
    }
  }

  return resolved;
}

/**
 * Credential-presence subset of the `User` row that
 * `userRowHasProviderCredential` evaluates. Mirrors the columns
 * `resolveProviderChain` / `resolveProvider` read, but presence-only —
 * no decrypt, no client construction, no token refresh.
 */
export interface ProviderCredentialRow {
  aiProvider: string | null;
  aiProviderChain: unknown;
  aiAnthropicKeyEncrypted: string | null;
  aiLocalKeyEncrypted: string | null;
  aiOpenaiKeyEncrypted: string | null;
  aiBaseUrl: string | null;
  aiModel: string | null;
  aiCompatBaseUrl: string | null;
  aiCompatModel: string | null;
  codexConnectionStatus: string | null;
  codexAccessTokenEncrypted: string | null;
  codexRefreshTokenEncrypted: string | null;
}

/**
 * Cheap, synchronous "is any provider configured?" check over an already
 * loaded credential row. Mirrors the resolution semantics of
 * `resolveProviderChain` + the legacy `resolveProvider` fallback (the
 * exact pair `generateComprehensiveInsight` uses to decide
 * `skipped: no-provider`), but evaluates credential PRESENCE only —
 * it never decrypts a key, constructs a client, or refreshes a Codex
 * token. A `true` here can still resolve to a dead provider at call
 * time (revoked key, unreachable local host); callers use it to decide
 * whether a generation is worth attempting at all, not as a liveness
 * probe.
 *
 * `adminKeyConfigured` is the presence of `appSettings.adminAiKeyEncrypted`
 * — passed in so batch callers can read it once for a whole cohort.
 */
export function userRowHasProviderCredential(
  row: ProviderCredentialRow,
  adminKeyConfigured: boolean,
  policy: ProviderCredentialPolicy = "personal",
): boolean {
  if (policy === "deny") return false;
  if (policy === "operator-default") return adminKeyConfigured;
  const codexConnected =
    row.codexConnectionStatus === "connected" &&
    !!row.codexAccessTokenEncrypted &&
    !!row.codexRefreshTokenEncrypted;

  const chain = parseProviderChain(row.aiProviderChain ?? null).filter(
    (e) => e.enabled,
  );
  for (const entry of chain) {
    switch (entry.providerType) {
      case "codex":
        if (codexConnected) return true;
        break;
      case "openai":
        if (row.aiOpenaiKeyEncrypted) return true;
        break;
      case "anthropic":
        if (row.aiAnthropicKeyEncrypted) return true;
        break;
      case "local":
        if (row.aiBaseUrl) return true;
        break;
      case "openai-compatible":
        // Presence mirrors `buildCompatProvider`: a gateway needs an address
        // AND a model name; the key is optional.
        if (row.aiCompatBaseUrl && (row.aiCompatModel || row.aiModel)) {
          return true;
        }
        break;
      case "admin-openai":
        if (adminKeyConfigured) return true;
        break;
    }
  }

  // Legacy `resolveProvider()` fallback — only reached when the chain
  // resolves empty. Mirrors buildUserProvider → codex → admin in order.
  const choice = row.aiProvider?.toUpperCase();
  if (choice === "ANTHROPIC" && row.aiAnthropicKeyEncrypted) return true;
  if (choice === "LOCAL" && row.aiBaseUrl) return true;
  if (
    choice === "OPENAI_COMPATIBLE" &&
    row.aiCompatBaseUrl &&
    (row.aiCompatModel || row.aiModel)
  ) {
    return true;
  }
  if (choice === "OPENAI" && row.aiOpenaiKeyEncrypted) return true;
  if ((choice === "CHATGPT_OAUTH" || !choice) && codexConnected) return true;
  return adminKeyConfigured;
}

/**
 * Whether any provider could serve text for this record: the presence probe,
 * as a boolean. Used by read paths that only need to know whether a generation
 * could ever produce provider-backed text (e.g. the dashboard snapshot's
 * `briefingState: "no-provider"`).
 */
export async function hasAnyConfiguredProvider(
  userId: string,
): Promise<boolean> {
  return probeProviderPresence(userId, "text");
}

/**
 * Presence-only check that the operator's central Codex is connected, over an
 * already-loaded `AppSettings` subset. No decrypt, no network.
 */
function appSettingsCentralCodexConnected(
  settings: {
    adminCodexConnectionStatus: string | null;
    adminCodexAccessTokenEncrypted: string | null;
    adminCodexRefreshTokenEncrypted: string | null;
    adminCodexAccountIdEncrypted: string | null;
  } | null,
): boolean {
  return (
    settings?.adminCodexConnectionStatus === "connected" &&
    !!settings.adminCodexAccessTokenEncrypted &&
    !!settings.adminCodexRefreshTokenEncrypted &&
    !!settings.adminCodexAccountIdEncrypted
  );
}

/**
 * Origin of the provider that would serve a given user, surfaced to
 * clients that need to show or hide an AI surface (the iOS Coach gate).
 *
 *   - "user"   — a personal cloud credential resolves (Codex OAuth, or a
 *                BYO OpenAI / Anthropic key).
 *   - "local"  — a per-user self-hosted base URL (Ollama / LM Studio).
 *   - "server" — no personal config, but the operator's admin-managed
 *                key serves the user. This is the case iOS #24 missed:
 *                the Coach works server-side yet the client saw `null`.
 *   - null     — nothing configured anywhere; no provider can serve.
 *
 * Presence-only, mirroring `userRowHasProviderCredential`: it never
 * decrypts a key, builds a client, or probes liveness.
 */
export type ProviderManagedBy = "user" | "local" | "server";

function resolveManagedByFromRow(
  row: ProviderCredentialRow,
  adminKeyConfigured: boolean,
  policy: ProviderCredentialPolicy = "personal",
): ProviderManagedBy | null {
  if (policy === "deny") return null;
  if (policy === "operator-default") {
    return adminKeyConfigured ? "server" : null;
  }
  const codexConnected =
    row.codexConnectionStatus === "connected" &&
    !!row.codexAccessTokenEncrypted &&
    !!row.codexRefreshTokenEncrypted;

  const chain = parseProviderChain(row.aiProviderChain ?? null).filter(
    (e) => e.enabled,
  );
  for (const entry of chain) {
    switch (entry.providerType) {
      case "codex":
        if (codexConnected) return "user";
        break;
      case "openai":
        if (row.aiOpenaiKeyEncrypted) return "user";
        break;
      case "anthropic":
        if (row.aiAnthropicKeyEncrypted) return "user";
        break;
      case "local":
        if (row.aiBaseUrl) return "local";
        break;
      case "openai-compatible":
        // The gateway is the user's own egress to an endpoint they chose,
        // like a BYO key — not the operator's, and not presumed on-host
        // (LiteLLM / OpenRouter are usually remote).
        if (row.aiCompatBaseUrl && (row.aiCompatModel || row.aiModel)) {
          return "user";
        }
        break;
      case "admin-openai":
        if (adminKeyConfigured) return "server";
        break;
    }
  }

  // Legacy `resolveProvider()` fallback — only reached when the chain
  // resolves empty. Mirrors buildUserProvider → codex → admin in order.
  const choice = row.aiProvider?.toUpperCase();
  if (choice === "ANTHROPIC" && row.aiAnthropicKeyEncrypted) return "user";
  if (choice === "LOCAL" && row.aiBaseUrl) return "local";
  if (
    choice === "OPENAI_COMPATIBLE" &&
    row.aiCompatBaseUrl &&
    (row.aiCompatModel || row.aiModel)
  ) {
    return "user";
  }
  if (choice === "OPENAI" && row.aiOpenaiKeyEncrypted) return "user";
  if ((choice === "CHATGPT_OAUTH" || !choice) && codexConnected) return "user";
  return adminKeyConfigured ? "server" : null;
}

/**
 * Effective AI availability for a user: whether any provider can serve
 * them, and which origin manages it. The presence probe, projected; feeds the
 * `GET /api/user/ai-provider` response so the iOS Coach surfaces even when the
 * operator's admin-managed key is the only thing configured.
 */
export async function resolveProviderAvailability(
  userId: string,
): Promise<{ aiAvailable: boolean; managedBy: ProviderManagedBy | null }> {
  const presence = await probeProviderChain(userId);
  return presence.entries.length > 0
    ? { aiAvailable: true, managedBy: presence.managedBy }
    : { aiAvailable: false, managedBy: null };
}

// ── The one presence definition ────────────────────────────────────────────

/** The credential-presence columns the probe reads off the record's row. */
const PRESENCE_USER_SELECT = {
  aiProvider: true,
  aiProviderChain: true,
  aiAnthropicKeyEncrypted: true,
  aiLocalKeyEncrypted: true,
  aiOpenaiKeyEncrypted: true,
  aiBaseUrl: true,
  aiCompatBaseUrl: true,
  aiCompatModel: true,
  aiModel: true,
  codexConnectionStatus: true,
  codexAccessTokenEncrypted: true,
  codexRefreshTokenEncrypted: true,
  useCentralCodex: true,
  managedProfileAt: true,
  labsLocalOcrEnabled: true,
  aiResponseTimeoutSeconds: true,
} as const;

const PRESENCE_SETTINGS_SELECT = {
  adminAiKeyEncrypted: true,
  adminAiModel: true,
  adminCodexConnectionStatus: true,
  adminCodexAccessTokenEncrypted: true,
  adminCodexRefreshTokenEncrypted: true,
  adminCodexAccountIdEncrypted: true,
} as const;

const NO_PRESENCE: ProviderPresence = Object.freeze({
  entries: [],
  localOcrEnabled: false,
  managedBy: null,
  availableTypes: [],
});

/**
 * Whether one chain entry's model can read an image. Mirrors the model each
 * entry runs on (`src/lib/labs/ocr-capability.ts`): the Codex paths use the
 * working Codex slug, the operator's slot uses the operator's model, every
 * other entry the person's own.
 */
function entryVision(
  providerType: string,
  userModel: string | null,
  adminModel: string | null,
): boolean {
  const model =
    providerType === "codex" || providerType === "admin-codex"
      ? resolveCodexVisionSlug()
      : providerType === "admin-openai"
        ? adminModel
        : userModel;
  return supportsVisionForConfig(providerType as VisionProviderType, model);
}

/**
 * The provider chain that would serve a record, presence only: which entries
 * hold a usable credential, in the order a chain run would try them, whether
 * each can read an image, the person's in-browser OCR opt-in, and where the
 * serving credential comes from.
 *
 * This is the ONE definition of "is a provider configured". It never decrypts
 * a key, builds a client, refreshes a Codex token or touches the network, so a
 * `true` can still meet a dead key at call time; the generation path reports
 * that as a failed generation. It follows the chain resolution
 * (`resolveProviderChain`) entry by entry, appends the operator's central
 * Codex only behind the person's opt-in, falls back to the legacy single
 * provider only for a chain that resolves empty, and applies the credential
 * policy of the provider-work authority: a delegate's chain is empty and a
 * guardian's is the operator's key alone.
 *
 * Memoised per request and record, so the account payload, a capability gate
 * and a presence read on one request share two point reads.
 */
export function probeProviderChain(
  recordId: string,
  authority: ProviderWorkAuthority | null = providerWorkAuthorityForRecord(
    recordId,
  ),
): Promise<ProviderPresence> {
  const basePolicy = providerCredentialPolicy(authority);
  if (basePolicy === "deny") return Promise.resolve(NO_PRESENCE);
  return memoizePerRequest(
    `provider-presence:${recordId}:${authority?.origin ?? "none"}`,
    async () => {
      const [row, settings] = await Promise.all([
        prisma.user.findUnique({
          where: { id: recordId },
          select: PRESENCE_USER_SELECT,
        }),
        prisma.appSettings.findUnique({
          where: { id: "singleton" },
          select: PRESENCE_SETTINGS_SELECT,
        }),
      ]);
      if (!row) return NO_PRESENCE;
      const policy = providerCredentialPolicy(authority, row.managedProfileAt);
      const adminKey = !!settings?.adminAiKeyEncrypted;
      const adminModel = settings?.adminAiModel ?? null;
      const vision = (providerType: string): ProviderEntryPresence => ({
        providerType,
        vision: entryVision(providerType, row.aiModel, adminModel),
      });

      if (policy === "deny") return NO_PRESENCE;
      if (policy === "operator-default") {
        return {
          entries: adminKey ? [vision("admin-openai")] : [],
          // A guardian's in-browser OCR is not the record's opt-in to use.
          localOcrEnabled: false,
          managedBy: adminKey ? "server" : null,
          availableTypes: adminKey ? ["admin-openai"] : [],
          responseTimeoutSeconds: row.aiResponseTimeoutSeconds,
        };
      }

      const codexConnected =
        row.codexConnectionStatus === "connected" &&
        !!row.codexAccessTokenEncrypted &&
        !!row.codexRefreshTokenEncrypted;
      const credentialPresent = (providerType: ProviderChainType): boolean => {
        switch (providerType) {
          case "codex":
            return codexConnected;
          case "openai":
            return !!row.aiOpenaiKeyEncrypted;
          case "anthropic":
            return !!row.aiAnthropicKeyEncrypted;
          case "local":
            return !!row.aiBaseUrl;
          case "openai-compatible":
            return !!(
              row.aiCompatBaseUrl &&
              (row.aiCompatModel || row.aiModel)
            );
          case "admin-openai":
            return adminKey;
          default:
            // `admin-codex` is never resolved from a stored chain entry.
            return false;
        }
      };
      const centralCodex =
        row.useCentralCodex && appSettingsCentralCodexConnected(settings);
      const entries: ProviderEntryPresence[] = [];
      for (const entry of parseProviderChain(row.aiProviderChain ?? null)) {
        if (!entry.enabled) continue;
        if (credentialPresent(entry.providerType)) {
          entries.push(vision(entry.providerType));
        }
      }
      if (centralCodex) {
        entries.push(vision("admin-codex"));
      }
      const availableTypes: string[] = PROVIDER_CHAIN_TYPES.filter((type) =>
        type === "admin-codex" ? centralCodex : credentialPresent(type),
      );
      if (entries.length === 0 && userRowHasProviderCredential(row, adminKey)) {
        // The legacy single-provider fallback, tagged as the operator's slot
        // the way every consumer of it tags it (the consent gate included).
        entries.push(vision("admin-openai"));
      }

      let managedBy = resolveManagedByFromRow(row, adminKey, policy);
      if (
        managedBy === null &&
        row.useCentralCodex &&
        appSettingsCentralCodexConnected(settings)
      ) {
        managedBy = "server";
      }
      return {
        entries,
        localOcrEnabled: row.labsLocalOcrEnabled,
        managedBy: entries.length > 0 ? managedBy : null,
        availableTypes,
        responseTimeoutSeconds: row.aiResponseTimeoutSeconds,
      };
    },
    { freshInBackground: true },
  );
}

/**
 * Whether any configured provider could serve this modality for the record.
 * `text` needs any entry; `document` needs one that reads images, or a text
 * entry the person's in-browser OCR feeds.
 */
export async function probeProviderPresence(
  recordId: string,
  modality: AiModality = "text",
): Promise<boolean> {
  const presence = await probeProviderChain(recordId);
  if (modality === "text") return presence.entries.length > 0;
  return (
    presence.entries.some((entry) => entry.vision) ||
    (presence.localOcrEnabled && presence.entries.length > 0)
  );
}

/**
 * Materialise a single chain entry. Returns null when the user lacks
 * the matching credential — the chain runner skips null entries.
 */
async function resolveProviderForType(
  providerType: ProviderChainType,
  ctx: {
    userId: string;
    userRow: {
      aiAnthropicKeyEncrypted: string | null;
      aiLocalKeyEncrypted: string | null;
      aiOpenaiKeyEncrypted: string | null;
      aiBaseUrl: string | null;
      aiModel: string | null;
      aiCompatBaseUrl: string | null;
      aiCompatKeyEncrypted: string | null;
      aiCompatModel: string | null;
      role: string;
    } | null;
    policy: ProviderCredentialPolicy;
  },
): Promise<AIProvider | null> {
  if (ctx.policy === "deny") return null;
  if (ctx.policy === "operator-default") {
    return providerType === "admin-openai"
      ? await resolveAdminProvider()
      : null;
  }
  switch (providerType) {
    case "codex": {
      return resolveCodexProvider(ctx.userId);
    }
    case "openai": {
      const enc = ctx.userRow?.aiOpenaiKeyEncrypted;
      if (!enc) return null;
      return new OpenAIClient({
        apiKey: decrypt(enc),
        model: ctx.userRow?.aiModel ?? "gpt-4o",
        baseUrl: "https://api.openai.com/v1",
      });
    }
    case "anthropic": {
      const enc = ctx.userRow?.aiAnthropicKeyEncrypted;
      if (!enc) return null;
      return new AnthropicClient({
        apiKey: decrypt(enc),
        model: ctx.userRow?.aiModel ?? "claude-sonnet-4-6",
      });
    }
    case "local": {
      if (!ctx.userRow?.aiBaseUrl) return null;
      return new LocalOpenAICompatibleClient({
        apiKey: ctx.userRow.aiLocalKeyEncrypted
          ? decrypt(ctx.userRow.aiLocalKeyEncrypted)
          : null,
        model: ctx.userRow.aiModel ?? "local-model",
        baseUrl: ctx.userRow.aiBaseUrl,
        operatorTrusted: isOperatorOwned(ctx.userRow),
      });
    }
    case "openai-compatible": {
      // v1.33.1 (#470) — the user's gateway. Note what is NOT read here:
      // `aiOpenaiKeyEncrypted` and `aiBaseUrl`. The gateway gets the
      // credential the user issued for it, or none at all.
      if (!ctx.userRow) return null;
      return buildCompatProvider(ctx.userRow);
    }
    case "admin-openai": {
      const admin = await resolveAdminProvider();
      return admin.type === "none" ? null : admin;
    }
    case "admin-codex":
      // Never resolved from a persisted chain entry — the operator-shared
      // central Codex is appended in `resolveProviderChain` ONLY behind the
      // per-user `useCentralCodex` opt-in. Returning null here keeps a
      // hand-crafted `admin-codex` chain entry from bypassing that gate.
      return null;
    default:
      return null;
  }
}

/**
 * Override that the connection-test endpoint accepts so the user can
 * verify a provider config they have NOT saved yet (dropdown change → test
 * before commit). Plaintext keys never persist.
 */
export type AITestOverride = {
  provider?: string | null;
  model?: string | null;
  baseUrl?: string | null;
  anthropicKey?: string | null;
  localKey?: string | null;
  openaiKey?: string | null;
  // v1.33.1 (#470) — the gateway's own fields. Dedicated rather than shared
  // with `baseUrl` / `openaiKey` for the same reason the columns are: the
  // pinned OpenAI arm must not be able to see a user-supplied host, and the
  // gateway must not be able to see the OpenAI key.
  compatBaseUrl?: string | null;
  compatKey?: string | null;
  compatModel?: string | null;
};

export class AITestConfigError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AITestConfigError";
    this.status = status;
  }
}

/**
 * Resolve the provider for `/api/ai/test`. Falls back to the persisted user
 * config when the matching override field is empty, so a user with a stored
 * Anthropic key can change the model in the dropdown and test it without
 * re-typing the key. The base URL still goes through the SSRF guard.
 */
export async function resolveProviderForTest(
  userId: string,
  override: AITestOverride = {},
): Promise<AIProvider> {
  // The test runs under the same timeout generation would, so a slow local
  // model that needs a raised setting is not reported as dead by the test.
  // The same holds for the entry's reasoning effort (#1126): a thinking model
  // that only answers with reasoning switched off must test green with it off.
  const provider = await resolveProviderForTestUnbound(userId, override);
  const settings = await readBoundSettings(userId);
  return bindReasoningEffort(
    bindResponseTimeout(provider, settings.aiResponseTimeoutSeconds),
    settings.aiProviderChain,
  );
}

async function resolveProviderForTestUnbound(
  userId: string,
  override: AITestOverride,
): Promise<AIProvider> {
  const stored = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      aiProvider: true,
      aiModel: true,
      aiBaseUrl: true,
      aiAnthropicKeyEncrypted: true,
      aiLocalKeyEncrypted: true,
      aiOpenaiKeyEncrypted: true,
      aiCompatBaseUrl: true,
      aiCompatKeyEncrypted: true,
      aiCompatModel: true,
      role: true,
    },
  });
  // v1.39.3 — an unsaved override is tested under the same owner rule as a
  // saved one: it belongs to the calling account.
  const owner = { operatorTrusted: isOperatorOwned(stored) };

  const provider = (override.provider ?? stored?.aiProvider ?? "")
    .toString()
    .trim()
    .toUpperCase();
  const model = (override.model ?? stored?.aiModel ?? "").toString().trim();
  const baseUrl = (override.baseUrl ?? stored?.aiBaseUrl ?? "")
    .toString()
    .trim();

  // Empty selection ("test my saved config" — the ai-section calls
  // /api/ai/test with an empty body): resolve via the SAME path generation
  // uses — the first enabled+credentialed entry of `resolveProviderChain`.
  // The legacy codex→admin fallback used to probe a different provider than
  // generation ran (observed: test→admin-key while generation→codex), so a
  // green test gave no signal about whether overnight generation would
  // work. Falling through to the chain keeps the two paths in lock-step.
  if (!provider) {
    const chain = await resolveProviderChain(userId);
    if (chain.length > 0) return chain[0].instance;
    // Chain empty (no enabled+credentialed entry) — mirror the regular
    // single-provider resolution one more time before giving up.
    const legacy = await resolveProvider(userId);
    if (legacy.type !== "none") return legacy;
    throw new AITestConfigError(422, "No AI provider configured");
  }

  switch (provider) {
    case "ANTHROPIC": {
      const apiKey =
        override.anthropicKey?.trim() ||
        (stored?.aiAnthropicKeyEncrypted
          ? decrypt(stored.aiAnthropicKeyEncrypted)
          : "");
      if (!apiKey) {
        throw new AITestConfigError(422, "Anthropic API key not configured");
      }
      // Anthropic has no UI base-URL input. Ignore the merged value to
      // avoid leaking the key to a stale LOCAL URL still parked in the
      // shared column.
      return new AnthropicClient({
        apiKey,
        model: model || "claude-sonnet-4-6",
      });
    }
    case "LOCAL": {
      if (!baseUrl) {
        throw new AITestConfigError(422, "Local provider requires a base URL");
      }
      // A private host only when the operator granted its origin
      // (`AI_PRIVATE_ORIGINS` or the legacy host list; v1.39.3).
      const allowPrivate = isLocalAiHostAllowed(baseUrl, owner);
      if (!allowPrivate && !isPublicUrl(baseUrl)) {
        throw new AITestConfigError(
          422,
          "Base URL points to an internal/private host",
        );
      }
      const apiKey =
        override.localKey?.trim() ||
        (stored?.aiLocalKeyEncrypted
          ? decrypt(stored.aiLocalKeyEncrypted)
          : null);
      return new LocalOpenAICompatibleClient({
        apiKey,
        model: model || "local-model",
        baseUrl,
        ...owner,
      });
    }
    case "OPENAI_COMPATIBLE": {
      // v1.33.1 (#470) — the gateway. Reads `aiCompatBaseUrl`, never the
      // merged `baseUrl` above (which can carry a stale LOCAL URL) and never
      // the OpenAI key. Same host policy as LOCAL: public always, private
      // only when the operator allowlisted it.
      const compatBaseUrl = (
        override.compatBaseUrl ??
        stored?.aiCompatBaseUrl ??
        ""
      )
        .toString()
        .trim();
      if (!compatBaseUrl) {
        throw new AITestConfigError(
          422,
          "OpenAI-compatible provider requires a base URL",
        );
      }
      if (
        !isLocalAiHostAllowed(compatBaseUrl, owner) &&
        !isPublicUrl(compatBaseUrl)
      ) {
        throw new AITestConfigError(
          422,
          "Base URL points to an internal/private host",
        );
      }
      const compatModel =
        (override.compatModel ?? stored?.aiCompatModel ?? "")
          .toString()
          .trim() || model;
      if (!compatModel) {
        throw new AITestConfigError(
          422,
          "OpenAI-compatible provider requires a model name",
        );
      }
      const apiKey =
        override.compatKey?.trim() ||
        (stored?.aiCompatKeyEncrypted
          ? decrypt(stored.aiCompatKeyEncrypted)
          : "");
      return new OpenAIClient({
        apiKey,
        model: compatModel,
        baseUrl: compatBaseUrl,
        providerType: "openai-compatible",
        ...owner,
      });
    }
    case "CHATGPT_OAUTH": {
      const codex = await resolveCodexProvider(userId);
      if (codex) return codex;
      throw new AITestConfigError(422, "ChatGPT OAuth is not connected");
    }
    case "OPENAI": {
      // Test path mirrors the persistent resolution: user key first,
      // admin fallback if absent. We accept an `openaiKey` override
      // from the test endpoint so a user can verify a not-yet-saved
      // key dropdown change without persisting anything. Always use
      // the canonical OpenAI base URL — the merged `baseUrl` may carry
      // a stale LOCAL URL through `stored.aiBaseUrl`.
      const userKey =
        override.openaiKey?.trim() ||
        (stored?.aiOpenaiKeyEncrypted
          ? decrypt(stored.aiOpenaiKeyEncrypted)
          : "");
      if (userKey) {
        return new OpenAIClient({
          apiKey: userKey,
          model: model || "gpt-4o",
          baseUrl: "https://api.openai.com/v1",
        });
      }
      const admin = await resolveAdminProvider();
      if (admin.type === "none") {
        throw new AITestConfigError(
          422,
          "OpenAI key not configured (neither user nor admin)",
        );
      }
      return admin;
    }
    default:
      throw new AITestConfigError(422, `Unknown provider: ${provider}`);
  }
}
