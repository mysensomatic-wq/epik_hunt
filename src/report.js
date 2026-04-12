'use strict';

const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Markdown helpers ──────────────────────────────────────────────────────────

function tolerateDateOffset(d1, d2) {
  if (d1 === d2) return true;
  if (typeof d1 === 'string' && typeof d2 === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(d1) && /^\d{4}-\d{2}-\d{2}T/.test(d2)) {
    const t1 = new Date(d1).getTime();
    const t2 = new Date(d2).getTime();
    if (!isNaN(t1) && !isNaN(t2) && Math.abs(t1 - t2) <= 1000) return true;
  }
  return false;
}

function mdTable3(rows) {
  if (!rows.length) return '';
  const header = '| Field | EPIK Value | Registry Value | Delta |';
  const sep    = '|-------|------------|----------------|-------|';
  const body = rows.map(([f, epikVal, regVal]) => {
    let e = epikVal ?? '—';
    let r = regVal ?? '—';
    let isDiff = (e !== r) && !tolerateDateOffset(e, r);
    
    // Ignore Discrepancy column for specifics
    let isIgnored = ['Domain Name', 'RDAP Server', 'RDAP Build'].includes(f);
    
    let d = (isDiff && !isIgnored) ? '**DISCREPANCY**' : '-';
    
    // Specifically format exactly the Epik Val discrepancy color in Markdown
    if (isDiff && !isIgnored && e !== '—') {
      e = `!!${e}!!`;
    }

    return `| ${f} | ${e} | ${r} | ${d} |`;
  }).join('\n');
  return [header, sep, body].join('\n');
}

function fmtVal(v, anomVal) {
  if (v === null || v === undefined) return '—';
  let str = Array.isArray(v) ? (v.length === 0 ? '—' : v.join(', ')) : String(v);
  if (anomVal) str += ` (⚠ Anomaly: ${anomVal})`;
  return str;
}

function fmtDiffVal(v) {
  if (v === null || v === undefined) return '*(null)*';
  if (Array.isArray(v)) return v.length === 0 ? '*(empty)*' : v.join(', ');
  return String(v);
}

// ── ICANN-style per-domain markdown section ───────────────────────────────────

/**
 * Render a full ICANN-style markdown section for a single domain.
 * @param {string} domain
 * @param {object|null} snapshot  - today's snapshot (may be null on fatal query error)
 * @param {object} diffResult     - diff record from diffDomain()
 * @returns {string}
 */
function renderIcannSection(domain, snapshot, diffResult) {
  const lines = [];
  lines.push(`---\n`);
  lines.push(`## ${domain}\n`);

  if (!snapshot) {
    lines.push(`> **Query failed** — no snapshot available for today.\n`);
    if (diffResult.error) lines.push(`> Error: ${diffResult.error}\n`);
    return lines.join('\n');
  }

  const p = snapshot.parsed || {};

  const epik = p.epik_data || p;
  const reg = p.registry_data || p;
  const anom = p.anomalies || {};

  // ── Domain Information ────────────────────────────────────────────────────
  lines.push(`### Domain Information\n`);
  lines.push(mdTable3([
    ['Domain Name',        (p.domain || domain).toUpperCase(), (p.domain || domain).toUpperCase()],
    ['Registry Domain ID', fmtVal(epik.roid, anom.roid), fmtVal(reg.roid, anom.roid)],
    ['Domain Status',      fmtVal(epik.status, anom.status), fmtVal(reg.status, anom.status)],
    ['Creation Date',      fmtVal(epik.created, anom.created), fmtVal(reg.created, anom.created)],
    ['Updated Date',       fmtVal(epik.updated, anom.updated), fmtVal(reg.updated, anom.updated)],
    ['Expiration Date',    fmtVal(epik.expires, anom.expires), fmtVal(reg.expires, anom.expires)],
    ['DNSSEC',             fmtVal(epik.dnssec, anom.dnssec), fmtVal(reg.dnssec, anom.dnssec)],
  ]));
  lines.push('');

  // ── Registrar Information ─────────────────────────────────────────────────
  lines.push(`### Registrar Information\n`);
  lines.push(mdTable3([
    ['Registrar',         fmtVal(epik.registrar, anom.registrar), fmtVal(reg.registrar, anom.registrar)],
    ['IANA ID',           fmtVal(epik.registrar_iana_id, anom.registrar_iana_id), fmtVal(reg.registrar_iana_id, anom.registrar_iana_id)],
    ['RDAP Server',       fmtVal(epik.rdap_server, anom.rdap_server), fmtVal(reg.rdap_server, anom.rdap_server)],
    ['RDAP Build',        fmtVal(epik.rdap_build, anom.rdap_build), fmtVal(reg.rdap_build, anom.rdap_build)],
    ['Abuse Email',       fmtVal(epik.abuse_email, anom.abuse_email), fmtVal(reg.abuse_email, anom.abuse_email)],
    ['Abuse Phone',       fmtVal(epik.abuse_phone, anom.abuse_phone), fmtVal(reg.abuse_phone, anom.abuse_phone)],
  ]));
  lines.push('');

  // ── Registrant Contact ────────────────────────────────────────────────────
  lines.push(`### Registrant Contact\n`);
  lines.push(mdTable3([
    ['Organization', epik.registrant_org ? fmtVal(epik.registrant_org, anom.registrant_org) : 'REDACTED FOR PRIVACY', reg.registrant_org ? fmtVal(reg.registrant_org, anom.registrant_org) : 'REDACTED FOR PRIVACY'],
    ['Country',      fmtVal(epik.registrant_country, anom.registrant_country), fmtVal(reg.registrant_country, anom.registrant_country)],
  ]));
  lines.push('');

  // ── Name Servers ──────────────────────────────────────────────────────────
  lines.push(`### Name Servers\n`);
  if (p.nameservers && p.nameservers.length) {
    lines.push(p.nameservers.map(ns => `- ${ns}`).join('\n'));
  } else {
    lines.push('- —');
  }
  lines.push('');

  // ── Changes Since Previous Snapshot ──────────────────────────────────────
  lines.push(`### Changes Since Previous Snapshot\n`);
  if (!diffResult.changed) {
    lines.push('*No changes detected.*');
  } else if (diffResult.first_seen) {
    lines.push('*First time this domain has been recorded — no previous snapshot to diff.*');
  } else {
    lines.push('| Field | Before | After |');
    lines.push('|-------|--------|-------|');
    for (const field of diffResult.fields_changed) {
      const { before, after } = diffResult.diff[field];
      lines.push(`| \`${field}\` | ${fmtDiffVal(before)} | ${fmtDiffVal(after)} |`);
    }
  }
  lines.push('');

  // ── Raw WHOIS (collapsible in rendered Markdown viewers that support HTML) ─
  const registrarRdap = snapshot.raw && snapshot.raw.registrar_rdap;
  if (registrarRdap) {
    lines.push(`### EPIK Output\n`);
    lines.push(`<details>\n<summary>Show full EPIK raw JSON output</summary>\n`);
    lines.push('```');
    lines.push(JSON.stringify(registrarRdap, null, 2));
    lines.push('```');
    lines.push(`\n</details>`);
    lines.push('');
  } else {
    // Fallback to text WHOIS if no registrar RDAP exists
    const rawText = (snapshot.raw && (snapshot.raw.registrar || snapshot.raw.tld)) || '';
    if (rawText) {
      lines.push(`### Raw WHOIS\n`);
      lines.push(`<details>\n<summary>Show raw WHOIS output</summary>\n`);
      lines.push('```');
      lines.push(rawText.trim());
      lines.push('```');
      lines.push(`\n</details>`);
      lines.push('');
    }
  }

  // ── RDAP JSON (collapsible) ─
  const tldRdap = snapshot.raw && snapshot.raw.tld_rdap;
  if (tldRdap) {
    lines.push(`### REGISTRY Output\n`);
    lines.push(`<details>\n<summary>Show full REGISTRY raw JSON output</summary>\n`);
    lines.push('```');
    lines.push(JSON.stringify(tldRdap, null, 2));
    lines.push('```');
    lines.push(`\n</details>`);
    lines.push('');
  }

  return lines.join('\n');
}

// ── Report generator ──────────────────────────────────────────────────────────

/**
 * Generate daily Markdown and JSON reports.
 *
 * @param {object[]} results    - array of diff records from diffDomain()
 * @param {object}   runMeta    - { date, started_at, rotation }
 * @param {object}   config
 * @param {object}   snapshots  - { domain: snapshotObject } map
 * @returns {{ mdPath: string, jsonPath: string }}
 */
function generateReport(results, runMeta, config, snapshots = {}) {
  ensureDir(config.reports_dir);

  const { date } = runMeta;
  const changed   = results.filter(r => r.changed);
  const unchanged = results.filter(r => !r.changed);
  const errored   = results.filter(r => r.error);

  // ── Markdown ───────────────────────────────────────────────────────────────
  const mdLines = [];
  mdLines.push(`# Epik WHOIS Watcher — ${date}\n`);
  mdLines.push(`**Run started:** ${runMeta.started_at}  `);
  mdLines.push(`**Domains queried:** ${results.length} | **Changed:** ${changed.length} | **Unchanged:** ${unchanged.length} | **Errors:** ${errored.length}\n`);

  if (runMeta.rotation && runMeta.rotation.rotated) {
    mdLines.push(
      `> **Archive rotation:** Snapshots (${runMeta.rotation.size_mb} MB) compressed to \`${runMeta.rotation.archive_path}\`\n`
    );
  }

  // Summary table
  mdLines.push(`## Summary\n`);
  mdLines.push('| Domain | Status | Fields Changed |');
  mdLines.push('|--------|--------|----------------|');
  for (const r of results) {
    const status = r.error
      ? '🔴 Error'
      : r.changed
        ? (r.first_seen ? '🆕 First seen' : '🟡 Changed')
        : '🟢 Unchanged';
    const fields = r.changed ? r.fields_changed.join(', ') : '—';
    mdLines.push(`| ${r.domain} | ${status} | ${fields} |`);
  }
  mdLines.push('');

  // Full ICANN-style per-domain sections
  mdLines.push(`## Domain Records\n`);
  for (const r of results) {
    mdLines.push(renderIcannSection(r.domain, snapshots[r.domain] || null, r));
  }

  const mdPath = path.join(config.reports_dir, `daily-${date}.md`);
  fs.writeFileSync(mdPath, mdLines.join('\n'), 'utf8');

  // ── JSON ───────────────────────────────────────────────────────────────────
  const jsonContent = {
    run_meta: {
      ...runMeta,
      domains_queried: results.length,
      changed_count:   changed.length,
      unchanged_count: unchanged.length,
      error_count:     errored.length,
    },
    results,
    snapshots: Object.fromEntries(
      Object.entries(snapshots).map(([d, s]) => [d, { parsed: s.parsed, queried_at: s.queried_at }])
    ),
  };
  const jsonPath = path.join(config.reports_dir, `daily-${date}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(jsonContent, null, 2), 'utf8');

  // ── Reports Index (for static UI) ──────────────────────────────────────────
  try {
    const files = fs.readdirSync(config.reports_dir)
      .filter(f => f.startsWith('daily-') && f.endsWith('.md'))
      .sort((a, b) => b.localeCompare(a)); // newest first
    fs.writeFileSync(path.join(config.reports_dir, 'index.json'), JSON.stringify({ files }, null, 2), 'utf8');
  } catch (err) {
    console.error(`[report] Failed to update reports/index.json: ${err.message}`);
  }

  return { mdPath, jsonPath };
}

module.exports = { generateReport };
