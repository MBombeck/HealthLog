import type { AIProvider, CompletionResult } from "./types";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { CodexClient } from "./codex-client";
import { OpenAIClient } from "./openai-client";
import { AnthropicClient } from "./anthropic-client";
import { LocalOpenAICompatibleClient } from "./local-client";
import {
  refreshDeviceTokens,
  encryptCodexCreds,
  decryptCodexCreds,
} from "./codex-oauth";
import { isPublicUrl } from "@/lib/validations/notifications";
import { parseProviderChain, type ProviderChainType } from "./provider-chain";
import type { ProviderChainResolved } from "./provider-runner";

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
};

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
        model: row.aiModel ?? "claude-3-5-sonnet-latest",
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
      });
    }
    case "OPENAI": {
      // v1.4.3: user-level OpenAI key gets first crack — only fall back
      // to the admin key if the user hasn't supplied their own. The
      // model-default mirrors the admin path for consistency so a saved
      // user "OPENAI" without an explicit model still produces an
      // OpenAIClient with `gpt-4o-mini`.
      // Belt-and-braces: ignore any persisted `aiBaseUrl`. The column is
      // shared with LOCAL, so a stale LAN URL there would otherwise
      // redirect the user's OpenAI key to a private host.
      if (!row.aiOpenaiKeyEncrypted) return null;
      return new OpenAIClient({
        apiKey: decrypt(row.aiOpenaiKeyEncrypted),
        model: row.aiModel ?? "gpt-4o-mini",
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

async function resolveAdminProvider(): Promise<AIProvider> {
  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
  });

  if (settings?.adminAiKeyEncrypted) {
    return new OpenAIClient({
      apiKey: decrypt(settings.adminAiKeyEncrypted),
      model: settings.adminAiModel ?? "gpt-4o-mini",
      baseUrl: settings.adminAiBaseUrl ?? "https://api.openai.com/v1",
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
  const userRow = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      aiProvider: true,
      aiModel: true,
      aiBaseUrl: true,
      aiAnthropicKeyEncrypted: true,
      aiLocalKeyEncrypted: true,
      aiOpenaiKeyEncrypted: true,
    },
  });

  // 1. Per-user Anthropic / Local
  if (userRow) {
    const userProvider = buildUserProvider(userRow);
    if (userProvider) return userProvider;
  }

  // 2. Codex OAuth (either explicitly selected or implicit fallback)
  const explicitChoice = userRow?.aiProvider?.toUpperCase();
  const tryCodex = explicitChoice === "CHATGPT_OAUTH" || !explicitChoice;
  if (tryCodex) {
    const codex = await resolveCodexProvider(userId);
    if (codex) return codex;
  }

  // 3. Admin OpenAI key (also acts as fallback for user-OPENAI selection)
  return resolveAdminProvider();
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
  const userRow = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      aiProvider: true,
      aiModel: true,
      aiBaseUrl: true,
      aiAnthropicKeyEncrypted: true,
      aiLocalKeyEncrypted: true,
      aiOpenaiKeyEncrypted: true,
      aiProviderChain: true,
    },
  });

  const rawChain = userRow?.aiProviderChain ?? null;
  const chain = parseProviderChain(rawChain).filter((e) => e.enabled);

  const resolved: ProviderChainResolved[] = [];
  for (const entry of chain) {
    const instance = await resolveProviderForType(entry.providerType, {
      userId,
      userRow,
    });
    if (instance) {
      resolved.push({ providerType: entry.providerType, instance });
    }
  }
  return resolved;
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
    } | null;
  },
): Promise<AIProvider | null> {
  switch (providerType) {
    case "codex": {
      return resolveCodexProvider(ctx.userId);
    }
    case "openai": {
      const enc = ctx.userRow?.aiOpenaiKeyEncrypted;
      if (!enc) return null;
      return new OpenAIClient({
        apiKey: decrypt(enc),
        model: ctx.userRow?.aiModel ?? "gpt-4o-mini",
        baseUrl: "https://api.openai.com/v1",
      });
    }
    case "anthropic": {
      const enc = ctx.userRow?.aiAnthropicKeyEncrypted;
      if (!enc) return null;
      return new AnthropicClient({
        apiKey: decrypt(enc),
        model: ctx.userRow?.aiModel ?? "claude-3-5-sonnet-latest",
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
      });
    }
    case "admin-openai": {
      const admin = await resolveAdminProvider();
      return admin.type === "none" ? null : admin;
    }
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
  const stored = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      aiProvider: true,
      aiModel: true,
      aiBaseUrl: true,
      aiAnthropicKeyEncrypted: true,
      aiLocalKeyEncrypted: true,
      aiOpenaiKeyEncrypted: true,
    },
  });

  const provider = (override.provider ?? stored?.aiProvider ?? "")
    .toString()
    .trim()
    .toUpperCase();
  const model = (override.model ?? stored?.aiModel ?? "").toString().trim();
  const baseUrl = (override.baseUrl ?? stored?.aiBaseUrl ?? "")
    .toString()
    .trim();

  // Empty selection: fall back to Codex → admin OpenAI like the regular path.
  if (!provider) {
    const codex = await resolveCodexProvider(userId);
    if (codex) return codex;
    return resolveAdminProvider();
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
        model: model || "claude-3-5-sonnet-latest",
      });
    }
    case "LOCAL": {
      if (!baseUrl) {
        throw new AITestConfigError(422, "Local provider requires a base URL");
      }
      const allowPrivate = process.env.ALLOW_LOCAL_AI_PRIVATE_HOSTS === "true";
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
          model: model || "gpt-4o-mini",
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
