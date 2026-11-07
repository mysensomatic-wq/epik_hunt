'use strict';

// Builds a read-only index of every committed version of every snapshot file, from git.
//
// Why: the watcher writes one file per domain per day (snapshots/<date>/<domain>.json)
// and runs every four hours, so each run overwrites that day's file. The earlier runs
// of the day survive only in git history. This index lists every version git holds,
// with the commit, the run ID, the git blob ID, and the hashes stored inside the file,
// so the dashboard can fetch any version by commit and verify it.
//
// It never writes to snapshots/, reports/, ledger.json or any other data file. Output
// goes only to history-index/. Everything in the index is derived from git and can be
// regenerated at any time with:  node src/history_index.js
//
// Each version entry:
//   commit, committed_at, run_id   - the commit that wrote this version
//   path, blob                     - file path and git blob ID (SHA-1 of the content)
//   date, queried_at               - from the snapshot
//   fields_hash, raw_hash          - as stored in the snapshot
//   fields_hash_ok, raw_hash_ok    - recomputed from the content with src/hash.js
//   hash_changed                   - fields_hash differs from the previous version
//   changed                        - parsed field names that differ from the previous version
//   anomalies                      - anomaly keys present in this version

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { hashFields, hashRaw } = require('./hash');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'history-index');
const SKIP = ['domain', 'anomalies', 'epik_data', 'registry_data', 'cross_registrar'];

function git(args, input) {
  const r = spawnSync('git', ['-C', ROOT, ...args], { input, maxBuffer: 2 ** 32 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') return Object.keys(v).sort().reduce((a, k) => { a[k] = stable(v[k]); return a; }, {});
  return v;
}

function changedFields(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const out = [];
  for (const k of keys) {
    if (SKIP.includes(k)) continue;
    const b = before && before[k] !== undefined ? before[k] : null;
    const a = after && after[k] !== undefined ? after[k] : null;
    if (JSON.stringify(stable(b)) !== JSON.stringify(stable(a))) out.push(k);
  }
  return out.sort();
}

function main() {
  // A shallow clone hides older commits and would produce a truncated index.
  if (git(['rev-parse', '--is-shallow-repository']).toString().trim() === 'true') {
    console.error('history-index: refusing to build from a shallow clone (run `git fetch --unshallow` first). Nothing written.');
    process.exit(1);
  }
  const head = git(['rev-parse', 'HEAD']).toString().trim();
  const remote = (() => { try { return git(['remote', 'get-url', 'origin']).toString().trim(); } catch (e) { return null; } })();
  const repo = remote && (remote.match(/github\.com[:/](.+?)(\.git)?$/) || [])[1] || null;

  // Every commit that touched snapshots/, oldest first, with the blob IDs it wrote.
  const log = git(['log', '--reverse', '--raw', '--no-abbrev', '--no-renames', '--format=C%x09%H%x09%cI%x09%s', '--', 'snapshots']).toString();
  const writes = [];
  let cur = null;
  for (const line of log.split('\n')) {
    if (line.startsWith('C\t')) {
      const [, commit, committed_at, subject] = line.split('\t');
      const m = subject.match(/sync data (\d+)/);
      cur = { commit, committed_at, run_id: m ? m[1] : null, subject };
    } else if (line.startsWith(':') && cur) {
      const [meta, p] = line.split('\t');
      const parts = meta.split(' ');
      const blob = parts[3], status = parts[4];
      if (status === 'D' || !p.endsWith('.json')) continue;
      const m = p.match(/^snapshots\/(\d{4}-\d{2}-\d{2})\/(.+)\.json$/);
      if (!m) continue;
      writes.push({ ...cur, path: p, blob, file_date: m[1], domain: m[2] });
    }
  }

  // Read every blob once.
  const uniq = [...new Set(writes.map(w => w.blob))];
  const out = git(['cat-file', '--batch'], uniq.join('\n') + '\n');
  const blobs = new Map();
  let pos = 0;
  while (pos < out.length) {
    const nl = out.indexOf(10, pos);
    const [sha, , size] = out.slice(pos, nl).toString().split(' ');
    blobs.set(sha, out.slice(nl + 1, nl + 1 + Number(size)).toString('utf8'));
    pos = nl + 1 + Number(size) + 1;
  }

  const byDomain = {};
  const prevParsed = {};
  const prevHash = {};
  for (const w of writes) {
    let s = null;
    try { s = JSON.parse(blobs.get(w.blob)); } catch (e) { /* recorded below */ }
    const parsed = s && s.parsed;
    const entry = {
      commit: w.commit,
      committed_at: w.committed_at,
      run_id: w.run_id,
      path: w.path,
      blob: w.blob,
      date: s ? s.date : w.file_date,
      queried_at: s ? s.queried_at || null : null,
      fields_hash: s ? s.fields_hash || null : null,
      raw_hash: s ? s.raw_hash || null : null,
      fields_hash_ok: parsed && s.fields_hash ? hashFields(parsed) === s.fields_hash : null,
      raw_hash_ok: s && s.raw_hash !== undefined ? hashRaw((s.raw && (s.raw.registrar || s.raw.tld)) || '') === s.raw_hash : null,
      hash_changed: prevHash[w.domain] === undefined ? true : prevHash[w.domain] !== (s && s.fields_hash),
      changed: parsed ? changedFields(prevParsed[w.domain], parsed) : [],
      anomalies: parsed && parsed.anomalies ? Object.keys(parsed.anomalies).sort() : [],
      first: prevHash[w.domain] === undefined,
    };
    if (!s) entry.error = 'snapshot JSON could not be parsed';
    if (entry.first) entry.changed = [];
    (byDomain[w.domain] = byDomain[w.domain] || []).push(entry);
    if (parsed) prevParsed[w.domain] = parsed;
    prevHash[w.domain] = s && s.fields_hash;
  }

  // The index only ever grows. If any domain would have fewer versions than the index
  // already on disk, something is wrong with the history being read: stop.
  const oldIndexPath = path.join(OUT, 'index.json');
  if (fs.existsSync(oldIndexPath)) {
    const old = JSON.parse(fs.readFileSync(oldIndexPath, 'utf8'));
    for (const [d, s] of Object.entries(old.domains || {})) {
      const now = (byDomain[d] || []).length;
      if (now < s.versions) {
        console.error(`history-index: ${d} would drop from ${s.versions} to ${now} versions. Refusing to overwrite. Nothing written.`);
        process.exit(1);
      }
    }
  }

  fs.mkdirSync(OUT, { recursive: true });
  const generated_at = new Date().toISOString();
  const summary = { generated_at, generator: 'src/history_index.js', head, repo, note: 'Derived from git history of snapshots/. Not evidence by itself: every entry names a commit and blob that can be checked in git.', domains: {} };
  for (const [domain, versions] of Object.entries(byDomain)) {
    const file = `${domain}.json`;
    fs.writeFileSync(path.join(OUT, file), JSON.stringify({ domain, generated_at, head, repo, versions }, null, 1) + '\n', 'utf8');
    summary.domains[domain] = {
      file,
      versions: versions.length,
      hash_changes: versions.filter(v => v.hash_changed).length,
      hash_failures: versions.filter(v => v.fields_hash_ok === false || v.raw_hash_ok === false).length,
      first: versions[0].committed_at,
      last: versions[versions.length - 1].committed_at,
    };
  }
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log(`history-index: ${writes.length} versions across ${Object.keys(byDomain).length} domains (head ${head.slice(0, 7)})`);
  for (const [d, v] of Object.entries(summary.domains)) console.log(`  ${d}: ${v.versions} versions, ${v.hash_changes} hash changes, ${v.hash_failures} hash failures`);
}

main();
