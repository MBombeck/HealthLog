/**
 * The OAuth providers a guardian may connect for a managed profile, and the
 * route parameter that names one.
 *
 * Every kit provider qualifies. Nightscout and Dawarich are not OAuth flows.
 */
import type { OAuthKitProvider } from "./token";

export const MANAGED_OAUTH_PROVIDERS = [
  "withings",
  "whoop",
  "oura",
  "polar",
  "strava",
  "google-health",
] as const satisfies readonly OAuthKitProvider[];

export type ManagedOAuthProvider = (typeof MANAGED_OAUTH_PROVIDERS)[number];

export function isManagedOAuthProvider(
  value: string,
): value is ManagedOAuthProvider {
  return (MANAGED_OAUTH_PROVIDERS as readonly string[]).includes(value);
}
