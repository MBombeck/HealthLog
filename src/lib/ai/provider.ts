import type { AIProvider, CompletionParams, CompletionResult } from "./types";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { CodexClient } from "./codex-client";
import { OpenAIClient } from "./openai-client";
import { AnthropicClient } from "./anthropic-client";
import { LocalOpenAICompatibleClient } from "./local-client";
import {
  refreshAccessToken,
  encryptTokens,
  decryptTokens,
} from "./codex-oauth";
import { isPublicUrl } from "@/lib/validations/notifications";

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

class NoProvider implements AIProvider {
  readonly type = "none" as const;

  async generateCompletion(
    _params: CompletionParams,
  ): Promise<CompletionResult> {
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
  // legacy admin-key fallback (OpenAI uses adminAiKeyEncrypted via app_settings)
  // We store user-level OpenAI key in aiAnthropicKeyEncrypted? No — for OPENAI
  // selection at user-level we read app-settings admin key. The user override
  // for OpenAI is intentionally minimal: provider+model+baseUrl. Personal keys
  // are scoped to Anthropic/Local for now (matches the migration columns).
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
      return new AnthropicClient({
        apiKey: decrypt(row.aiAnthropicKeyEncrypted),
        model: row.aiModel ?? "claude-3-5-sonnet-latest",
        baseUrl: row.aiBaseUrl ?? undefined,
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
    case "OPENAI":
      // User selected OPENAI but personal keys live in admin app_settings;
      // signal "use admin OpenAI" by returning null and letting caller fall
      // through to resolveAdminProvider().
      return null;
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

async function resolveCodexProvider(
  userId: string,
): Promise<AIProvider | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      codexAccessTokenEncrypted: true,
      codexRefreshTokenEncrypted: true,
      codexTokenExpiresAt: true,
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

  const { accessToken, refreshToken } = decryptTokens({
    accessEncrypted: user.codexAccessTokenEncrypted,
    refreshEncrypted: user.codexRefreshTokenEncrypted,
  });

  let currentAccessToken = accessToken;

  // Proactive refresh if token expires within 5 minutes
  const expiresAt = user.codexTokenExpiresAt?.getTime() ?? 0;
  if (expiresAt < Date.now() + TOKEN_REFRESH_BUFFER_MS) {
    try {
      const newTokens = await refreshAccessToken(refreshToken);
      currentAccessToken = newTokens.access_token;

      const encrypted = encryptTokens({
        accessToken: newTokens.access_token,
        refreshToken: newTokens.refresh_token,
      });

      await prisma.user.update({
        where: { id: userId },
        data: {
          codexAccessTokenEncrypted: encrypted.accessEncrypted,
          codexRefreshTokenEncrypted: encrypted.refreshEncrypted,
          codexTokenExpiresAt: new Date(
            Date.now() + newTokens.expires_in * 1000,
          ),
        },
      });
    } catch {
      // If proactive refresh fails, still try with current token
      // CodexClient will retry via onTokenRefresh on 401
    }
  }

  return new CodexClient({
    accessToken: currentAccessToken,
    onTokenRefresh: async () => {
      const freshUser = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          codexRefreshTokenEncrypted: true,
        },
      });

      if (!freshUser?.codexRefreshTokenEncrypted) {
        throw new Error("No refresh token available");
      }

      const currentRefreshToken = decrypt(freshUser.codexRefreshTokenEncrypted);

      const newTokens = await refreshAccessToken(currentRefreshToken);
      const encrypted = encryptTokens({
        accessToken: newTokens.access_token,
        refreshToken: newTokens.refresh_token,
      });

      await prisma.user.update({
        where: { id: userId },
        data: {
          codexAccessTokenEncrypted: encrypted.accessEncrypted,
          codexRefreshTokenEncrypted: encrypted.refreshEncrypted,
          codexTokenExpiresAt: new Date(
            Date.now() + newTokens.expires_in * 1000,
          ),
        },
      });

      return newTokens.access_token;
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
      return new AnthropicClient({
        apiKey,
        model: model || "claude-3-5-sonnet-latest",
        baseUrl: baseUrl || undefined,
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
      const admin = await resolveAdminProvider();
      if (admin.type === "none") {
        throw new AITestConfigError(
          422,
          "Admin OpenAI key is not configured for this instance",
        );
      }
      return admin;
    }
    default:
      throw new AITestConfigError(422, `Unknown provider: ${provider}`);
  }
}
