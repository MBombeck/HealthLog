# Push relay

Apple delivers a push to the HealthLog app from the App Store only when it is
signed with the key of the Apple developer account that publishes the app. A
self-hosted server does not have that key, so on its own it cannot reach the
App Store app: no confirmation that a dose was recorded on another device, no
silent sync, no ending the Live Activity from the server.

The push relay closes that gap. It is a small service run by the HealthLog
project at `push.healthlog.dev`. Your server seals each notification for the
device it is meant for, hands the sealed envelope to the relay, and the relay
passes it to Apple inside a fixed template. The relay holds the APNs key; it
never holds a key that opens an envelope.

The relay's source, protocol and test vectors are public in the
`healthlog-push` repository (Apache-2.0; the specification and vectors CC0).

## What the relay sees, and what it does not

The relay sees:

- that your server sends a device something, when, and of which class
  (alert, silent, or the end of a Live Activity);
- the device's APNs token while a request is in flight (stored only as a
  keyed hash), and your server's instance id;
- your server's address while it is connected (not stored, not logged);
- a hash of the device's binding key and the version and day of the
  person's consent.

It does not see the content: medication names, doses, readings, notes,
account names or anything else inside a notification. Every alert and every
silent push carries an envelope sealed with HPKE (RFC 9180, auth mode,
X25519, HKDF-SHA256, ChaCha20-Poly1305) for that one device. The envelope has
a fixed size per class and its header names no key, so envelopes do not tell
devices or servers apart either.

What timing can reveal is said plainly: if you record a dose on one device
and another device of yours gets the confirmation, the relay and Apple can
see that something happened at that moment. Apple can link the timing to your
Apple account. That is why reminders are planned on the iPhone and do not go
through the relay, and why turning the relay on is each person's own choice.

The holder of the relay's APNs key (the relay operator, or anybody who steals
that key) can make a notification appear in the app's name. They cannot read
your data, and the app acts only on notifications whose envelope opened with
a sender key it pinned from your server.

## Turning it on

The relay is off until the admin turns it on.

1. After the update every admin sees a one-time notice on the admin start
   page that the option exists. It can be dismissed and does not come back.
2. In **Admin > Services**, switch on **Offer the HealthLog push relay to this
   server's users**. The dialog asks for two confirmations: that you accept
   the relay terms and have read its privacy notice, and that you run this
   server privately for yourself or your household. The hosted relay is for
   private and household use only and is not a medical service.
3. Your server creates its instance key, stores it encrypted, and registers
   with the relay. The card then shows the relay's state and how many devices
   are bound.
4. Each person sees a card in the iOS app once and decides for themselves.
   Only "Turn on" creates the keys on the iPhone and binds it. The choice
   stays in the app's notification settings and can be withdrawn there at any
   time, even while your server is unreachable.

Turning the switch off deletes your instance at the relay, which removes every
device binding with it, and deletes the instance key here. If the relay is not
reachable at that moment, the server keeps the key, sends nothing, and retries
the deletion until the relay confirms it. Revoking a device or withdrawing
consent reaches the relay the same way. The apps notice it
on their next sync and go back to local reminders on their own.

### Checking it works, and the instance key

The relay card has **Send test push**: one harmless sealed notification to
each of your own devices that use the relay. The card shows what the relay
answered, verified against its pinned signing key, and whether the push was
accepted for delivery. Use it after turning the relay on, after an update, or
when someone says notifications stopped.

Your server signs every relay request with its own instance key. It replaces
that key every 30 days through the relay's rotation endpoint, and **Rotate
relay key** does it at once (the relay allows one rotation a day). The new
key is kept before the request leaves, so a lost answer cannot lock the
server out, and the old one is kept for 7 days.

### Sender keys

Envelopes are sealed with this server's sender key, which every device pins.
A new sender key is announced to the apps as `next` at least 7 days before
it seals anything, then becomes `current`; the old one stays pinned as
`previous` for 30 days and is then deleted. The regular rotation is yearly.
If a sender key is ever exposed, `POST /api/admin/push-relay/rotate-sender-key`
(an admin with a fresh second factor, audit-logged) replaces it at once;
devices that have not fetched the new key show a neutral notification until
the app is opened.

### Deleting an account

When an account is erased (by the person, by an admin, or by the purge after
the grace window), the server tells the relay to drop the binding of each of
its devices. The unbind is queued with the erasure and sent by the relay's
background pass, so a relay that is down delays it without blocking the
deletion; it is retried for 7 days. The app's own "turn off" also revokes its
binding directly at the relay.

### What goes over the relay

- the confirmation that a dose was recorded on another device;
- the silent sync that tells another device to refresh;
- the end of a medication Live Activity, sent with a statement the device
  signed when the Activity started (the relay never learns when an Activity
  starts);
- other server notifications such as low stock or a seizure cluster;
- security alerts: a sign-in from a new device, a passkey added or removed,
  an access token revoked, a device signed out because its sign-in token was
  used twice. They break through a Focus (time-sensitive);
- a silent wake when a server-side sync stored new readings (Withings,
  Garmin, Oura, WHOOP, Polar, Strava, Google Health, Nightscout, or a food
  tracker posting with a token), so the app, its widgets and the Watch are
  current without opening the app. It names only the kind of data that
  changed (measurements, sleep, workouts, nutrition), never a value;
- a silent wake asking the app to run its Apple Health upload when the
  server has received nothing from it for six hours while the app is still
  in use.

### How often

The silent wakes are rationed, because Apple stops waking an app that gets
too many of them:

- the data wake goes out at most once every five minutes and three times an
  hour per account; changes in between are merged into the next one, never
  dropped. A sync you started from a device does not wake that device, it
  already has the result;
- the Apple Health wake goes to a device at most three times a day, at least
  four hours apart, and only while the app was opened in the last three days;
  after two weeks without any upload the server stops asking;
- no device gets more than four of these wakes an hour together, and over the
  relay none beyond the relay's own six silent pushes per device and hour.

Both wakes go only to app versions that registered a push key; older app
versions get nothing new. A server with its own APNs key sends the same
sealed wakes itself.

Mood, measurement and cycle reminders do not go over the relay; the app plans
them itself. Medication reminders stay on the iPhone unless a device is set to
server delivery. Notifications about another person's record (guardian
features) do not go over the relay.

### When the relay is down

Nothing is lost that the iPhone does not already have: reminders are local.
Your server keeps each push with its deadline (an alert at most 6 hours, a
silent sync 1 hour, a Live Activity end 4 hours) and retries with backoff; a
push past its deadline is dropped, never delivered late. After three failed
connections in a row the server stops trying item by item and checks the
relay's status every minute, later every five.

A relay outage never counts against a device or switches a notification
channel off. Only Apple's "unregistered" answer for a device token deletes
that device, and if more than a third of the relay devices get that answer
within an hour, the server holds further deletions for a day, because that
pattern points at a fault, not at a wave of uninstalls.

While the relay is down, or when pushes it accepted never arrived on a
device, the app shows that syncing with your other devices is disrupted, so
nobody relies on a confirmation that did not come.

## Privacy notice in short

- The relay operator is the maintainer of the HealthLog project, acting as
  an independent controller for the relay's metadata. The relay serves its
  full privacy notice at `https://push.healthlog.dev/privacy` and its terms at
  `https://push.healthlog.dev/terms`.
- Delivery rests on each person's consent, given on the app's card and
  withdrawable at any time. Without it nothing goes over the relay and
  everything else works as before.
- The relay keeps bindings for at most 13 weeks without a push, daily counts
  per instance for 7 days, totals without any instance for 400 days, and no
  addresses or tokens in its logs.
- In the app, "My data at the relay" shows what the relay holds about the
  device, and turning the relay off erases it.

## Configuration

All optional, all on the compose whitelist.

| Variable          | Default                      | Meaning                                                                        |
| ----------------- | ---------------------------- | ------------------------------------------------------------------------------ |
| `PUSH_RELAY_MODE` | `allowed`                    | `off` hides the relay entirely, the admin notice included                      |
| `PUSH_RELAY_URL`  | `https://push.healthlog.dev` | the relay origin; `https` only                                                 |
| `PUSH_RELAY_KEYS` | the hosted relay's keys      | the relay's identity public keys, Ed25519, unpadded base64url, comma separated |

Every relay answer must carry a signature by one of the pinned identity keys,
bound to the method, path and nonce of the request it answers, and fit the
expected shape and size (at most 256 KiB). Retry hints are taken only from the
signed body, never from the unsigned `Retry-After` header, and capped at a
day. An answer without one is treated as if it
never arrived; it is never read as a refusal, a revocation or a deletion. A
relay without pinned keys cannot be used at all.

A server with its own APNs key (`APNS_*`) does not need the relay. It seals
the same envelopes and sends them to Apple itself, so the app sees one format
on every path.

## Running your own relay

A relay you run yourself cannot serve the App Store app: Apple accepts pushes
to that app only with the HealthLog project's key. Your own relay works with
an app you build from source and sign with your own Apple developer account.

- One server and your own app build: use your own APNs key (`APNS_*`); no
  relay needed.
- Several servers, or an organisation, with your own app build: run your own
  relay from the `healthlog-push` repository, set `PUSH_RELAY_URL` and
  `PUSH_RELAY_KEYS` on each server, and point your app build at it.

Organisations (a practice, a care service, an association) do not use the
hosted relay under its terms; they use their own APNs key, their own relay, or
contact `relay@healthlog.dev`.
