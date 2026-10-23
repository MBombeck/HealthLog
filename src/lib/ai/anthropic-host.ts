/**
 * True when a base URL addresses Anthropic's API: the host itself or any
 * subdomain of `anthropic.com`, case-insensitively. Parsed rather than
 * substring-matched, so `https://anthropic.com.attacker.example/v1` and
 * `https://evil.example/?x=api.anthropic.com` both answer false.
 *
 * An unparseable value answers false and keeps the OpenAI path, which is the
 * behaviour that value had before this function existed.
 */
export function isAnthropicBaseUrl(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "anthropic.com" || host.endsWith(".anthropic.com");
}
