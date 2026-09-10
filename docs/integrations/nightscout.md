# Nightscout integration

HealthLog can pull continuous-glucose readings from a Nightscout instance.
Public Nightscout origins work without an allowlist. Access to a private or
local destination is an operator decision and is denied unless its exact
origin is listed in `NIGHTSCOUT_PRIVATE_ORIGINS`.

## Security change for upgrades

`NIGHTSCOUT_PRIVATE_ORIGINS` is a breaking security boundary. The old
per-user “allow private host” opt-in is compatibility metadata only: it no
longer grants private-network access. Existing private connections that are
not operator-approved stop syncing with the stable
`private_origin_not_approved` reason until the operator configures the exact
origin.

Set a comma-separated list of complete origins:

```env
NIGHTSCOUT_PRIVATE_ORIGINS="https://cgm.internal.example:443,http://10.20.30.40:1337"
```

Each entry is an exact normalized `scheme://host:port` trust unit:

- only `http` and `https` are accepted;
- scheme, hostname, and effective port must all match;
- paths, query strings, fragments, embedded credentials, and wildcards are
  rejected;
- approving one hostname does not approve subdomains, sibling hosts, or a
  different port; and
- loopback (`127.0.0.0/8`, `::1`, `localhost`), the unspecified address,
  link-local and the cloud-metadata range cannot be listed, and a listed
  name that resolves there is refused at connect time — the grant opens
  your network, never the container or the host it runs on; and
- any malformed non-empty entry fails evaluation instead of silently
  weakening the configured policy.

The grammar is shared with `NOTIFICATION_PRIVATE_ORIGINS`, the same grant
for webhook and ntfy targets (`docs/self-hosting/notifications.md`).

Do not put a Nightscout API token, capability URL, health data, or a URL
containing credentials in the allowlist. Restart the application after
changing the environment.

## Connect safely

Open **Settings → Integrations → Nightscout** and enter the instance base URL
and, when required, its Nightscout API token. HealthLog stores the connection
credentials encrypted. A public, read-only Nightscout instance can omit the
token.

For a private instance, configure the operator allowlist first and enter the
same origin in Settings. For example, if the allowlist contains
`https://cgm.internal.example:443`, these are not equivalent and remain
blocked:

```text
http://cgm.internal.example:443
https://cgm.internal.example:8443
https://other.cgm.internal.example:443
```

The user-controlled private-host checkbox or request field cannot override
this decision.

## DNS pinning and redirects

Every outbound request re-evaluates the stored origin against current server
policy. For public destinations, HealthLog resolves the hostname, rejects
private and embedded-private IPv4/IPv6 answers, and pins the approved address
for the connection so DNS cannot change between validation and use. Redirects
are validated and pinned again; a public URL cannot redirect into the local
network.

An exact private origin is intentionally allowed to resolve privately only
because the operator named that complete origin. Removing it from
`NIGHTSCOUT_PRIVATE_ORIGINS` takes authority away on the next fetch even if an
older user preference remains stored.

## Upgrade checklist

1. Inventory private Nightscout connections without copying their tokens into
   tickets or logs.
2. Add only the exact origins that HealthLog must reach.
3. Restart HealthLog so the environment is reloaded.
4. Test the connection from Settings and confirm a sync succeeds.
5. Remove obsolete origins promptly; do not use a broad DNS suffix or wildcard
   as a substitute for explicit entries.

If a previously working private connection reports that operator action is
required, compare its exact scheme, host, and port with the allowlist. Do not
restore access by changing the user's legacy opt-in.
