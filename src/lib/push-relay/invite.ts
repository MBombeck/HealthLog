/**
 * The relay's one-time invite code (`POST /v1/instances` `invite`): while the
 * relay accepts new servers by invitation only, the operator enters the code
 * its operator handed out. Exactly 24 base64url characters.
 *
 * The code rides the one registration attempt made while the operator waits
 * (`enableRelay`) and is never stored: a refused or failed attempt needs the
 * code again. The relay spends it only when the registration succeeds.
 */
import { z } from "zod/v4";

export const relayInviteSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{24}$/, "Expected 24 base64url characters");

/**
 * Registration refusals the minute pass does not retry on its own: the relay
 * wants an invite code (`invite_required`), or refused the one entered
 * (`invite_rejected`, the relay's `invite_required` to a request that carried
 * a code: unknown, expired or already used). Only the operator can move these
 * on, by entering a code.
 */
export const OPERATOR_ACTION_REASONS: ReadonlySet<string> = new Set([
  "invite_required",
  "invite_rejected",
]);
