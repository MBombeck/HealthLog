# Official medication leaflets

Every medication has an official leaflet: the patient information that comes
in the pack, published by the national medicine registry of the country it is
sold in. HealthLog helps you find it and keep the link with the medication. It
does not download, store or read the leaflet.

## Find a leaflet

Open a medication and look for **Leaflet** on its overview. **Find leaflet**
opens the official registry search of the country you picked, in a new tab,
with the medication's name already searched for. A few registries also take
the strength ("Ramipril 5 mg"); the others search by name, because the
strength is a separate field there.

Some registries do not take a search from a link at all (Germany's AMIce,
Health Canada, the European Medicines Agency). For those the search page
opens empty, and HealthLog tells you which name to type into it.

The same two links are on the medication card's menu.

The leaflet comes from the national registry, not from HealthLog. Check that
the product you open matches your medication's name, strength and form: many
medicines have similar names, and one name can cover several strengths.

## Nothing leaves the server

HealthLog's server makes no request to any registry. The link is built from a
fixed list of registry search addresses, and your browser opens it the same
way it opens any other link. The registry sees an ordinary visit from your
browser, with the medication name in the address, as if you had typed the
name into its search box yourself.

## Pick the country

Open **Settings**, **Medications**, and choose a **Medicine registry**:
Poland, Germany, Spain, France, the United Kingdom, Belgium, the Netherlands,
the United States, Canada, Australia, Brazil, the European Union, or **None**.
**None** hides the search.

The registry is independent of the app's language: someone reading HealthLog
in English in Warsaw picks Poland. The first time you sign in after the
update, HealthLog picks one for you only where your language and your time
zone agree on a country (German in Berlin is Germany, Polish anywhere is
Poland); otherwise it starts at **None**. After that it only changes when you
change it.

## Save the leaflet link

When you have found the right leaflet, copy its address from the registry and
keep it with the medication:

- on the medication's overview, under **Leaflet**, choose **Save a leaflet
  link**, paste the address and save; or
- edit the medication and paste it into **Leaflet link** on the last step.

Only `https://` addresses are accepted. The saved link appears as
**Official leaflet** and opens in a new tab. **Edit link** changes it,
**Remove link** clears it. The link is included in backups, restores and the
data export, and goes with the medication when you delete it or wipe your
data.

## For the iOS app and other clients

The medication detail (`GET /api/medications/{id}`) carries `leafletSearch`,
the ready-built search link for the signed-in person's registry (or `null`),
and every medication read carries `leafletUrl`. The registry is
`medicineRegistry` on `/api/auth/me` and is set with
`PATCH /api/auth/me/medicine-registry`. See `docs/api/openapi.yaml`.
