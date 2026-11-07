# Watcher change: follow the current registrar, watch Epik and Dynadot

Commit `aac7d44`, pushed 7 November 2026. The first run on the new code was GitHub Actions run 42395765462 (manual dispatch, 17:20 UTC), and it succeeded. Its data commit is `e388485`.

## Why

cryptoweed.com transferred from Epik LLC (IANA 617) to Dynadot (IANA 472) on 1 November 2026. The watcher had two blind spots:

- The registrar WHOIS lookup was hard-coded to `whois.epik.com`. After the transfer it kept recording Epik's reply as "the registrar" and never asked Dynadot.
- The registrar RDAP lookup already followed the registry's link to the current registrar, so the November snapshots did contain Dynadot's RDAP. But the code stored it under `epik_data`, and the reports headed that column "EPIK Value". That label was wrong once the domain left Epik.

## What changed

### `src/query.js`
- **Registry WHOIS is queried first.** The watcher reads its `Registrar WHOIS Server:` line and sends the registrar WHOIS query there (`whois.dynadot.com` for cryptoweed.com). If the registry doesn't name a server, it falls back to `whois.epik.com`.
- **Epik's WHOIS is still queried** whenever Epik is no longer the registrar of record, so the watcher keeps a record of what Epik publishes about a name it no longer sponsors.
- **Watched RDAP servers.** Every domain is now looked up directly on each server in `watch_rdap_servers`, at `<server>/domain/<name>`. The default list:
  ```json
  "watch_rdap_servers": {
    "epik": "https://rdap.epik.com",
    "dynadot": "https://rdap.dynadot.com"
  }
  ```
  To change the list, add that key to `config.json`. Each reply is stored as returned, with its URL, HTTP status and fetch time. A 404 is kept too, because it shows the server doesn't claim the name.
- Unchanged: registry RDAP still comes from `rdap.org`, and the watcher still follows the registry's `related` link to the current registrar's RDAP.

### `src/parse.js`
- **New check: `analyzeCrossRegistrar`.** It compares each source's registrar and IANA ID with the registry's and writes the results to `parsed.cross_registrar`. If any source names a different registrar than the registry, it adds `anomalies.stale_sponsorship`.
- The status-mismatch anomaly now reads "Registrar (...) vs Registry (...)" instead of "Epik (...)".
- `parseDomainData` takes a sixth argument (`extras`) carrying the new data. The original five-argument call still works.

### `src/run.js`
- Snapshots now hold three more raw items: `raw.registrar_whois_server`, `raw.epik_whois` and `raw.watched_rdap`.

### `src/hash.js`
- `cross_registrar` is left out of `fields_hash`, the same way `anomalies`, `epik_data` and `registry_data` already were. The new data doesn't trigger change alerts by itself. A real registrar change still does, because it changes the registry fields.

### `src/report.js` and `src/ui.js`
- Each domain in the daily report gets a **Cross-Registrar Check** table: whois.epik.com (when queried), then each watched RDAP server, showing registrar, IANA ID, updated and expires. A stale-sponsorship warning appears under the table when one applies.
- The "EPIK Value" column header is now "Registrar Value", in the markdown report and in `ui.js`.

## Not changed

- `index.html` (the dashboard) still says "EPIK Value". It has separate local edits that aren't committed, so I left it alone.
- No new dependencies. The workflow, schedule and commit step are unchanged.
- The old snapshots haven't been rewritten. Snapshots from before `aac7d44` keep their old layout. The `raw.registrar` field in them holds Epik's WHOIS reply, including after the 1 November transfer.

## First result

The first run flagged cryptoweed.com:

| Source | Says |
|---|---|
| Registry (Verisign) | Dynadot Inc, IANA 472, expires 2028-03-18 |
| Dynadot RDAP | 200, DYNADOT LLC, IANA 472, expires 2028-03-18 |
| Epik RDAP | 404 |
| whois.epik.com | **Epik LLC, IANA 617, expires 2027-03-18** |

Epik's port-43 WHOIS still reports itself as registrar of cryptoweed.com, while its own RDAP returns 404. The older snapshots show it has done this in every run since the transfer: all the 1 to 7 November snapshots have it in `raw.registrar`.

The other domains: epikraaviolations.com, epikroidsarefake.org and masterbucks.com are 200 at Epik and 404 at Dynadot. forensicexam.info is 404 everywhere (deleted at the registry).

## Known behaviour, not addressed here

- Values parsed from WHOIS text come out in lower case (`epik llc`, `2027-03-18t21:40:46z`). The text parser has always done this.
- The top-level `updated` field takes the later of "last changed" and "last update of RDAP database". The second moves on every query, which is why the daily reports show most domains as "changed: updated" in almost every run. Preferring "last changed" would fix it, but it would change `fields_hash` once for every domain.

## Addendum: website and marketplace monitors (second change, 7 November 2026)

A new module, `src/web.js`, runs for every domain on every run. Turn it off with `"web_capture": false` in `config.json`.

### What it captures (stored in `raw.web`)
- **Redirect chains** for `http://<domain>/` and `https://<domain>/`, followed one hop at a time (up to 10) and saved with each hop's URL, status, `Location` and `Server` header.
- **The final page:** its title, a 20 KB text excerpt and a SHA‑256 of the body.
- **DNS:** A and NS records, plus any lookup errors.
- **Marketplace pages,** fetched once each: Afternic, Sedo, Atom, the Dynadot marketplace and the Namecheap marketplace. Override the list with a `marketplaces` map in `config.json` (`{domain}` and `{label}` are placeholders), or set it to `false` to skip them.

### Summary fields added to `parsed`
These are part of `fields_hash`, so a change in any of them triggers an alert:

| Field | Meaning |
|---|---|
| `site_final_url` | Final URL after redirects, without query string or fragment |
| `site_status` | Final HTTP status, or `unreachable` |
| `site_title` | Final page title |
| `site_platform` | Known parking platform, e.g. `epik-parking` |
| `site_sale_signals` | Sale wording added by the owner, redirects to a marketplace host, or marketplace/parking nameservers |
| `site_disabled` | Suspension wording such as "temporarily disabled" |
| `marketplace_listed` | Marketplaces where a listing was confirmed |

New anomalies: `for_sale`, `marketplace_listing` and `site_disabled`. Each report gets a **Website & Marketplaces** section.

### Limits, stated plainly
- **Most marketplaces block automated requests.** On the first test Atom and Namecheap served a bot check (403); Afternic redirected (307); Sedo is a JavaScript app (200 or 503); the Dynadot marketplace redirected (302). These are recorded as `blocked` or `unknown` and are **not evidence either way**. The code makes no attempt to get past bot checks. A marketplace counts as `listed` only if its page loads, names the domain and contains sale wording.
- The reliable sale signals come from the domain itself: a redirect to a marketplace, a marketplace's nameservers, or sale wording on the landing page.
- **Epik's parking template is itself a sales page** on every parked domain ("Why purchase this domain with Epik? ... The domain you are buying is delivered upon purchase. Buyer Protection Program"), your own domains included. That template wording is removed before matching, and the platform is recorded in `site_platform`. Wording an owner adds still counts: the old cryptoweed.com text "We will consider reasonable offers" is flagged (checked against that text).

### First test (7 Nov 2026, local dry run)
- **cryptoweed.com:**
  - `http://cryptoweed.com/` → 301 → `http://www.registrar-transfers.com/en_US/whois-suspension-register.jsp` (200, title "Authorization"); `site_disabled` = "temporarily disabled".
  - A record 137.131.40.164.
  - The NS lookup returned no data (ENODATA), although the registry lists ns1/ns2.dynadot.com.
- **epikraaviolations.com, epikroidsarefake.org:** Epik parking, no sale signals beyond the template.
- **masterbucks.com:** live site on Cloudflare.
- **forensicexam.info:** no DNS (ENOTFOUND).

### Expect one alert
The new fields will mark every domain as "changed" once on the first run after deployment.

## Operational note

The workflow's commit step force-pushes. If a code push lands while a run is between checkout and push, that run can overwrite it. Push code between runs (the cron is `0 */4 * * *`, every four hours on the hour, though GitHub often starts it late), then check that the commit is still in `git log` after the next run.
