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
 * server as `SMTP_PORT`. Named here so the config and the spec cannot drift.
 */
export const SMTP_STUB_PORT = 3925;

export const SMTP_STUB_HOST = "127.0.0.1";

/** The envelope sender the app is configured with (`SMTP_FROM`). */
export const SMTP_STUB_FROM = "healthlog-e2e@healthlog.test";

export interface SmtpStub {
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

  const server: Server = createServer((socket: Socket) => {
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
    server.once("error", reject);
    server.listen(SMTP_STUB_PORT, SMTP_STUB_HOST, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  return {
    accepted: () => accepted,
    reset: () => {
      accepted.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
