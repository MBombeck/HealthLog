# Notifications — push channels for a self-host

HealthLog delivers reminders (medication doses, mood check-ins, personal
records) and a few operational alerts through a small cascade of push
channels. The single message to take away: **you do not need an Apple
Developer account or APNs to get push.** Five of the six channels are
free, work in the browser or in an app you already have, and cover every
platform a self-hoster runs. APNs is only for the native iOS app, and
even that you can build yourself (see the last section).

When an event fires, the dispatcher fans it out to every channel a user
has enabled, in a fixed order — APNs first, then Telegram, then ntfy,
then the generic webhook, then email, then Web Push as the universal
fallback (`src/lib/notifications/dispatcher.ts`). Each channel is
best-effort and independent: a user can enable one or several, and a
failure on one never blocks the others.

An APNs-less instance degrades gracefully. Nothing about push depends on
APNs being configured. Urgent events still surface everywhere it matters:
ntfy escalates them to max priority (`5`), Web Push raises urgency and
keeps the notification on screen until the user acts, and the webhook
carries the urgent flag for your own routing. APNs only adds the
Apple-platform exclusives the web cannot offer.

## TL;DR — which channel needs what

| Channel      | What it needs                                                             | Cost                           | Where it works                                                                                          |
| ------------ | ------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| **Web Push** | A VAPID keypair (one command, or paste into the admin panel)              | Free                           | Any modern desktop/Android browser; the installed PWA on iPhone (iOS 16.4+, after _Add to Home Screen_) |
| **Telegram** | A bot token from @BotFather + each user's chat ID                         | Free                           | Anywhere the Telegram app runs                                                                          |
| **ntfy**     | A topic on `ntfy.sh` or your own ntfy server                              | Free                           | The ntfy app (iOS/Android) or any browser                                                               |
| **Webhook**  | A URL you own (and optionally one custom header)                          | Free                           | Anywhere — you route the POST yourself                                                                  |
| **Email**    | An SMTP transport you operate or rent                                     | Free–cheap                     | Any mailbox                                                                                             |
| **APNs**     | An Apple Developer account + a `.p8` push key + your own signed iOS build | Apple Developer Program (paid) | A native iOS app you build and sign                                                                     |

Web Push is the recommended default — it needs no third-party account,
just a keypair you generate yourself once.

## Web Push (recommended default)

Web Push delivers notifications straight to a browser — desktop or
mobile — even when the HealthLog tab is closed, as long as the browser
or installed PWA is alive. It is the broadest-reach channel and the one
to set up first.

### 1. Generate and store a VAPID keypair

VAPID is the signing scheme that lets a push service trust your server.
You also choose a **subject** — a `mailto:` address the push service can
contact about your sender, e.g. `mailto:you@example.com`.

The server loads VAPID config from the database first and falls back to
environment variables (`src/lib/notifications/vapid-config.ts`). The admin
panel is the easiest path because it survives without touching `.env`.

**Admin panel — Generate keys (easiest).** Sign in as the admin user,
open `/admin`, and find the **Web Push VAPID** card
(`src/components/admin/web-push-vapid-section.tsx`). Click **Generate
keys**: the server mints a fresh keypair, stores the private key encrypted
at rest with your `ENCRYPTION_KEY`, seeds a placeholder subject, and fills
in the public key. Edit the subject to your real `mailto:` address and
save. The card shows a "configured" badge once all three fields are set —
no shell, no copy-paste.

> If a keypair already exists, **Generate keys** asks you to confirm before
> replacing it. Regenerating invalidates every existing browser
> subscription, so each device has to re-subscribe afterwards. Only
> regenerate when you mean to.

**Admin panel — paste an existing pair.** If you already have a keypair
(e.g. copied from another deployment), paste the public key, the private
key, and the subject into the same card and save instead of generating.

**CLI — generate a pair yourself.** You can also mint one with the bundled
`web-push` CLI and paste the result into the card or your `.env`:

```bash
npx web-push generate-vapid-keys
```

That prints a **public key** and a **private key** (both Base64URL).

### 2. Store the keys via environment variables (alternative)

If you would rather keep secrets out of the database, set them in `.env` /
the compose `environment:` block instead:

```env
VAPID_PUBLIC_KEY="BElx...(public key)"
VAPID_PRIVATE_KEY="...(private key)"
VAPID_SUBJECT="mailto:you@example.com"
```

The database values win when both are present. These three names are the
only ones the loader reads.

### 3. Subscribe a device

Each user enables Web Push for their own browser from
`/settings/notifications` — the **Browser Push** card has a Subscribe
button, and a Test button to fire a one-off push once subscribed. The
browser prompts for notification permission on first subscribe; once
granted, that browser receives every enabled event.

## The PWA path — install to the Home Screen

Installing HealthLog as a PWA and enabling Web Push is the recommended
default for phones. It needs nothing from Apple and gives you, in
v1.18.4:

- **Reminders.** Medication doses, mood check-ins, and any other event
  the user has enabled, delivered to the installed app even when it is
  closed.
- **Taken → clears the reminder.** When you log a dose, the server sends
  a silent `type:"clear"` push that closes the still-pending dose-due
  reminder for that slot (matched on its stable tag) without showing a
  new notification (`public/sw.js`). This is the PWA equivalent of ending
  an iOS Live Activity.
- **An app badge for outstanding doses.** The icon on the Home Screen
  carries a server-authoritative count of doses still due; logging a dose
  decrements it, and a count of zero clears the badge. The count is
  computed on the server and reflected by the service worker via the
  Badging API (`navigator.setAppBadge`), feature-detected — engines
  without it (most desktop Firefox, older Safari) silently no-op.

### iPhone — Add to Home Screen first

Safari on iPhone supports Web Push only from **iOS 16.4 or newer**, and
only for a site that has been **installed to the Home Screen as a PWA**.
A regular Safari tab cannot subscribe. So on iPhone:

1. Open your HealthLog instance in Safari.
2. Tap the Share button, then **Add to Home Screen**.
3. Launch HealthLog from the new Home Screen icon (not from the Safari
   tab).
4. Open `/settings/notifications` inside that installed app and tap
   Subscribe; accept the permission prompt.

Android and desktop browsers have no such step — Subscribe and grant the
permission, and push works.

### The inherent limit

The installed PWA gets reminders, the taken-clears behaviour, and the app
badge — but it **cannot** show a native iOS lock-screen Live Activity
widget. That single feature rides Apple Push Notification service and is
only available through a native iOS build with APNs. Reminders themselves
arrive on both paths; only the Live Activity is APNs-exclusive.

## Telegram

Telegram delivers reminders as bot messages, with inline action buttons
on medication reminders (Taken / snooze / skip). It is a good fit when
you already live in Telegram or want push without running a browser.

1. In Telegram, open **@BotFather**, create a bot, and copy the **bot
   token** (it looks like `123456:ABC-DEF...`).
2. Send `/start` to your new bot so it can message you.
3. Find your **chat ID** — send a message to **@userinfobot**, or read it
   from the Bot API.
4. In HealthLog open `/settings/notifications`, fill the Telegram card's
   **Bot Token** and **Chat ID**, toggle it on, and save.

One bot can serve every user on the instance; each user pairs their own
chat ID. The token is encrypted at rest.

## ntfy

[ntfy](https://ntfy.sh) is the most self-hoster-native option: a tiny
pub/sub push relay you can use hosted (`ntfy.sh`) or run yourself. You
subscribe to a **topic** in the ntfy app (iOS/Android) or a browser, and
HealthLog publishes to that topic.

1. Pick a hard-to-guess topic name (the topic _is_ the access control on
   public `ntfy.sh` — anyone who knows the string can read it, so treat
   it like a secret).
2. Subscribe to that topic in the ntfy app or at `https://ntfy.sh/<topic>`.
3. In HealthLog open `/settings/notifications`, set the ntfy card's
   **Server URL** (defaults to `https://ntfy.sh`; point it at your own
   server if you self-host ntfy) and **Topic**, then save.

If your ntfy server requires auth, an access token can be attached; the
server URL is validated at save time and dialled through the egress guard
(`src/lib/notifications/senders/ntfy.ts`). A self-hosted ntfy on your own
network needs the operator grant described under [Notification targets on
a private network](#notification-targets-on-a-private-network). Urgent
events are sent at ntfy's top priority (`5` / max) so they bypass batching
and surface on the lock screen.

## Webhook

The generic webhook POSTs every enabled event as JSON to a URL you own —
wire it into your own automation (Home Assistant, n8n, a Discord/Slack
relay, whatever routes the payload). You supply a public URL and,
optionally, one custom header (e.g. an auth token).

1. In HealthLog open `/settings/notifications`, fill the Webhook card's
   **URL** and, if your endpoint expects one, a single **header name** +
   **header value**.
2. Save. A Test button fires a one-off POST so you can confirm routing.

The URL is validated at save time and dialled through `safeFetch` with
the connect-time resolver pin — the SSRF guard refuses a target that
resolves to a private or loopback address because the target is
user-supplied (`src/lib/notifications/senders/webhook.ts`). A Gotify or
Home Assistant on your own network needs the operator grant described in
the next section. The webhook carries the event's urgency flag so you can
route urgent events differently.

## Notification targets on a private network

Every webhook and ntfy target is resolved at send time and refused when
the answer is a private, loopback, link-local or CGNAT address. That is
the DNS-rebinding defence, and it applies to a public-looking name with a
LAN A record (a Gotify behind Nginx Proxy Manager with a DNS-01
certificate) exactly as it applies to `http://192.168.1.20`. The test
button and the scheduled delivery take the same decision, so a test that
fails with "Private network target" means nothing would have arrived
either.

The operator opens a target by listing its exact origin in the server
environment:

```env
NOTIFICATION_PRIVATE_ORIGINS="https://gotify.example.com,http://ntfy.lan:8080"
```

Each entry is one `scheme://host[:port]`, the same grammar as
`NIGHTSCOUT_PRIVATE_ORIGINS`:

- only `http` and `https`; scheme, host and effective port must all match
  what the user saves (`https://gotify.example.com:8443` and
  `https://gotify.example.com` are two different grants);
- no path, query, credentials, wildcard (`*.lan`) or CIDR (`10.0.0.0/8`) —
  a range grant would let a DNS rebinding to any address in the range pass
  the pin, so an operator with several relays lists several origins;
- listing a host does not list its sub-hosts or sibling ports;
- loopback (`127.0.0.0/8`, `::1`, `localhost`), the unspecified address,
  link-local and the cloud-metadata range (`169.254.0.0/16`, `fe80::/10`)
  cannot be granted: a literal entry is logged once and ignored, and a
  listed name that resolves there is refused at dial time. On a
  host-network deployment, list the LAN address of the relay instead of
  `localhost`;
- RFC1918, IPv6 unique-local and CGNAT (a Tailscale address or MagicDNS
  name) are what the list is for;
- a malformed entry is logged once at first use and grants nothing; the
  valid entries beside it keep working.

A listed origin is still dialled through the pinned resolver with
redirects forbidden, so a relay that answers with a redirect to another
host is refused. The variable has to be on the compose `environment:`
whitelist to reach the container; the published `docker-compose.yml`
lists it. Restart the app after changing it.

What is refused where, so you know which lever to pull:

| Target                                                      | Without the grant | With the exact origin listed |
| ----------------------------------------------------------- | ----------------- | ---------------------------- |
| Public name resolving to a public address                   | works             | works, public pin            |
| Public name with a private A record (LAN reverse proxy)     | refused at send   | works                        |
| `gotify.lan`, `gotify.home.arpa`, a Docker service name     | refused at send   | works                        |
| `gotify.local` (mDNS)                                       | refused at save   | works                        |
| Literal `192.168.x.x`, `10.x.x.x`, `100.64.x.x`, `fd00::/8` | refused at save   | works                        |
| `localhost`, `127.0.0.1`, `169.254.169.254`, `::1`          | refused at save   | still refused                |

A private target that is not listed is refused when the card is saved
(`422`, `meta.errorCode` = `private_origin_not_approved`, the message
names the variable) or, for a DNS name the save cannot classify, when the
test button or a reminder dials it. The resolved address is never shown
to the user. Telegram, email and Web Push are not affected: their hosts
are not user-supplied.

## Email (SMTP)

The email channel sends reminders to a mailbox over an SMTP transport you
operate or rent. It is configured **instance-wide by the operator** (one
transport serves every user); each user then enables the channel and sets
their destination address from `/settings/notifications`.

Set the SMTP transport in `.env` / the compose `environment:` block:

```env
SMTP_HOST="smtp.example.com"
SMTP_PORT="587"
SMTP_FROM="HealthLog <noreply@example.com>"
SMTP_USER=""           # optional — omit for an unauthenticated relay
SMTP_PASS=""           # optional
SMTP_SECURE="false"    # true = implicit TLS (port 465); false = STARTTLS
```

`SMTP_HOST` + `SMTP_PORT` + `SMTP_FROM` together enable the channel;
`SMTP_USER` / `SMTP_PASS` are optional (omit them for an unauthenticated
relay). `SMTP_SECURE=true` uses implicit TLS on port 465; leave it `false`
for STARTTLS on 587. As with every var in `docker-compose.yml`, these must
be on the compose `environment:` whitelist to reach the container.

## APNs — native iOS, and why it needs your own Apple account

Apple Push Notification service is used by **only** a native SwiftUI iOS
app. PWA, browser, Telegram, ntfy, webhook, and email users never touch
it. It is the one channel a self-hoster cannot simply switch on, and the
reason is worth stating plainly.

### Why your server can't push to the published app

APNs binds a push to a specific **Apple Developer team + app bundle ID +
signing key**. The HealthLog iOS app published on TestFlight / the App
Store is signed under **the maintainer's Apple team and bundle ID**. Your
self-hosted server has neither that team's `.p8` key nor the authority to
mint one, so it **cannot** send APNs pushes to the published app. There is
no way around this — it is how Apple's trust model works, by design.

To get native iOS push **and** the lock-screen Live Activity widget on
**your own** infrastructure, you have to publish your own copy of the app
under your own Apple identity. Everything below is that path.

### Step by step — your own native iOS build

1. **Get an Apple Developer account** (~$99/yr). Required to sign an iOS
   app for a real device and to create a push key.
2. **Build and sign your own copy of the iOS app.** The client is open in
   a separate repository (`healthlog-iOS`). Open it in Xcode and set your
   **own bundle identifier** and **your team** as the signing team, then
   build to your device (or distribute via your own TestFlight).
3. **Create your own APNs `.p8` auth key** in the Apple Developer Portal,
   under **Keys → Create a Key → Apple Push Notifications service (APNs)**.
   Note the **Key ID**, and your **Team ID** (top-right of the portal).
   Scope the key **Sandbox & Production** (see the gotcha below).
4. **Point your bundle ID at your server.** Build the iOS app against your
   instance so the device registers its APNs token with your server.
5. **Set the APNs manifest on the server.** Add the env vars below to
   `.env` / the compose `environment:` block.

The APNs env vars (`src/lib/notifications/senders/apns.ts`):

| Variable                    | Purpose                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `APNS_KEY_ID`               | The `.p8` key's Key ID                                                              |
| `APNS_TEAM_ID`              | Your Apple Developer Team ID                                                        |
| `APNS_BUNDLE_ID`            | Your app's bundle identifier                                                        |
| `APNS_KEY_B64`              | The `.p8` PEM, base64-encoded (recommended key source)                              |
| `APNS_KEY`                  | OR the raw PEM body inline                                                          |
| `APNS_KEY_FILE`             | OR a path to the `.p8` file                                                         |
| `APNS_CRITICAL_ENTITLEMENT` | Optional — set `true` only if Apple grants your app the Critical Alerts entitlement |

APNs is **all-or-none**: either set the three IDs plus exactly one key
source, or leave the whole block unset. A partial config is rejected so
the channel never silently half-works (`scripts/check-env.ts`). When more
than one key source is present, the precedence is `APNS_KEY_B64` >
`APNS_KEY` > `APNS_KEY_FILE`.

`APNS_CRITICAL_ENTITLEMENT=true` is honoured only if Apple has actually
granted your app the Critical Alerts entitlement (a separate request to
Apple). Without that entitlement, leave it unset — the server keeps urgent
events at normal priority rather than minting a `critical` payload your
app cannot send (`src/lib/notifications/types.ts`).

Two gotchas worth knowing before you blame a stale token:

- **Base64 the key.** Pasting a raw `.p8` PEM through some env-file
  pipelines mangles its line breaks. `APNS_KEY_B64` (the PEM body,
  base64-encoded) sidesteps that entirely and is the recommended source.
- **Scope the key "Sandbox & Production".** In the Apple Developer
  Portal, a push key defaults to Sandbox-only. A Sandbox-only key fails
  on production (TestFlight / App Store) device tokens with
  `BadEnvironmentKeyInToken`. Confirm the key shows **Sandbox &
  Production**; a wrongly scoped key cannot be reconfigured — re-issue it.

> **`clientManaged` is iOS-app-only.** A native iOS app can opt to run its
> own local medication reminders and ask the server to stop sending the
> duplicate `MEDICATION_REMINDER` push (the `clientManaged` flag on
> `PATCH /api/auth/me/notification-prefs`). This is a native-app contract:
> a web/PWA-only self-hoster never needs it and there is no toggle for it
> in the web UI. If you only run the PWA, ignore it entirely — your
> medication reminders come from the server cron over the channels above.

## Which channel should I pick?

| Your setup                                        | Recommended channel                                                                                                                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PWA on Android or desktop                         | **Web Push** — generate a VAPID keypair, subscribe, done.                                                                                                                              |
| PWA on an iPhone                                  | **Web Push**, but install the PWA via _Add to Home Screen_ first (iOS 16.4+). Reminders, taken-clears, and the app badge all work; the lock-screen Live Activity needs a native build. |
| You want the native iOS lock-screen Live Activity | Build and sign **your own** iOS app under your own Apple account and wire up **APNs** (paid), with Web Push as a fallback for any non-iOS device.                                      |
| Headless / no browser, or you live in chat        | **Telegram** or **ntfy** — neither needs a browser, both are free. ntfy is the most self-host-native; Telegram adds inline reminder action buttons.                                    |
| You already run an automation hub                 | **Webhook** — POST every event to your own URL and route it however you like.                                                                                                          |
| You want reminders in your inbox                  | **Email** — set the SMTP transport once as the operator; users add their address.                                                                                                      |

Mixing channels is fine and common — e.g. Web Push on the laptop and
ntfy on the phone. Each user configures their own set from
`/settings/notifications`.
