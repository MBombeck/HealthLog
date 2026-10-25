# Reporting a problem

HealthLog does not send anything home, and nobody but the operator can read
an instance's logs. So a bug report has to carry what is needed to find the
fault. Two texts do that, and both are redacted before you see them.

| Who      | Where                                    | What it is                                 |
| -------- | ---------------------------------------- | ------------------------------------------ |
| Everyone | Settings, About, **Copy support info**   | Your app version, settings and connections |
| Operator | Admin, System status, **Support report** | The whole instance, accounts as numbers    |

Add the **error id** of the failure if you have one, and paste both texts into
the [bug report](https://github.com/MBombeck/HealthLog/issues/new?template=bug_report.yml).
Read them before you post. They are built to contain nothing personal, but
you are the one publishing them.

## Error ids

When the server fails (a 5xx answer), the message shows **Error ID** and
eight characters, for example `3f9a2c1b`, with a copy button that copies the
full id. A page that fails to render shows one too when the server has one
to give: the request id of the failed call, or the digest the server printed
beside the stack in its log.

The id is the request id of the failing call. Every error answer of the API
carries it in `meta.requestId` and in the `x-request-id` header. An incoming
`x-request-id` is only adopted when it consists of letters, digits and hyphens
(8 to 64 characters); anything else is replaced with a fresh id.

The operator finds the event under **Admin, App logs** by typing the id (or
its first 8 characters) into **Error ID**. A search by id reads the second log
buffer, which keeps the last 1,000 warnings and errors of the process. Ordinary
traffic cannot push them out, so an error stays findable for much longer than
in the main buffer of 500 events. Both buffers live in memory: a restart
empties them, and a split `web` / `worker` deployment has one per process.

The same search works on the API:

```
GET /api/admin/app-logs?requestId=3f9a2c1b&ring=problems
```

A 4xx answer (a refused input, a missing permission) shows no id. Its message
says what to change.

## Support info (everyone)

**Settings, About, Copy support info** puts together, in your browser:

- server version and build, and your browser;
- language, time zone and the modules you have switched on;
- the AI state: whether a provider is set up, your usage level, and which AI
  features are available and why not;
- for each connected source (Withings, Oura, and so on), its health state,
  reason, last success, newest data and the last recorded sync attempts;
- the last five error ids of this browser session.

It never contains your username, email address, name, server address,
tokens, recorded values or record ids. Nothing is sent anywhere; the text
goes to your clipboard.

## Support report (operator)

**Admin, System status, Support report** creates a text with **Copy** and
**Download**. It is created when you press a button, not on page load, and
shown above the buttons so you can read it first. It contains:

- **Build:** version, build SHA, build time, Node, process type, heap limit,
  uptime.
- **Database:** PostgreSQL version, server time zone, size, last applied
  migration, unfinished migrations.
- **Configuration**, as yes or no only: secure cookie flag, OIDC, OIDC only,
  Loki, GlitchTip, off-host backup, APNs, Web Push, SMTP, GeoLite2, the number
  of `NOTIFICATION_PRIVATE_ORIGINS` entries, operator AI key, central Codex,
  the AI provider types accounts chose, demo mode.
- **Jobs:** whether the worker runs in this process and when it last
  reported, the newest finished job, and every queue with failures in the
  last 72 hours with an error class (`timeout`, `TypeError`, `P2002`,
  `ECONNREFUSED`, an HTTP status), never the message.
- **Connections:** per source, how many accounts are in each health state and
  reason, which accounts are not `ok`, and open watchdog incidents.
- **AI:** the usage level default and ceiling, accounts per usage level, and
  the provider ledger per provider type (working, failing, credential
  refused, paused).
- **Notifications:** per channel, delivered, failed and skipped in the last 7
  days, with the most frequent failure reasons.
- **Backups:** newest in-database copy, the last weekly run, off-host
  freshness, and the last restore drill.
- **Recent warnings and errors:** the 20 most frequent action names in the
  warning and error buffer of this process, with count, last seen and error
  class.

Accounts appear as `Account 1`, `Account 2` and so on, numbered by creation.
The report never contains an email address, a username, an account id, a
recorded value, a token, or the host name of another service. As a second
layer, the finished text is scrubbed for the instance's own usernames,
emails, names and ids, for tokens, URLs, email addresses, ids, IP addresses
and host names before it is shown.

## Logs beyond the report

`docker compose logs app` prints every wide event as one JSON line;
`LOG_LEVEL=debug` adds debug events. With `LOKI_ENDPOINT` set the same events
go to Loki, and GlitchTip (Admin, Integrations, once a DSN is set there)
receives unexpected server errors.
Each line carries `request_id`, so an error id finds its line there too.
