# Dashboard fork with a working History tab (7 November 2026)

## What was wrong

- The live History tab (`index.html` as committed) only listed one hash per day and said "Static history view limited".
- The watcher runs every four hours but keeps one file per domain per day (`snapshots/<date>/<domain>.json`), and every run rewrites that day's file. The earlier runs of each day survive only in git history. Any History view that reads `snapshots/` from the site can show at most the last run of each day.

## What was added

| File | What it is |
|---|---|
| `dashboard-v2.html` | A fork of the dashboard: a copy of the local working copy of `index.html` with the History tab rebuilt. "EPIK Value" is relabelled "Registrar Value", and `cross_registrar` is skipped in diffs. A "Classic" link goes back to `index.html`. |
| `src/history_index.js` | Builds `history-index/` from git: one entry for every committed version of every snapshot file, with the commit, time, run ID, git blob ID, the stored `fields_hash` and `raw_hash`, whether those hashes recompute correctly, and which fields changed from the previous version. |
| `history-index/` | The generated index: `index.json` plus one file per domain. It is derived and can be rebuilt at any time with `node src/history_index.js`. |
| `.github/workflows/daily.yml` | Two steps after the data commit: build the index, then commit `history-index/` as a separate "[watcher] history index <run>" commit. That push is not forced. |

## What was not touched

- `index.html` (live or local), `snapshots/`, `reports/`, `ledger.json`, `last_run.json` and `logs/`. The data-collection steps in the workflow are unchanged.
- No existing file was rewritten. The index lives in its own folder, and the data commit step's `file_pattern` does not include it.

## How the History tab verifies what it shows

When you open a version, the page fetches that exact file from `raw.githubusercontent.com/<repo>/<commit>/<path>`, plus the version before it. Before showing a diff it checks, in the browser:

1. **Git blob ID.** It computes SHA-1 of `"blob <size>\0" + bytes`. This must equal the blob ID git recorded, which ties the bytes to the commit.
2. **`fields_hash`.** It recomputes the hash the way `src/hash.js` does: drop `anomalies`, `epik_data`, `registry_data` and `cross_registrar`, sort keys, `JSON.stringify`, SHA-256. The result must equal the stored value.
3. **`raw_hash`.** SHA-256 of `raw.registrar` (or `raw.tld`) must equal the stored value.

A version that passes all three shows "✓✓ verified". "Verify every version against git" runs the same checks on every version of a domain.

The index itself is never trusted for content. It only says which commit and blob to fetch.

## Filters

By default the list hides versions where the only change is `updated`. That field moves on almost every run because RDAP's "last update of RDAP database" changes on every query; 880 of cryptoweed.com's 1,078 hash changes are this alone. Two checkboxes show these versions and the versions with no change. A version whose anomalies changed (for example `+stale_sponsorship`) is always shown.

## Verification done on 7 November 2026, before committing

- Our commits `aac7d44` and `58690e6` changed only `src/` files and this documentation. No data file was touched.
- All 5,086 snapshot versions in git history recompute to their stored `fields_hash` and `raw_hash`. They were checked with both the current `src/hash.js` and the original one from `e2012fa`, and the two agree for every version except the five that contain `cross_registrar`.
- All 981 ledger entries match their snapshot files. The five 2026-04-10 ledger entries have no snapshot file, and none was ever committed. That gap predates this work.
- The 146-file evidence set on E: (`cryptoweed.com Transfer Evidence 2026-11-07\SHA256SUMS.txt`) still verifies.
- In the browser, all 1,084 cryptoweed.com versions verified against GitHub's copies.
