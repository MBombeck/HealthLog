/**
 * The clinician share link's entry, `/c/<hls_token>`.
 *
 * A route, so a link that is unknown, malformed, expired or revoked answers a
 * real 404 (the shared URL-credential miss document) instead of the 200 a page
 * under the root loading boundary sends before its lookup ends. A live link is
 * sent on with a 307 to the page at `/c/<token>/view`, carrying the gate
 * cookie the proxy checks there (`src/lib/clinician-share/view-gate.ts`). The
 * fragment that carries a protected link's passphrase survives the redirect,
 * because a `Location` without a fragment inherits the request's.
 *
 * The lookup is the gate check (`resolveShareGateState`): it bumps no access
 * counter, which the page does on a real record render.
 *
 * The hop carries the time it was made, so the proxy can tell a browser that
 * refused the cookie from a later visit without one; it sends the first back
 * with `?cookies=off`, and a live link then answers a short page saying the
 * link needs cookies, instead of redirecting again.
 */
import { apiHandler } from "@/lib/api-handler";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";
import { resolveShareViewLocale } from "@/lib/clinician-share/request-locale";
import { resolveShareGateState } from "@/lib/clinician-share/resolve-share-token";
import {
  SHARE_VIEW_GATE_COOKIE,
  SHARE_VIEW_GATE_TTL_SECONDS,
  SHARE_VIEW_HOP_PARAM,
  SHARE_VIEW_NO_COOKIE_PARAM,
  SHARE_VIEW_NO_COOKIE_VALUE,
} from "@/lib/clinician-share/view-gate";
import {
  URL_CREDENTIAL_HEADERS,
  urlCredentialMissPage,
  urlCredentialNoticePage,
} from "@/lib/http/url-credential";
import { relativeRedirect } from "@/lib/http/relative-redirect";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { annotate } from "@/lib/logging/context";

type RouteParams = { params: Promise<{ token: string }> };

export const dynamic = "force-dynamic";

export const GET = apiHandler(
  async (request: Request, { params }: RouteParams) => {
    const { token } = await params;
    annotate({ action: { name: "clinician-share.link.open" } });
    const gate = await resolveShareGateState(token);
    if (!gate) {
      annotate({ meta: { url_credential_miss: "share_link" } });
      const locale = await resolveShareViewLocale();
      const { t } = getServerTranslator(locale);
      return urlCredentialMissPage({
        locale,
        title: t("clinicianView.unavailable.title"),
        body: t("clinicianView.unavailable.description"),
      });
    }
    const refused =
      new URL(request.url).searchParams.get(SHARE_VIEW_NO_COOKIE_PARAM) ===
      SHARE_VIEW_NO_COOKIE_VALUE;
    if (refused) {
      annotate({ meta: { share_link_cookies_refused: true } });
      const locale = await resolveShareViewLocale();
      const { t } = getServerTranslator(locale);
      return urlCredentialNoticePage({
        locale,
        title: t("clinicianView.cookiesNeeded.title"),
        body: t("clinicianView.cookiesNeeded.description"),
      });
    }
    const view = `/c/${encodeURIComponent(token)}/view`;
    const response = relativeRedirect(
      `${view}?${SHARE_VIEW_HOP_PARAM}=${Date.now()}`,
    );
    for (const [k, v] of Object.entries(URL_CREDENTIAL_HEADERS)) {
      response.headers.set(k, v);
    }
    response.headers.set("Cache-Control", "no-store");
    response.cookies.set(SHARE_VIEW_GATE_COOKIE, "1", {
      httpOnly: true,
      secure: shouldEmitSecureCookie(),
      sameSite: "lax",
      path: view,
      maxAge: SHARE_VIEW_GATE_TTL_SECONDS,
    });
    return response;
  },
);
