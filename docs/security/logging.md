# Logging

What HealthLog records about itself, where each record goes, who can read it,
how long it stays, and which events count as security events. The operator's
part, keeping logs off the host and for how long, is at the end.

## Inventory

| Layer                           | What                                                                            | Where it goes                                                                            | Who can read it                                                                                                                         | Kept                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Wide events                     | One JSON object per HTTP request and per background task (web and worker alike) | stdout, always; Loki when `LOKI_ENDPOINT` is set; an in-memory ring per process          | whoever reads the container's output; admins through Admin, App logs (`/api/admin/app-logs`)                                            | stdout: the operator's log driver. Ring: the last 500 events and the last 1,000 warnings and errors, gone on restart |
| Audit log (`audit_logs`)        | One row per security-relevant or record-changing act                            | the application database                                                                 | admins (Admin, Audit log, `/api/admin/audit-log`); each user sees their own security activity and acts others performed on their record | `AUDIT_LOG_RETENTION_DAYS`, default 365 (job `audit-log-cleanup`, daily)                                             |
| Push attempts (`push_attempts`) | One row per notification delivery attempt: channel, event type, result, reason  | the application database                                                                 | admins (`/api/admin/notifications/diagnostic`, the caller's own rows)                                                                   | 90 days (job `push-attempt-cleanup`)                                                                                 |
| GlitchTip                       | Unhandled server errors (500), client errors relayed by signed-in browsers      | the GlitchTip project named by the DSN in Admin, Monitoring; off until set               | that project's members                                                                                                                  | GlitchTip's own retention                                                                                            |
| CSP reports                     | Browser reports of blocked content                                              | the wide event of `POST /api/monitoring/csp-report` (`csp.violation`); nothing is stored | as wide events                                                                                                                          | as wide events                                                                                                       |
| Host metrics                    | CPU, memory, event-loop lag samples of the process                              | the application database                                                                 | admins                                                                                                                                  | `HOST_METRIC_RETENTION_DAYS`, default 7                                                                              |

There are no log files. Nothing else receives logs: no third-party analytics
(Umami, when an admin configures it, is a page-view counter the operator runs,
proxied through the app, and carries no log data).

## Wide events

Built by `WideEventBuilder` (`src/lib/logging/event-builder.ts`), written by
`src/lib/logging/transports.ts`, shape in `src/lib/logging/types.ts`.

| Group   | Fields                                                                                                                 |
| ------- | ---------------------------------------------------------------------------------------------------------------------- |
| When    | `timestamp` (ISO 8601, UTC), `duration_ms`                                                                             |
| Where   | `service`, `environment`, `deploy` (version, commit, host name), `kind` (http or background)                           |
| Request | `request_id`, `trace_id`, `http.method`, `http.path`, `http.route`, `http.status`, `http.user_agent`, `http.ip`, sizes |
| Who     | `auth.user_id`, `auth.user_role`, `auth.auth_method`, `auth.acting_as` (a delegate acting on another record)           |
| What    | `action.name` (`<surface>.<noun>.<verb>`), `action.entity_type`, `action.entity_id`, `meta`                            |
| Outcome | `level`, `error` (type, code, message, stack), `warnings`, `rate_limit`, `external_calls`, `db` counts                 |

`http.ip` is the client address resolved through the trusted proxy chain
(`getClientIp`, [`self-hosting/reverse-proxy.md`](../self-hosting/reverse-proxy.md)),
unmasked.

**Levels and sampling** (`src/lib/logging/config.ts`, `sampler.ts`). A 4xx
response is logged at `warn`, a 5xx at `error`. Warnings, errors, slow
requests (`LOG_SLOW_THRESHOLD_MS`, default 3000) and every background task are
always kept; `LOG_SAMPLE_RATE` (default 1) only thins fast successful
requests. `LOG_LEVEL` (default `info`) is applied first, so `LOG_LEVEL=error`
also drops the `warn` events that carry refused sign-ins. Keep it at `info` or
`warn`. `LOG_INCLUDE_STACK=false` drops stack traces.

**Encoding.** One `JSON.stringify` per line, so control characters in a value
cannot forge a line.

## What is never logged

Redaction happens once, where an event leaves the process, not at call sites
(`src/lib/logging/redact.ts`, `src/lib/observability/redact-payload.ts`):

- **Credentials**: `Authorization` values, every HealthLog token shape
  (`hlk_`, `hlr_`, `hls_`, `hle_`, `hlv_`, `hlp_`, `hlf_`, `hlm_`, `hlh_`,
  `hlac_`, `hlrt_`, `hlc_`), provider key shapes (`sk-`, bot tokens),
  `ApplePass` headers, and query parameters named like `secret`, `token`,
  `code`, `ticket`, `api_key`, `totp`, `recovery_code`, `passphrase`.
- **Credentials in a path**: the path segment after every route in
  `PATH_SECRET_PATHS` (webhooks, `/c/`, `/e/`, `/claim/`, calendar feeds,
  notification quick answers, the wallet device path) is replaced before
  `http.path` and `http.route` are written.
- **Request bodies**: not logged. The few validation reports that quote part
  of a body pass it through a key denylist first: passwords, tokens, secrets,
  second-factor values, insurance numbers, reproductive-health fields, chat ids;
  free-text `note` fields are cut to an excerpt.
- **Database arguments**: Prisma error messages are stripped of their query
  arguments.
- **Identifiers on failed sign-in**: the typed username or e-mail is stored as
  an HMAC (`identifierHash`), never in clear.
- **Health values**: routes annotate events with ids, counts and action
  names, not with a measurement, a note or a document's content. This is a
  convention held by review and by the central denylist above, not by a
  structural test.

GlitchTip receives the message, the error type, the URL without its query
string and the request id, after the same redaction
(`src/lib/monitoring/glitchtip.ts`); the stack is not sent as frames.

## Audit log

Written through `auditLog(action, …)` (`src/lib/auth/audit.ts`). A row holds
`action`, `userId` (whose record), `actorUserId` (who did it, when that is
somebody else), `details` (JSON), `ipAddress`, `createdAt`, and for `auth.*`
rows the coarse `location`, `asn` and `carrier`, filled in once shortly after
the row is written. A delegate's reads of somebody else's record are counted
in one `sharing.record.accessed` row per owner, delegate and day.

**Protection.** From 1.50.0 `audit_logs` is append-only for the app's database
role. A trigger refuses `DELETE`, `TRUNCATE` and every `UPDATE` except two:
filling a row's location fields once, and raising the per-day counter of a
delegated-access row. Retention cleanup, account erasure and the cycle-data
erasure run through functions owned by the database owner (`SECURITY DEFINER`)
that delete only what their narrow conditions name. A process running as the
app role, compromised or not, can add rows and cannot change or remove one.
An install that turned the separate role off
([`self-hosting/database-role.md`](../self-hosting/database-role.md#turning-it-off))
runs as the owner and does not get this protection. Either way, a copy kept
outside the database is the only record an attacker with owner access cannot
touch: see [shipping logs off the host](#shipping-logs-off-the-host).

**Who reads it.** Admins see every row with the full address. A user sees,
under Settings, Security, their own `auth.*` rows, export rows, account
deletion and data clearing, with a masked address
(`src/lib/auth/security-activity.ts`), and, under the record's activity, every
act somebody else performed on their record.

## Security events

The audit actions below are security events. Every other audit action is a
record change (a measurement, a medication, a note) and is kept under the same
rules. Admin, Audit log lists the actions present on an instance
(`/api/admin/audit-log/actions`).

| Family                      | Actions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in                     | `auth.login`, `auth.login.password`, `auth.login.passkey`, `auth.login.failed`, `auth.login.account_throttled`, `auth.login.new_device`, `auth.oidc.login`, `auth.oidc.provisioned`, `auth.oidc.linked`, `auth.oidc.link_pending`, `auth.oidc.link_conflict`, `auth.oidc.claim_conflict`, `auth.native.handoff_minted`, `auth.native.handoff_replay`, `auth.oidc.native.handoff_minted`, `auth.bearer.failure`                                                                                                                                                                                                                                    |
| Registration and claims     | `auth.register`, `auth.claim`, `managed_profile.claimed`, `managed_profile.claim_sso.started`, `managed_profile.handed_over`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Second factor               | `auth.mfa.challenge`, `auth.mfa.verified`, `auth.mfa.failed`, `auth.mfa.recovery_used`, `auth.mfa.recovery_regenerated`, `auth.mfa.enabled`, `auth.mfa.disabled` (also written by the operator CLI with `source: "cli"`), `auth.mfa.totp.setup`, `auth.mfa.webauthn.register`, `auth.mfa.webauthn.remove`, `auth.mfa.trusted_device`                                                                                                                                                                                                                                                                                                              |
| Credentials                 | `auth.password.change`, `auth.passkey.register`, `auth.passkey.delete`, `profile.update` (username, e-mail), `profile.email.conflict`, `profile.email.rate_limited`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Re-proof and step-up        | `auth.reproof.succeeded`, `auth.reproof.rate_limited`, `auth.stepup.mint.succeeded`, `auth.stepup.mint.failed`, `auth.stepup.mint.rate_limited`, `auth.stepup.elevation.rejected`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Sessions and devices        | `auth.session.revoke`, `auth.session.revoke_others`, `auth.trusted_device.revoke`, `auth.trusted_device.revoke_all`, `auth.token.refresh`, `auth.token.refresh.failed`, `auth.token.refresh.revoke` (reuse detected), `auth.token.autoissue.native`, `devices.register`, `devices.register.takeover`, `devices.register.takeover_refused`, `devices.revoke`                                                                                                                                                                                                                                                                                       |
| API tokens and MCP          | `tokens.measurements.create`, `tokens.workouts.create`, `tokens.documents.create`, `medication.api_endpoint.enable`, `medication.api_endpoint.disable`, `mcp.tokens.create`, `mcp.tokens.revoke`, `mcp.connections.revoke`, `mcp.oauth.authorize.granted`, `mcp.oauth.token.issued`, `mcp.write.measurement`, `mcp.write.blood_pressure`, `mcp.write.mood`                                                                                                                                                                                                                                                                                        |
| Sharing and URL credentials | `sharing.grant.invited`, `.accepted`, `.revoked`, `.renounced`, `.expired_closed`, `sharing.switch.on`, `sharing.switch.off`, `sharing.access.denied`, `sharing.record.accessed`, `share-link.create`, `share-link.revoke`, `share-link.report.download`, `emergency-card.link.create`, `.access`, `.revoke`, `emergency-card.wallet.create`, `.revoke`, `cycle.feed.create`, `.rotate`, `.revoke`, `care.feed.create`, `.revoke`, `managed_profile.guardian.invited`, `managed_profile.guardian.revoked`                                                                                                                                         |
| Data leaving the instance   | `export.download`, `health-record.export`, `user.export.encrypted`, `user.export.full-backup`, `user.export.measurements`, `user.export.medications`, `user.export.mood`, `consent.ai.grant`, `consent.ai.revoke`, `consent.ai.purge`, `documents.chat.outbound_blocked`, `insights.coach.outbound_blocked`, `documents.chat.replay_injection`, `insights.coach.replay_injection`                                                                                                                                                                                                                                                                 |
| Account lifecycle           | `user.account.delete`, `user.account.deletion_cancelled`, `user.account.deletion_refused`, `user.account.erasure_failed`, `user.data.clear`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Administration              | `admin.user.create`, `admin.user.update` (role, identity, second-factor requirement), `admin.user.delete`, `admin.user.deletion.undo`, `admin.user.force-logout`, `admin.user.force-logout.denied`, `admin.user.reset-password`, `admin.invite.created`, `admin.invite.revoked`, `admin.settings.update`, `admin.settings.module-availability.update`, `admin.ai-settings.update`, `admin.web_push_vapid.generate`, `admin.data.clear`, `admin.encryption.rotate.requested`, `.completed`, `.failed`, `admin.push_relay.enabled`, `.disabled`, `.key_rotated`, `.sender_key_emergency_rotation`, `admin.central-codex.connected`, `.disconnected` |
| Backups and recovery        | `admin.backups.run`, `.upload`, `.download`, `.restore`, `.restore.start`, `.restore.failed`, each with a `.denied` variant where an admin was refused; `offhost.backup.purged`, `recovery.kit.confirmed`, `recovery.kit.verified`                                                                                                                                                                                                                                                                                                                                                                                                                |
| Integrations                | `<provider>.connect`, `<provider>.disconnect`, `<provider>.credentials.delete`, `codex.oauth.connected`, `codex.oauth.disconnected`, `integration.client_app.shared`, `integrations.reauth_required`, `documents.sources.connect`, `documents.sources.disconnect`                                                                                                                                                                                                                                                                                                                                                                                 |
| System                      | `system.tls.pin_changed`, `system.deploy.success`, `system.deploy.failure`, `notification.channel.auto_disabled`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Some security events are wide events only, because they happen before there
is an account to file them under or because they are too frequent for a row.
Each is a `warn` event with its own `action.name`:

- every refused request: status 401 or 403 with the refusal code in
  `error.code` (for example `undeclared_scope`, `sharing.not_permitted`,
  `request.cross_site`), 429 with the bucket in `rate_limit`;
- `auth.native.pkce_failed`, `auth.native.token.wrong_transport`,
  `auth.mfa.verify.attempts_exhausted`, `auth.mfa.verify.invalid_ticket`,
  `auth.passkey.refused`, `auth.reproof.method_refused`,
  `auth.session.insecure_transport.refused`;
- `mcp.oauth.authorize.denied`, `mcp.oauth.authorize.invalid`,
  `mcp.oauth.authorize.cross_origin`, `mcp.oauth.token.code_rejected`,
  `mcp.oauth.token.code_replayed`, `mcp.oauth.token.pkce_failed`,
  `mcp.oauth.register.rate_limited`;
- `admin.push_relay.decision.refused`, `csp.violation`;
- validation failures (`*.validation-failed`, as `meta.rejected_attempt`; a
  row too when the request came from a delegate).

## Shipping logs off the host

Everything the app logs leaves as JSON lines on stdout, so any collector that
reads container output works. Keep the copy on a system the HealthLog host
cannot write to after the fact, and set its retention there.

**Loki, from the app.** Set `LOKI_ENDPOINT` (and `LOKI_USERNAME` /
`LOKI_PASSWORD`) on every container. Events are pushed in batches every five
seconds; a failed push is reported on stderr and the event stays on stdout.

**Loki, from the host with Promtail or Alloy** (nothing to change in the app):

```yaml
# promtail: scrape the HealthLog containers' JSON lines
scrape_configs:
  - job_name: healthlog
    docker_sd_configs:
      - host: unix:///var/run/docker.sock
        filters:
          - name: label
            values: ["com.docker.compose.service=app"]
    pipeline_stages:
      - json:
          expressions:
            { level: level, action: action.name, status: http.status }
      - labels: { level: "", action: "" }
```

**syslog or journald, with the Docker log driver:**

```yaml
# docker-compose.override.yml
services:
  app:
    logging:
      driver: syslog
      options:
        syslog-address: "tcp+tls://logs.example.net:6514"
        tag: healthlog
```

**The audit log.** It lives in the database. To hold a copy outside it, export
it on a schedule as the owner, for example nightly:

```sh
docker compose exec -T db psql -U healthlog -d healthlog -c \
  "\copy (SELECT * FROM audit_logs WHERE created_at >= now() - interval '1 day') TO STDOUT WITH CSV HEADER" \
  > "audit-$(date -u +%F).csv"
```

and keep the files where the host cannot rewrite them. The nightly and
off-host database dumps carry the table too
([`ops/disaster-recovery.md`](../ops/disaster-recovery.md)).

Timestamps are UTC throughout (`sql-now-utc-guard.test.ts`); the host's clock
is the operator's (NTP).
