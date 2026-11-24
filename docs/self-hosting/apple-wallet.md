# Apple Wallet passes

From v1.50 the emergency card can be added to Apple Wallet. A pass has to be
signed with a Pass Type ID certificate from an Apple developer account. There
are two ways a server gets one.

## Default: the project's signing service

Nothing to configure. When the push relay is on (Admin, Push and channels;
see `docs/integrations/push-relay.md`) and the server is reached over https,
the card page offers "Add to Apple Wallet". The pass is built on this server,
and only its `manifest.json` goes to the HealthLog signing service: the file
names of the pass and the SHA-1 hash of each file. The service signs that list
with the project's Pass Type ID and returns the signature. It never sees
`pass.json`, the translated text tables, the card's content, its link or the
pass's serial number. Every text table carries a random line per build, so a
hash cannot be used to confirm a guess at the content.

What the service does learn: that this server asked, and when. The relay keeps
the SHA-256 of each signed manifest with the server's instance id and the day
for 400 days, so a pass reported as misuse can be traced to the server that
had it signed; that list is readable only by the relay operator.

Before the first pass the owner accepts a short notice saying exactly this.

Update pushes go the same way: when a pass changes or is withdrawn, the
server asks the relay to send an empty push to each device that registered
it, and the relay sees each pass push token only while it forwards.

## Optional: your own Pass Type ID

An operator with an Apple developer account can sign on the server instead,
with no relay involved. Four variables, all or none:

| Variable                      | Content                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- |
| `WALLET_APPLE_PASS_TYPE_ID`   | The Pass Type ID, for example `pass.org.example.emergency`              |
| `WALLET_APPLE_TEAM_ID`        | The 10-character team id (the certificate's `OU`)                       |
| `WALLET_APPLE_CERT_B64`       | The Pass Type ID certificate, PEM or DER, base64-encoded                |
| `WALLET_APPLE_KEY_B64`        | Its RSA private key, PEM (PKCS#8 or PKCS#1), base64-encoded             |
| `WALLET_APPLE_KEY_PASSPHRASE` | Optional: the passphrase, when the key is encrypted                     |
| `WALLET_APPLE_WWDR_B64`       | Optional: the intermediate that issued the certificate; default WWDR G4 |

All six are on the `environment:` list of the bundled `docker-compose.yml`, so
values in `.env` reach the container.

### Getting the certificate

1. In the Apple developer portal, under Certificates, Identifiers & Profiles,
   add a Pass Type ID (Identifiers, "+", Pass Type IDs).
2. Make a key and a signing request on your own machine:

   ```sh
   openssl req -new -newkey rsa:2048 -nodes -keyout pass.key -out pass.csr \
     -subj "/CN=pass.org.example.emergency/O=Example"
   ```

3. Open the Pass Type ID, choose "Create Certificate", upload `pass.csr` and
   download `pass.cer`. Convert it to PEM:

   ```sh
   openssl x509 -inform DER -in pass.cer -out pass.crt
   ```

   If you exported a `.p12` from Keychain Access instead, split it:

   ```sh
   openssl pkcs12 -in pass.p12 -clcerts -nokeys -out pass.crt
   openssl pkcs12 -in pass.p12 -nocerts -nodes -out pass.key
   ```

4. Check it: the issuer is "Apple Worldwide Developer Relations Certification
   Authority" with `OU=G4`, the subject carries your Pass Type ID as `UID` and
   your team as `OU`.

   ```sh
   openssl x509 -in pass.crt -noout -subject -issuer -enddate
   ```

5. Put both into the environment, base64 on one line, and delete the files:

   ```sh
   WALLET_APPLE_CERT_B64="$(base64 < pass.crt | tr -d '\n')"
   WALLET_APPLE_KEY_B64="$(base64 < pass.key | tr -d '\n')"
   ```

### Update pushes

With your own Pass Type ID the server also pushes the updates itself: an
empty push to Apple's production gateway, topic your Pass Type ID,
authenticated with the same certificate and key. Nothing goes through the
relay, and nothing more is needed than outbound HTTPS to
`api.push.apple.com:443`. The `APNS_*` variables of the iOS app play no part
here.

### Apple's pass web service

Every pass names `https://<your host>/api/wallet/apple/` as its web service.
Wallet registers devices there, asks which passes changed, fetches them and
sends its error log. These routes take no session: a pass authenticates with
its own token, which the server derives and never stores, and the list of
changed passes is keyed by Apple's device id, stored only as a hash. Your
reverse proxy has to let `/api/wallet/apple/v1/` through without an extra
login in front of it, as it does for `/e/` and the calendar feeds.

### What the server checks

At start and once a day the set is checked as a whole: the key belongs to the
certificate, Apple's intermediate issued it, its `UID` and `OU` are the Pass
Type ID and team you set, and it is valid for at least seven more days. When
any of that fails, or only some of the variables are set, Apple Wallet is off
on this server and the boot summary names the problem with a code, never a
value (`WALLET_APPLE_*: set but unusable (identifier_mismatch)`). The server
never falls back to the project's signing service in that case, because that
would sign under an identity you did not choose.

### Switching between the two

A pass in a phone's Wallet belongs to the Pass Type ID it was signed with.
After switching from the project's service to your own certificate, or back,
passes made before the switch can no longer be updated or withdrawn on the
phone: their QR link still stops working when withdrawn, but the pass itself
stays as it was. The card page offers to make a new one. The same holds after
a restore from backup, which never carries a pass.
