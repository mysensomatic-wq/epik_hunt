'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');

const PORT = 3000;

// ── Config & data helpers ─────────────────────────────────────────────────────

function loadConfig() {
  const p = path.resolve(__dirname, '..', 'config.json');
  if (!fs.existsSync(p)) return {
    domains_file: 'domains.txt', snapshots_dir: 'snapshots',
    archives_dir: 'archives', reports_dir: 'reports',
    ledger_file: 'ledger.json',
  };
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function resolve(rel) { return path.resolve(__dirname, '..', rel); }

function loadLedger(cfg) {
  const p = resolve(cfg.ledger_file);
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function loadSnapshot(domain, date, cfg) {
  const p = path.join(resolve(cfg.snapshots_dir), date, domain + '.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function getDomains(cfg) {
  const p = resolve(cfg.domains_file);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').map(l => l.trim().toLowerCase()).filter(Boolean);
}

function fieldDiff(before, after) {
  const diff = {};
  const changed = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    if (['domain', 'anomalies', 'epik_data', 'registry_data'].includes(k)) continue;
    const b = (before || {})[k] ?? null;
    const a = (after || {})[k] ?? null;
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      changed.push(k);
      diff[k] = { before: b, after: a };
    }
  }
  return { fields_changed: changed.sort(), diff };
}

// ── Simple Markdown → HTML (covers our report format exactly) ─────────────────

function mdToHtml(md) {
  const lines = md.split('\n');
  const out   = [];
  let inTable = false, tableBody = false, inList = false, inDetails = false, inCode = false;

  const closeList  = () => { if (inList)  { out.push('</ul>');   inList  = false; } };
  const closeTable = () => {
    if (inTable) {
      if (tableBody) out.push('</tbody>');
      out.push('</table>');
      inTable = false; tableBody = false;
    }
  };
  const inline = s => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')  // basic safety first
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/!!(.+?)!!/g, '<span style="color:#ef4444;font-weight:bold" title="Anomaly flagged for this value">$1</span>');

  for (const raw of lines) {
    const line = raw;
    const t    = line.trim();

    // details open/close
    if (t === '<details>') { closeList(); closeTable(); out.push('<details>'); inDetails = true; continue; }
    if (t === '</details>') { out.push('</details>'); inDetails = false; continue; }
    if (t.startsWith('<summary>')) { out.push(t); continue; }

    // fenced code block (```...```)
    if (t.startsWith('```')) {
      if (!inCode) {
        closeList(); closeTable();
        inCode = true;
        out.push('<pre class="raw-block" style="display:block; white-space:pre-wrap;">');
      } else {
        inCode = false;
        out.push('</pre>');
      }
      continue;
    }
    if (inCode) {
      out.push(inline(line));
      continue;
    }

    // headings
    if (/^#{1,6} /.test(t)) {
      closeList(); closeTable();
      const lvl  = t.match(/^(#+)/)[1].length;
      const text = inline(t.replace(/^#+\s+/, ''));
      out.push('<h' + lvl + ' class="md-h' + lvl + '">' + text + '</h' + lvl + '>');
      continue;
    }

    // tables
    if (t.startsWith('|')) {
      closeList();
      const cells = t.split('|').slice(1, -1).map(c => c.trim());
      if (!inTable) {
        inTable = true; tableBody = false;
        out.push('<table class="md-table"><thead><tr>');
        cells.forEach(c => out.push('<th>' + inline(c) + '</th>'));
        out.push('</tr></thead>');
        continue;
      }
      if (cells.every(c => /^[-: ]+$/.test(c))) {
        if (!tableBody) { out.push('<tbody>'); tableBody = true; }
        continue;
      }
      out.push('<tr>' + cells.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>');
      continue;
    }

    // blockquote
    if (t.startsWith('> ')) {
      closeList(); closeTable();
      out.push('<blockquote>' + inline(t.slice(2)) + '</blockquote>');
      continue;
    }

    // list item
    if (/^[-*] /.test(t)) {
      closeTable();
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push('<li>' + inline(t.slice(2)) + '</li>');
      continue;
    }

    // horizontal rule
    if (/^---+$/.test(t)) { closeList(); closeTable(); out.push('<hr>'); continue; }

    // blank line
    if (!t) { closeList(); closeTable(); continue; }

    // paragraph
    closeTable();
    if (inList) closeList();
    out.push('<p>' + inline(t) + '</p>');
  }

  closeList(); closeTable();
  return out.join('\n');
}

// ── HTML shell ────────────────────────────────────────────────────────────────

function getHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>epik-watcher</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f1f5f9;color:#1e293b;font-size:14px;line-height:1.5}

/* Header */
.app-header{display:flex;align-items:center;justify-content:space-between;padding:0 24px;height:52px;background:#1e293b;color:#f8fafc;position:sticky;top:0;z-index:100;gap:16px}
.app-header h1{font-size:16px;font-weight:700;letter-spacing:.5px;white-space:nowrap;color:#38bdf8}
.header-meta{font-size:12px;color:#94a3b8;white-space:nowrap}
.tab-nav{display:flex;gap:4px}
.tab-btn{background:none;border:none;color:#94a3b8;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;transition:background .15s,color .15s}
.tab-btn:hover{background:#334155;color:#f8fafc}
.tab-btn.active{background:#0f172a;color:#38bdf8}

/* Layout */
main{padding:24px;max-width:1400px;margin:0 auto}
.tab{display:none}.tab.active{display:block}
.section-header{display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap}
.section-header h2{font-size:18px;font-weight:600;color:#0f172a}
.muted{color:#64748b;font-size:12px}

/* Cards */
.card{background:#fff;border-radius:10px;border:1px solid #e2e8f0;overflow:hidden}
.card-header{padding:14px 18px;border-bottom:1px solid #e2e8f0;font-weight:600;font-size:13px;background:#f8fafc;color:#475569}

/* Status badges */
.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;letter-spacing:.3px;text-transform:uppercase}
.badge-changed  {background:#fef3c7;color:#92400e}
.badge-unchanged{background:#dcfce7;color:#166534}
.badge-new      {background:#dbeafe;color:#1e40af}
.badge-never    {background:#f1f5f9;color:#64748b}
.badge-stale    {background:#f3e8ff;color:#6b21a8}
.badge-error    {background:#fee2e2;color:#991b1b}
.status-pill{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:500;background:#e0f2fe;color:#0369a1;margin:1px 2px}

/* Domain table */
.domain-table{width:100%;border-collapse:collapse}
.domain-table th{padding:10px 16px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:#64748b;border-bottom:2px solid #e2e8f0;white-space:nowrap}
.domain-table td{padding:12px 16px;border-bottom:1px solid #f1f5f9;vertical-align:middle}
.domain-table tr:last-child td{border-bottom:none}
.domain-table tr:hover td{background:#f8fafc}
.domain-link{color:#2563eb;cursor:pointer;font-weight:600;text-decoration:none;font-size:13px}
.domain-link:hover{text-decoration:underline}
.hash-cell{font-family:monospace;font-size:11px;color:#94a3b8;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Detail split view */
.detail-split{display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start}
@media(max-width:900px){.detail-split{grid-template-columns:1fr}}
.back-btn{background:none;border:1px solid #e2e8f0;color:#475569;padding:5px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:500}
.back-btn:hover{background:#f1f5f9}

/* ICANN record */
.icann-section{margin-bottom:20px}
.icann-section-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#fff;background:#2563eb;padding:6px 14px;border-radius:6px 6px 0 0;display:block}
.icann-table{width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-top:none}
.icann-table th{width:25%;padding:8px 14px;font-weight:500;color:#475569;background:#f8fafc;border-bottom:1px solid #f1f5f9;font-size:12px;text-align:left;vertical-align:top}
.icann-table td{width:37.5%;padding:8px 14px;color:#1e293b;border-bottom:1px solid #f1f5f9;font-size:13px;word-break:break-all}
.icann-table tr:last-child th,.icann-table tr:last-child td{border-bottom:none}
.ns-list{list-style:none;padding:10px 14px;border:1px solid #e2e8f0;border-top:none;font-family:monospace;font-size:12px}
.ns-list li{padding:3px 0;color:#0f172a}
.redacted{color:#94a3b8;font-style:italic}
.raw-toggle{width:100%;text-align:left;background:#f8fafc;border:1px solid #e2e8f0;border-top:none;padding:8px 14px;font-size:12px;cursor:pointer;color:#475569;font-weight:500}
.raw-toggle:hover{background:#f1f5f9}
.raw-block{background:#0f172a;color:#e2e8f0;padding:16px;font-size:11px;line-height:1.6;overflow-x:auto;display:none;font-family:monospace;border-radius:0 0 6px 6px;white-space:pre-wrap;word-break:break-all}
.raw-block.open{display:block}

/* Diff panel */
.diff-table{width:100%;border-collapse:collapse}
.diff-table th{padding:8px 12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;color:#64748b;border-bottom:2px solid #e2e8f0;text-align:left}
.diff-table td{padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:12px;vertical-align:top}
.diff-table tr:last-child td{border-bottom:none}
.diff-field{font-family:monospace;color:#475569;font-size:11px;font-weight:600}
.diff-before{color:#b91c1c;background:#fef2f2;padding:2px 5px;border-radius:3px;font-size:11px;font-family:monospace}
.diff-after {color:#15803d;background:#f0fdf4;padding:2px 5px;border-radius:3px;font-size:11px;font-family:monospace}
.no-change{color:#64748b;font-style:italic;padding:16px}

/* History */
.domain-pills{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px}
.domain-pill{padding:6px 14px;border-radius:999px;border:2px solid #e2e8f0;background:#fff;cursor:pointer;font-size:12px;font-weight:600;color:#475569;transition:all .15s}
.domain-pill.active,.domain-pill:hover{border-color:#2563eb;color:#2563eb;background:#eff6ff}
.timeline{display:flex;flex-direction:column;gap:1px}
.tl-entry{background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;margin-bottom:8px}
.tl-header{display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer;user-select:none}
.tl-header:hover{background:#f8fafc}
.tl-date{font-weight:700;font-size:13px;color:#0f172a;min-width:100px}
.tl-fields{font-size:12px;color:#64748b}
.tl-body{display:none;padding:0 16px 16px;border-top:1px solid #f1f5f9}
.tl-body.open{display:block}

/* Reports */
.reports-layout{display:grid;grid-template-columns:220px 1fr;gap:20px;align-items:start}
@media(max-width:768px){.reports-layout{grid-template-columns:1fr}}
.reports-sidebar{display:flex;flex-direction:column;gap:4px}
.report-file-btn{text-align:left;background:#fff;border:1px solid #e2e8f0;padding:10px 14px;border-radius:8px;cursor:pointer;font-size:12px;color:#475569;font-weight:500;transition:all .15s}
.report-file-btn:hover,.report-file-btn.active{background:#eff6ff;border-color:#2563eb;color:#2563eb}
.reports-main{min-height:300px}
.md-h1{font-size:22px;font-weight:700;color:#0f172a;margin:20px 0 12px}
.md-h2{font-size:17px;font-weight:700;color:#1e293b;margin:18px 0 10px;padding-bottom:6px;border-bottom:2px solid #e2e8f0}
.md-h3{font-size:14px;font-weight:700;color:#334155;margin:14px 0 8px}
.md-h4,.md-h5,.md-h6{font-size:13px;font-weight:600;color:#475569;margin:10px 0 6px}
.md-table{width:100%;border-collapse:collapse;margin:10px 0}
.md-table th{background:#f8fafc;padding:8px 12px;text-align:left;font-size:12px;font-weight:600;border:1px solid #e2e8f0}
.md-table td{padding:7px 12px;border:1px solid #e2e8f0;font-size:12px;vertical-align:top}
blockquote{border-left:4px solid #38bdf8;padding:8px 16px;background:#f0f9ff;margin:10px 0;border-radius:0 6px 6px 0;color:#0369a1;font-size:13px}
pre.raw-block{background:#0f172a;color:#e2e8f0;padding:14px;border-radius:6px;font-size:11px;overflow-x:auto;white-space:pre-wrap;margin:8px 0}
details summary{cursor:pointer;font-size:12px;color:#2563eb;padding:6px 0}
code{background:#f1f5f9;padding:1px 5px;border-radius:4px;font-size:12px;font-family:monospace;color:#be185d}
p{margin:6px 0;font-size:13px;color:#334155}
ul{margin:6px 0 6px 20px}
li{margin:3px 0;font-size:13px}
hr{border:none;border-top:1px solid #e2e8f0;margin:16px 0}

/* Log */
.log-pre{background:#0f172a;color:#94a3b8;padding:20px;border-radius:10px;font-size:11px;line-height:1.7;overflow-x:auto;white-space:pre-wrap;word-break:break-all;min-height:200px;font-family:monospace}
.btn-sm{padding:5px 12px;border-radius:6px;border:1px solid #e2e8f0;background:#fff;cursor:pointer;font-size:12px;color:#475569;font-weight:500}
.btn-sm:hover{background:#f1f5f9}
.refresh-info{font-size:11px;color:#94a3b8;margin-left:auto}
.empty-state{padding:40px;text-align:center;color:#94a3b8;font-size:13px}
</style>
</head>
<body>
<div id="app">
  <header class="app-header">
    <h1>&#x1F4E1; epik-watcher</h1>
    <span class="header-meta" id="run-meta"></span>
    <nav class="tab-nav">
      <button class="tab-btn active" onclick="switchTab('dashboard')">Dashboard</button>
      <button class="tab-btn" onclick="switchTab('history')">History</button>
      <button class="tab-btn" onclick="switchTab('reports')">Reports</button>
      <button class="tab-btn" onclick="switchTab('log')">Run Log</button>
    </nav>
  </header>

  <main>
    <!-- DASHBOARD -->
    <div id="tab-dashboard" class="tab active">
      <div id="status-view">
        <div class="section-header">
          <h2>Domain Status</h2>
          <span class="refresh-info muted" id="refresh-countdown"></span>
        </div>
        <div class="card">
          <div id="domain-table-wrap"><div class="empty-state">Loading&hellip;</div></div>
        </div>
      </div>

      <div id="detail-view" style="display:none">
        <div class="section-header">
          <button class="back-btn" onclick="closeDetail()">&#8592; All Domains</button>
          <h2 id="detail-title"></h2>
          <span class="muted" id="detail-date"></span>
        </div>
        <div class="detail-split">
          <div>
            <div class="card-header">Current Record</div>
            <div class="card" style="border-top:none;border-radius:0 0 10px 10px" id="record-panel"><div class="empty-state">Loading&hellip;</div></div>
          </div>
          <div>
            <div class="card-header">Changes from Previous Snapshot</div>
            <div class="card" style="border-top:none;border-radius:0 0 10px 10px" id="diff-panel"><div class="empty-state">Loading&hellip;</div></div>
          </div>
        </div>
      </div>
    </div>

    <!-- HISTORY -->
    <div id="tab-history" class="tab">
      <div class="section-header"><h2>Change History</h2></div>
      <div class="domain-pills" id="history-pills"></div>
      <div id="history-timeline"><div class="empty-state">Select a domain above.</div></div>
    </div>

    <!-- REPORTS -->
    <div id="tab-reports" class="tab">
      <div class="section-header"><h2>Reports</h2></div>
      <div class="reports-layout">
        <div class="reports-sidebar" id="reports-list"><div class="muted">Loading&hellip;</div></div>
        <div class="card" id="reports-content"><div class="empty-state">Select a report to view it.</div></div>
      </div>
    </div>

    <!-- LOG -->
    <div id="tab-log" class="tab">
      <div class="section-header">
        <h2>Run Log</h2>
        <button class="btn-sm" onclick="loadLog()">&#x21BA; Refresh</button>
      </div>
      <pre class="log-pre" id="log-content">Loading&hellip;</pre>
    </div>
  </main>
</div>

<script>
// ── State ─────────────────────────────────────────────────────────────────────
var currentTab = 'dashboard';
var refreshTimer = null;
var countdown = 60;
var currentDomain = null;
var historyDomain = null;

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(function(el) { el.classList.remove('active'); });
  document.querySelectorAll('.tab-btn').forEach(function(el) { el.classList.remove('active'); });
  var panel = document.getElementById('tab-' + name);
  if (panel) panel.classList.add('active');
  var btns = document.querySelectorAll('.tab-btn');
  btns.forEach(function(b) { if (b.textContent.toLowerCase().trim().startsWith(name.slice(0,4))) b.classList.add('active'); });
  currentTab = name;
  if (name === 'history')  initHistory();
  if (name === 'reports')  loadReports();
  if (name === 'log')      loadLog();
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtArr(v) {
  if (!v) return '<em class="redacted">—</em>';
  if (Array.isArray(v)) return v.length ? v.map(esc).join('<br>') : '<em class="redacted">—</em>';
  return esc(String(v));
}
function fmtVal(v) {
  if (v === null || v === undefined) return '<em class="redacted">—</em>';
  if (Array.isArray(v)) return v.length ? v.map(esc).join(', ') : '<em class="redacted">—</em>';
  return esc(String(v));
}
function fmtDiff(v) {
  if (v === null || v === undefined) return '<span class="redacted">(null)</span>';
  if (Array.isArray(v)) return v.length ? esc(v.join(', ')) : '<span class="redacted">(empty)</span>';
  return esc(String(v));
}

// ── Status auto-refresh ───────────────────────────────────────────────────────
function startRefreshTimer() {
  countdown = 60;
  clearInterval(refreshTimer);
  refreshTimer = setInterval(function() {
    countdown--;
    var el = document.getElementById('refresh-countdown');
    if (el) el.textContent = 'Auto-refresh in ' + countdown + 's';
    if (countdown <= 0) { loadStatus(); countdown = 60; }
  }, 1000);
}

function loadStatus() {
  fetch('/api/status').then(function(r) { return r.json(); }).then(function(data) {
    renderDomainTable(data);
    var meta = document.getElementById('run-meta');
    if (meta) meta.textContent = 'Today: ' + data.date;
    startRefreshTimer();
  }).catch(function(e) {
    document.getElementById('domain-table-wrap').innerHTML = '<div class="empty-state">Failed to load: ' + esc(e.message) + '</div>';
  });
}

function badgeHtml(status) {
  var labels = { changed:'Changed', unchanged:'Unchanged', new:'First Seen', never:'Never Run', stale:'Stale', error:'Error' };
  var label = labels[status] || status;
  return '<span class="badge badge-' + status + '">' + label + '</span>';
}

function renderDomainTable(data) {
  if (!data.domains || !data.domains.length) {
    document.getElementById('domain-table-wrap').innerHTML = '<div class="empty-state">No domains configured.</div>';
    return;
  }
  var rows = data.domains.map(function(d) {
    return '<tr>' +
      '<td><a class="domain-link" data-domain="' + esc(d.domain) + '" onclick="openDomain(this.dataset.domain)">' + esc(d.domain) + '</a></td>' +
      '<td>' + badgeHtml(d.status) + '</td>' +
      '<td>' + esc(d.last_checked || '—') + '</td>' +
      '<td class="hash-cell" title="' + esc(d.fields_hash || '') + '">' + esc(d.fields_hash ? d.fields_hash.slice(0,16) + '…' : '—') + '</td>' +
      '<td>' + (d.fields_changed ? esc(d.fields_changed.join(', ')) : '—') + '</td>' +
    '</tr>';
  }).join('');

  document.getElementById('domain-table-wrap').innerHTML =
    '<table class="domain-table">' +
    '<thead><tr><th>Domain</th><th>Status</th><th>Last Checked</th><th>Fields Hash</th><th>Changed Fields</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>';
}

// ── Domain detail view ────────────────────────────────────────────────────────
function openDomain(domain) {
  currentDomain = domain;
  document.getElementById('status-view').style.display = 'none';
  document.getElementById('detail-view').style.display = 'block';
  document.getElementById('detail-title').textContent = domain;
  document.getElementById('detail-date').textContent = '';
  document.getElementById('record-panel').innerHTML = '<div class="empty-state">Loading&hellip;</div>';
  document.getElementById('diff-panel').innerHTML   = '<div class="empty-state">Loading&hellip;</div>';

  fetch('/api/domain/' + encodeURIComponent(domain)).then(function(r) { return r.json(); }).then(function(data) {
    if (data.error && !data.snapshot) {
      document.getElementById('record-panel').innerHTML = '<div class="empty-state">' + esc(data.error) + '</div>';
      document.getElementById('diff-panel').innerHTML   = '<div class="empty-state">No data.</div>';
      return;
    }
    document.getElementById('detail-date').textContent = data.date ? 'Snapshot: ' + data.date : '';
    document.getElementById('record-panel').innerHTML = renderIcannRecord(data.snapshot);
    document.getElementById('diff-panel').innerHTML   = renderDiffPanel(data.diff, data.date);
  }).catch(function(e) {
    document.getElementById('record-panel').innerHTML = '<div class="empty-state">' + esc(e.message) + '</div>';
  });
}

function closeDetail() {
  currentDomain = null;
  document.getElementById('detail-view').style.display = 'none';
  document.getElementById('status-view').style.display = 'block';
}

function renderStatusPills(statusArr) {
  if (!statusArr || !statusArr.length) return '<em class="redacted">—</em>';
  return statusArr.map(function(s) { return '<span class="status-pill">' + esc(s) + '</span>'; }).join(' ');
}

function approxEqualDate(e, r) {
  if (e === r) return true;
  if (typeof e === 'string' && typeof r === 'string' && /^\\d{4}-\\d{2}-\\d{2}T/.test(e) && /^\\d{4}-\\d{2}-\\d{2}T/.test(r)) {
      var t1 = new Date(e).getTime();
      var t2 = new Date(r).getTime();
      if (!isNaN(t1) && !isNaN(t2) && Math.abs(t1 - t2) <= 1000) return true;
  }
  return false;
}

function icannRow(label, epikVal, regVal, anomVal) {
  var e = epikVal; var r = regVal;
  
  // Highlight Epik Value strictly in RED if discrepancy exists
  if (epikVal && regVal && !approxEqualDate(epikVal, regVal) && (label !== 'Domain Name') && (label !== 'RDAP Server') && (label !== 'RDAP Build')) {
     e = '<span style="color: #ef4444; font-weight: bold;">' + epikVal + '</span>';
  }
  
  var evHtml = e + (anomVal ? ' <span style="color:#ef4444;font-size:11px" title="' + esc(anomVal) + '">(⚠ Anomaly)</span>' : '');
  var rvHtml = r;

  return '<tr><th>' + esc(label) + '</th><td>' + evHtml + '</td><td>' + rvHtml + '</td></tr>';
}

function renderIcannRecord(snapshot) {
  if (!snapshot || !snapshot.parsed) return '<div class="empty-state">No snapshot data.</div>';
  var p   = snapshot.parsed;
  var anom = p.anomalies || {};
  
  var epikRaw = (snapshot.raw && snapshot.raw.registrar_rdap) ? JSON.stringify(snapshot.raw.registrar_rdap, null, 2) : 
                ((snapshot.raw && snapshot.raw.registrar) || '');
  var regRaw  = (snapshot.raw && snapshot.raw.tld_rdap) ? JSON.stringify(snapshot.raw.tld_rdap, null, 2) : 
                ((snapshot.raw && snapshot.raw.tld) || '');
                
  var domainUp = (p.domain || '').toUpperCase();

  var epik = p.epik_data || p;
  var reg  = p.registry_data || p;

  var html = '<div style="padding:16px">';

  // Domain Information
  html += '<div class="icann-section">';
  html += '<span class="icann-section-title">Domain Information</span>';
  html += '<table class="icann-table">';
  html += '<thead><tr><th>Field</th><th>EPIK Value</th><th>Registry Value</th></tr></thead><tbody>';
  html += icannRow('Domain Name', '<strong>' + esc(domainUp) + '</strong>', '<strong>' + esc(domainUp) + '</strong>');
  if (p.roid) html += icannRow('Registry Domain ID', esc(epik.roid), esc(reg.roid), anom.roid);
  html += icannRow('Domain Status', renderStatusPills(epik.status), renderStatusPills(reg.status), anom.status);
  html += icannRow('Creation Date',  fmtVal(epik.created), fmtVal(reg.created), anom.created);
  html += icannRow('Updated Date',   fmtVal(epik.updated), fmtVal(reg.updated), anom.updated);
  html += icannRow('Expiration Date',fmtVal(epik.expires), fmtVal(reg.expires), anom.expires);
  html += icannRow('DNSSEC',         fmtVal(epik.dnssec), fmtVal(reg.dnssec), anom.dnssec);
  html += '</tbody></table></div>';

  // Registrar Information
  html += '<div class="icann-section">';
  html += '<span class="icann-section-title">Registrar Information</span>';
  html += '<table class="icann-table">';
  html += '<thead><tr><th>Field</th><th>EPIK Value</th><th>Registry Value</th></tr></thead><tbody>';
  html += icannRow('Registrar',     fmtVal(epik.registrar), fmtVal(reg.registrar), anom.registrar);
  html += icannRow('IANA ID',       fmtVal(epik.registrar_iana_id), fmtVal(reg.registrar_iana_id), anom.registrar_iana_id);
  html += icannRow('RDAP Server',   fmtVal(epik.rdap_server), fmtVal(reg.rdap_server), anom.rdap_server);
  html += icannRow('RDAP Build',    fmtVal(epik.rdap_build), fmtVal(reg.rdap_build), anom.rdap_build);
  if (p.abuse_email) html += icannRow('Abuse Email', esc(epik.abuse_email), esc(reg.abuse_email), anom.abuse_email);
  if (p.abuse_phone) html += icannRow('Abuse Phone', esc(epik.abuse_phone), esc(reg.abuse_phone), anom.abuse_phone);
  html += '</tbody></table></div>';

  // Registrant Contact
  html += '<div class="icann-section">';
  html += '<span class="icann-section-title">Registrant Contact</span>';
  html += '<table class="icann-table">';
  html += '<thead><tr><th>Field</th><th>EPIK Value</th><th>Registry Value</th></tr></thead><tbody>';
  html += icannRow('Organization', epik.registrant_org ? esc(epik.registrant_org) : '<span class="redacted">REDACTED FOR PRIVACY</span>', reg.registrant_org ? esc(reg.registrant_org) : '<span class="redacted">REDACTED FOR PRIVACY</span>', anom.registrant_org);
  html += icannRow('Country', fmtVal(epik.registrant_country), fmtVal(reg.registrant_country), anom.registrant_country);
  html += '</tbody></table></div>';

  // Name Servers
  html += '<div class="icann-section">';
  html += '<span class="icann-section-title">Name Servers</span>';
  html += '<ul class="ns-list">';
  if (anom.nameservers) {
     html += '<li><span style="color:#ef4444;font-weight:bold" title="' + esc(anom.nameservers) + '">Anomaly detected</span></li>';
  }
  if (p.nameservers && p.nameservers.length) {
    p.nameservers.forEach(function(ns) { html += '<li>' + esc(ns) + '</li>'; });
  } else {
    html += '<li><em class="redacted">—</em></li>';
  }
  html += '</ul></div>';

  // EPIK Raw JSON
  if (epikRaw) {
    var rawId = 'raw-' + Math.random().toString(36).slice(2);
    html += '<div class="icann-section">';
    html += '<span class="icann-section-title">EPIK Output</span>';
    html += '<button class="raw-toggle" data-target="' + rawId + '" onclick="toggleRaw(this.dataset.target)">&#9660; Show full EPIK raw JSON output</button>';
    html += '<pre class="raw-block" id="' + rawId + '">' + esc(epikRaw) + '</pre>';
    html += '</div>';
  }

  // REGISTRY Raw JSON
  if (regRaw) {
    var rawId2 = 'raw-' + Math.random().toString(36).slice(2);
    html += '<div class="icann-section">';
    html += '<span class="icann-section-title">REGISTRY Output</span>';
    html += '<button class="raw-toggle" data-target="' + rawId2 + '" onclick="toggleRaw(this.dataset.target)">&#9660; Show full REGISTRY raw JSON output</button>';
    html += '<pre class="raw-block" id="' + rawId2 + '">' + esc(regRaw) + '</pre>';
    html += '</div>';
  }

  html += '</div>';
  return html;
}

function toggleRaw(id) {
  var el = document.getElementById(id);
  if (el) el.classList.toggle('open');
}

function renderDiffPanel(diff, date) {
  if (!diff) {
    return '<div class="empty-state" style="padding:24px">No previous snapshot to compare against.</div>';
  }
  if (!diff.fields_changed || !diff.fields_changed.length) {
    return '<div class="no-change">&#10003; No changes detected since ' + esc(diff.from_date || 'last snapshot') + '.</div>';
  }

  var html = '<div style="padding:0">';
  html += '<div style="padding:10px 16px;font-size:11px;color:#64748b;border-bottom:1px solid #f1f5f9">';
  html += esc(diff.from_date || '?') + ' &rarr; ' + esc(date || diff.to_date || '?') + ' &nbsp;&bull;&nbsp; ' + diff.fields_changed.length + ' field(s) changed';
  html += '</div>';
  html += '<table class="diff-table">';
  html += '<thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>';
  diff.fields_changed.forEach(function(field) {
    var d = diff.diff[field];
    html += '<tr>';
    html += '<td class="diff-field">' + esc(field) + '</td>';
    html += '<td><span class="diff-before">' + fmtDiff(d.before) + '</span></td>';
    html += '<td><span class="diff-after">'  + fmtDiff(d.after)  + '</span></td>';
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  return html;
}

// ── History tab ───────────────────────────────────────────────────────────────
function initHistory() {
  fetch('/api/status').then(function(r) { return r.json(); }).then(function(data) {
    var pills = document.getElementById('history-pills');
    if (!pills) return;
    pills.innerHTML = data.domains.map(function(d) {
      return '<button class="domain-pill" data-domain="' + esc(d.domain) + '" onclick="loadHistory(this.dataset.domain)">' + esc(d.domain) + '</button>';
    }).join('');
  });
}

function loadHistory(domain) {
  historyDomain = domain;
  document.querySelectorAll('.domain-pill').forEach(function(p) {
    p.classList.toggle('active', p.textContent === domain);
  });
  document.getElementById('history-timeline').innerHTML = '<div class="empty-state">Loading&hellip;</div>';

  fetch('/api/history/' + encodeURIComponent(domain)).then(function(r) { return r.json(); }).then(function(data) {
    renderTimeline(data);
  }).catch(function(e) {
    document.getElementById('history-timeline').innerHTML = '<div class="empty-state">' + esc(e.message) + '</div>';
  });
}

function renderTimeline(data) {
  var el = document.getElementById('history-timeline');
  if (!data.entries || !data.entries.length) {
    el.innerHTML = '<div class="empty-state">No history recorded for this domain yet.</div>';
    return;
  }

  var html = '<div class="timeline">';
  var entries = data.entries.slice().reverse(); // newest first
  entries.forEach(function(entry, i) {
    var bodyId = 'tl-body-' + i;
    var hasChange = entry.changed && entry.fields_changed && entry.fields_changed.length;
    html += '<div class="tl-entry">';
    html += '<div class="tl-header" data-target="' + bodyId + '" onclick="toggleTlEntry(this.dataset.target)">';
    html += '<span class="tl-date">' + esc(entry.date) + '</span>';
    html += '<span>' + badgeHtml(hasChange ? 'changed' : (entry.first ? 'new' : 'unchanged')) + '</span>';
    if (hasChange) {
      html += '<span class="tl-fields">' + esc(entry.fields_changed.join(', ')) + '</span>';
    }
    html += '</div>';
    if (hasChange) {
      html += '<div class="tl-body" id="' + bodyId + '">';
      html += '<table class="diff-table" style="margin-top:8px"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>';
      entry.fields_changed.forEach(function(field) {
        var d = entry.diff[field];
        html += '<tr><td class="diff-field">' + esc(field) + '</td>';
        html += '<td><span class="diff-before">' + fmtDiff(d.before) + '</span></td>';
        html += '<td><span class="diff-after">'  + fmtDiff(d.after)  + '</span></td></tr>';
      });
      html += '</tbody></table></div>';
    }
    html += '</div>';
  });
  html += '</div>';
  el.innerHTML = html;
}

function toggleTlEntry(id) {
  var el = document.getElementById(id);
  if (el) el.classList.toggle('open');
}

// ── Reports tab ───────────────────────────────────────────────────────────────
function loadReports() {
  fetch('/api/reports').then(function(r) { return r.json(); }).then(function(data) {
    var list = document.getElementById('reports-list');
    if (!data.files || !data.files.length) {
      list.innerHTML = '<div class="muted">No reports yet.</div>';
      return;
    }
    list.innerHTML = data.files.map(function(f) {
      return '<button class="report-file-btn" data-file="' + esc(f) + '" onclick="loadReport(this.dataset.file)">' + esc(f) + '</button>';
    }).join('');
  });
}

function loadReport(file) {
  document.querySelectorAll('.report-file-btn').forEach(function(b) {
    b.classList.toggle('active', b.textContent === file);
  });
  document.getElementById('reports-content').innerHTML = '<div class="empty-state">Loading&hellip;</div>';
  fetch('/api/report/' + encodeURIComponent(file)).then(function(r) { return r.json(); }).then(function(data) {
    document.getElementById('reports-content').innerHTML = '<div style="padding:20px">' + data.html + '</div>';
  }).catch(function(e) {
    document.getElementById('reports-content').innerHTML = '<div class="empty-state">' + esc(e.message) + '</div>';
  });
}

// ── Log tab ───────────────────────────────────────────────────────────────────
function loadLog() {
  fetch('/api/log').then(function(r) { return r.json(); }).then(function(data) {
    document.getElementById('log-content').textContent = data.lines || '(no log available)';
  }).catch(function(e) {
    document.getElementById('log-content').textContent = 'Error: ' + e.message;
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
loadStatus();
</script>
</body>
</html>`;
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();

app.get('/', (_req, res) => res.send(getHtml()));

// Domain status list — used by table and auto-refresh
app.get('/api/status', (_req, res) => {
  const cfg     = loadConfig();
  const domains = getDomains(cfg);
  const ledger  = loadLedger(cfg);
  const today   = new Date().toISOString().slice(0, 10);

  const statuses = domains.map(domain => {
    const entries = (ledger[domain] || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    if (!entries.length) return { domain, status: 'never', last_checked: null, fields_hash: null };

    const latest = entries[entries.length - 1];
    const prev   = entries.length > 1 ? entries[entries.length - 2] : null;

    let status;
    if (latest.date !== today) {
      status = 'stale';
    } else if (!prev) {
      status = 'new';
    } else {
      status = latest.hash !== prev.hash ? 'changed' : 'unchanged';
    }

    // Surface which fields changed (load snapshot pair)
    let fields_changed = null;
    if (status === 'changed' && prev) {
      const snapToday = loadSnapshot(domain, latest.date, cfg);
      const snapPrev  = loadSnapshot(domain, prev.date, cfg);
      if (snapToday && snapPrev) {
        const d = fieldDiff(snapPrev.parsed, snapToday.parsed);
        fields_changed = d.fields_changed;
      }
    }

    return { domain, status, last_checked: latest.date, fields_hash: latest.hash, fields_changed };
  });

  res.json({ date: today, domains: statuses });
});

// Full ICANN-style record + diff for a single domain
app.get('/api/domain/:domain', (req, res) => {
  const cfg    = loadConfig();
  const domain = req.params.domain.toLowerCase();
  const ledger = loadLedger(cfg);

  const entries = (ledger[domain] || []).slice().sort((a, b) => b.date.localeCompare(a.date));
  if (!entries.length) return res.json({ domain, error: 'No ledger entries found.' });

  const latest  = entries[0];
  const snapshot = loadSnapshot(domain, latest.date, cfg);
  if (!snapshot) return res.json({ domain, date: latest.date, error: 'Snapshot file missing.' });

  let diff = null;
  if (entries.length > 1) {
    const prev     = entries[1];
    const prevSnap = loadSnapshot(domain, prev.date, cfg);
    if (prevSnap && latest.hash !== prev.hash) {
      diff = { ...fieldDiff(prevSnap.parsed, snapshot.parsed), from_date: prev.date, to_date: latest.date };
    } else if (prevSnap) {
      diff = { fields_changed: [], diff: {}, from_date: prev.date, to_date: latest.date };
    }
  }

  res.json({ domain, date: latest.date, snapshot, diff });
});

// Change history for a domain — all entries, with diffs for hash changes
app.get('/api/history/:domain', (req, res) => {
  const cfg    = loadConfig();
  const domain = req.params.domain.toLowerCase();
  const ledger = loadLedger(cfg);

  const entries = (ledger[domain] || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  if (!entries.length) return res.json({ domain, entries: [] });

  const result = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const prev  = i > 0 ? entries[i - 1] : null;

    if (!prev) {
      result.push({ date: entry.date, changed: false, first: true });
      continue;
    }

    if (entry.hash === prev.hash) {
      result.push({ date: entry.date, changed: false });
      continue;
    }

    const snapCur  = loadSnapshot(domain, entry.date, cfg);
    const snapPrev = loadSnapshot(domain, prev.date, cfg);

    if (!snapCur || !snapPrev) {
      result.push({ date: entry.date, changed: true, fields_changed: [], diff: {} });
      continue;
    }

    const d = fieldDiff(snapPrev.parsed, snapCur.parsed);
    result.push({ date: entry.date, changed: true, fields_changed: d.fields_changed, diff: d.diff });
  }

  res.json({ domain, entries: result });
});

// List report files (newest first)
app.get('/api/reports', (_req, res) => {
  const cfg      = loadConfig();
  const reportsDir = resolve(cfg.reports_dir);
  if (!fs.existsSync(reportsDir)) return res.json({ files: [] });

  const files = fs.readdirSync(reportsDir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse();

  res.json({ files });
});

// Render a single report file as HTML
app.get('/api/report/:file', (req, res) => {
  const cfg  = loadConfig();
  const file = path.basename(req.params.file); // sanitize
  const p    = path.join(resolve(cfg.reports_dir), file);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Not found' });

  const md   = fs.readFileSync(p, 'utf8');
  const html = mdToHtml(md);
  res.json({ file, html });
});

// Last 100 lines of the run log
app.get('/api/log', (_req, res) => {
  const logPath = resolve('logs/latest.log');
  if (!fs.existsSync(logPath)) return res.json({ lines: '(no log file yet — run `npm start` first)' });

  const content = fs.readFileSync(logPath, 'utf8');
  const lines   = content.split('\n');
  res.json({ lines: lines.slice(-100).join('\n') });
});

app.listen(PORT, () => {
  console.log('epik-watcher UI running at http://localhost:' + PORT);
});
