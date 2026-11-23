/**
 * Scanner probes, answered by the proxy before Next renders anything.
 *
 * Paths like `/.env`, `/.git/config` or `/wp-login.php` are asked for only by
 * scanners: no version of this app ever served one. Left to Next, each
 * rendered the full root layout into a 57 KB not-found page, and a scan is
 * hundreds of them in a row inside the server's heap ceiling.
 */
import { NextResponse } from "next/server";

import { setBaselineSecurityHeaders } from "@/lib/http/proxy-bypass-routes";

/**
 * Dotfile paths a deploy must never serve (the public `.well-known`
 * directory excepted), and the script extensions and CMS paths of software
 * this app is not.
 */
const SCANNER_PROBE =
  /^\/(?:\.(?!well-known(?:\/|$))[^/]*|wp-(?:admin|content|includes|login)\b|xmlrpc\b|cgi-bin\b|phpmyadmin\b)|\.(?:php\d?|aspx?|jsp|cgi|env|ini|bak|sql)$/i;

export function isScannerProbe(pathname: string): boolean {
  return SCANNER_PROBE.test(pathname);
}

/** A plain 404 of a few bytes, with the baseline security headers. */
export function scannerProbeResponse(): NextResponse {
  const response = new NextResponse("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
  setBaselineSecurityHeaders(response.headers);
  return response;
}
