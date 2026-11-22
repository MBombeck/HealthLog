/**
 * The read-only emergency card behind a wallet card's QR code.
 *
 * A first responder scans the code with any phone: no session, no app. The
 * `hlm_` token in the path is the only credential, resolved through
 * `readEmergencyCardByToken` (rate limit before the lookup, HMAC lookup, the
 * revocation and expiry, the owner and the operator switch, an audit row on
 * the owner's trail).
 *
 * A route, not a page, on purpose. A page renders under the root layout and
 * its loading boundary, so the status line is sent before the lookup ends and
 * a miss could only ever be a 200 with a "not found" body; it also brings the
 * app shell, which registers a service worker on the stranger's phone and
 * paints the app's stored theme rather than the phone's. This answers one
 * self-contained document instead (the same one the owner saves as the
 * offline copy): inline styles, no script, colours from the phone's own light
 * or dark setting. Every miss is the same document with a real 404, and
 * nothing is ever cached (`no-store` here and at the edge; the service worker
 * keeps `/e/*` out of its page cache).
 */
import { apiHandler } from "@/lib/api-handler";
import { resolveShareViewLocale } from "@/lib/clinician-share/request-locale";
import {
  buildLinkCardHtml,
  buildLinkMissHtml,
} from "@/lib/emergency-card/offline-html";
import { readEmergencyCardByToken } from "@/lib/emergency-card/serve";
import { urlCredentialHtml } from "@/lib/http/url-credential";
import { getServerTranslator } from "@/lib/i18n/server-translator";

type RouteParams = { params: Promise<{ token: string }> };

export const dynamic = "force-dynamic";

export const GET = apiHandler(
  async (request: Request, { params }: RouteParams) => {
    const { token } = await params;
    const [read, locale] = await Promise.all([
      readEmergencyCardByToken(request, token),
      resolveShareViewLocale(),
    ]);
    const { t } = getServerTranslator(locale);
    const tr = (key: string, vars?: Record<string, string | number>) =>
      t(key, vars);
    if (!read.ok) return urlCredentialHtml(buildLinkMissHtml(tr, locale), 404);
    return urlCredentialHtml(
      buildLinkCardHtml(read.view, tr, locale, read.expiresOn),
      200,
    );
  },
);
