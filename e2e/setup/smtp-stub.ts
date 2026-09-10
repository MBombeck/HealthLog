/**
 * A local SMTP responder, and the reason the notification journey needs one.
 *
 * Every user-configurable DELIVERY channel in this product refuses a local
 * destination on purpose. ntfy and the generic webhook take their URL from the
 * account, so the URL passes `isPublicUrl()` at save time and the send goes
 * through `safeFetch({ requirePublicHost: true })`, which pins the resolved
 * address at connect time; loopback, RFC1918 and every alternate notation are
 * refused at both ends. Web Push is the same shape one layer down — the
 * subscription endpoint is checked before the dial. Telegram and APNs address
 * hard-coded third parties. So none of them can be pointed at a stub, and
 * faking one would prove the fixture rather than the dispatcher.
 *
 * Email is the exception, and not by oversight: its transport is OPERATOR
 * configuration (`SMTP_HOST` / `SMTP_PORT` / `SMTP_FROM`), never account
 * input, so it never crosses the SSRF floor that guards the account-supplied
 * hosts. That makes it the one channel a self-hoster — and this suite — can
 * exercise end to end on one machine, through the real sender, the real
 * transport and the real `push_attempts` ledger write.
 *
 * The responder below speaks the minimum of RFC 5321 that nodemailer needs:
 * a greeting, EHLO with no advertised extensions (so nodemailer neither
 * pipelines nor tries STARTTLS), the envelope commands, and DATA. It stores
 * nothing but the envelope recipients, which is all the journey reads back.
 */
import { createServer, type Server, type Socket } from "node:net";

/**
 * Port the stub listens on, and the port `playwright.config.ts` hands the app
 * server as `SMTP_PORT`.
 *
 * It cannot be an OS-assigned port-0 binding: the config has to put `SMTP_PORT`
 * into the web server's environment before any worker process exists, and the
 * stub itself does not start until the spec's `beforeAll` — so by the time a
 * kernel-assigned port would be known, the server it has to reach is already
 * running. The port is therefore CHOSEN once per run, at config load, from the
 * IANA dynamic range, and published through `SMTP_STUB_PORT` in the
 * environment so the config, the server and the spec all read the one value.
 * Two suites on one machine draw different numbers instead of colliding on a
 * constant, and a collision that does happen fails by name in `listen` below
 * rather than as a missing form field thirty lines into a test.
 *
 * An operator pinning it by hand (`SMTP_STUB_PORT=3925 pnpm e2e`) wins, which
 * is what makes an externally started server — `E2E_SKIP_WEB_SERVER=1` — able
 * to carry the same value.
 */
export function resolveSmtpStubPort(): number {
  const pinned = Number(process.env.SMTP_STUB_PORT);
  if (Number.isInteger(pinned) && pinned > 0 && pinned < 65_536) return pinned;
  // 49152–65535, the dynamic/private range no registered service claims.
  const chosen = 49_152 + Math.floor(Math.random() * (65_536 - 49_152));
  process.env.SMTP_STUB_PORT = String(chosen);
  return chosen;
}

export const SMTP_STUB_HOST = "127.0.0.1";

/** The envelope sender the app is configured with (`SMTP_FROM`). */
export const SMTP_STUB_FROM = "healthlog-e2e@healthlog.test";

export interface SmtpStub {
  /** The port this responder bound, which is the one the app was handed. */
  readonly port: number;
  /** Envelope recipients of every message the stub accepted, oldest first. */
  accepted(): readonly string[];
  /** Forget everything accepted so far. */
  reset(): void;
  close(): Promise<void>;
}

const CRLF = "\r\n";

/** Start the responder and resolve once it is accepting connections. */
export async function startSmtpStub(): Promise<SmtpStub> {
  const accepted: string[] = [];
  const port = resolveSmtpStubPort();
  // Every established socket, so `close()` can end them. `server.close()`
  // resolves only once the last connection is gone and never ends one itself,
  // so a socket abandoned mid-DATA by a timed-out test would otherwise hold
  // teardown open until Playwright's own timeout fires over it.
  const open = new Set<Socket>();

  const server: Server = createServer((socket: Socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    let buffer = "";
    let inData = false;
    let envelope: string[] = [];

    const say = (line: string): void => {
      socket.write(`${line}${CRLF}`);
    };

    socket.setEncoding("utf8");
    say("220 healthlog-e2e-smtp ready");

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf(CRLF);
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + CRLF.length);

        if (inData) {
          // A bare "." on its own line ends the message body.
          if (line === ".") {
            inData = false;
            accepted.push(...envelope);
            envelope = [];
            say("250 2.0.0 Ok: queued");
          }
        } else {
          const verb = line.slice(0, 4).toUpperCase();
          if (verb === "EHLO" || verb === "HELO") {
            // Single-line, no extensions: nodemailer then sends one command
            // at a time and never attempts STARTTLS or AUTH.
            say("250 healthlog-e2e-smtp");
          } else if (verb === "MAIL") {
            say("250 2.1.0 Ok");
          } else if (verb === "RCPT") {
            const match = /<([^>]*)>/.exec(line);
            if (match) envelope.push(match[1]);
            say("250 2.1.5 Ok");
          } else if (verb === "DATA") {
            inData = true;
            say("354 End data with <CR><LF>.<CR><LF>");
          } else if (verb === "QUIT") {
            say("221 2.0.0 Bye");
            socket.end();
          } else if (verb === "RSET") {
            envelope = [];
            say("250 2.0.0 Ok");
          } else {
            say("250 2.0.0 Ok");
          }
        }

        index = buffer.indexOf(CRLF);
      }
    });

    // A client that vanishes mid-exchange is not this stub's problem, and an
    // unhandled 'error' on a socket would take the whole runner down.
    socket.on("error", () => socket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      // The one failure worth naming. A crashed prior run, a second suite, or
      // a hand-pinned port already in use all arrive here, and the bare
      // `EADDRINUSE` that used to propagate took the whole `beforeAll` down
      // with a message that named neither the port nor the stub.
      reject(
        err.code === "EADDRINUSE"
          ? new Error(
              `[smtp-stub] port ${port} on ${SMTP_STUB_HOST} is already in use — ` +
                "another run's responder is still listening, or SMTP_STUB_PORT " +
                "was pinned to a port something else holds. Free it, or unset " +
                "SMTP_STUB_PORT to draw a fresh one.",
              { cause: err },
            )
          : err,
      );
    });
    server.listen(port, SMTP_STUB_HOST, () => {
      server.removeAllListeners("error");
      resolve();
    });
  });

  return {
    port,
    accepted: () => accepted,
    reset: () => {
      accepted.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        open.clear();
        server.close(() => resolve());
      }),
  };
}
