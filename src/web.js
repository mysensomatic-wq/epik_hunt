'use strict';

// Website and marketplace capture.
//
// For each domain:
//  - follows http:// and https:// redirect chains hop by hop (up to 10), recording
//    each hop's URL, status, Location and Server header;
//  - keeps the final page's title, a text excerpt (20 KB) and a SHA-256 of the body;
//  - resolves A and NS records;
//  - flags sale signals (sale wording on the page, a redirect to a marketplace host,
//    or nameservers that belong to a marketplace or parking service) and
//    "disabled" wording (e.g. a registrar suspension page);
//  - fetches each configured marketplace page once. Many marketplaces block automated
//    requests; a blocked page is recorded as "blocked" and never treated as evidence
//    either way. No attempt is made to get past bot checks.

const crypto = require('crypto');
const dns = require('dns').promises;
const fetch = require('node-fetch');
const AbortController = globalThis.AbortController || require('abort-controller');

const UA = 'Mozilla/5.0 (compatible; epik-watcher/1.1; +https://github.com/mysensomatic-wq/epik_hunt)';
const MAX_HOPS = 10;
const TIMEOUT_MS = 20_000;
const EXCERPT_CHARS = 20_000;

// "Contact owner" alone is not used: Epik puts it on every parked page, including domains
// that are not for sale.
const SALE_TEXT = /\b(is for sale|for sale|buy (this domain|now)|make (an )?offer|reasonable offers|purchase this domain|domain may be for sale|get this domain|inquire (about|now))\b/i;
const DISABLED_TEXT = /\b(temporarily disabled|domain (has been )?suspended|account suspended|this domain is (not|no longer) active|domain (is )?on hold)\b/i;
const MARKET_HOSTS = /(^|\.)(afternic\.com|sedo\.com|dan\.com|atom\.com|squadhelp\.com|uniregistry\.com|undeveloped\.com|bodis\.com|parkingcrew\.net|above\.com|sav\.com|efty\.com|hugedomains\.com|buydomains\.com)$/i;
const MARKET_PATHS = /(godaddy\.com\/(forsale|domainsearch)|dynadot\.com\/(market|forsale)|namecheap\.com\/(market|domains\/marketplace)|epik\.com\/(market|domain-for-sale))/i;
const MARKET_NS = /(afternic\.com|sedoparking\.com|dan\.com|bodis\.com|parkingcrew\.net|above\.com|uniregistrymarket\.link|undeveloped\.com|hugedomains\.com|domaincontrol\.com\.parking)$/i;
const BLOCK_TEXT = /just a moment|cf-chl|captcha|access denied|enable javascript and cookies|attention required/i;

const DEFAULT_MARKETPLACES = {
  afternic: 'https://www.afternic.com/domain/{domain}',
  sedo: 'https://sedo.com/search/details/?domain={domain}',
  atom: 'https://www.atom.com/name/{label}',
  dynadot_market: 'https://www.dynadot.com/market/user-listings/{domain}',
  namecheap_market: 'https://www.namecheap.com/market/buynow/{domain}/',
};

function sha256(s) { return crypto.createHash('sha256').update(s || '').digest('hex'); }

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out`)), ms); })])
    .finally(() => clearTimeout(t));
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function titleOf(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlToText(m[1]).slice(0, 300) : null;
}

async function getOnce(url) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' } });
    const body = await res.text();
    clearTimeout(id);
    return { status: res.status, location: res.headers.get('location'), server: res.headers.get('server'), content_type: res.headers.get('content-type'), body };
  } catch (err) {
    clearTimeout(id);
    return { status: null, error: err.message };
  }
}

/** Follow a redirect chain manually so every hop is on record. */
async function followChain(startUrl) {
  const hops = [];
  let url = startUrl;
  let last = null;
  for (let i = 0; i < MAX_HOPS; i++) {
    const r = await getOnce(url);
    hops.push({ url, status: r.status, location: r.location || null, server: r.server || null, error: r.error || null });
    last = r;
    if (r.status && r.status >= 300 && r.status < 400 && r.location) {
      try { url = new URL(r.location, url).toString(); } catch (e) { break; }
      continue;
    }
    break;
  }
  const body = last && last.body ? last.body : '';
  const text = htmlToText(body);
  return {
    start_url: startUrl,
    hops,
    final_url: hops.length ? hops[hops.length - 1].url : startUrl,
    final_status: last ? last.status : null,
    final_error: last && last.error ? last.error : null,
    content_type: last ? last.content_type || null : null,
    title: titleOf(body),
    body_sha256: body ? sha256(body) : null,
    body_length: body.length,
    text_excerpt: text.slice(0, EXCERPT_CHARS),
  };
}

async function resolveDns(domain) {
  const out = { a: [], ns: [], errors: [] };
  try { out.a = (await withTimeout(dns.resolve4(domain), 10_000, 'A')).sort(); } catch (e) { out.errors.push(`A: ${e.code || e.message}`); }
  try { out.ns = (await withTimeout(dns.resolveNs(domain), 10_000, 'NS')).map(s => s.toLowerCase()).sort(); } catch (e) { out.errors.push(`NS: ${e.code || e.message}`); }
  return out;
}

function hostOf(u) { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } }

// Parking platforms whose standard template carries sale wording on every parked
// domain. The template wording is removed before matching, so only wording the owner
// added (e.g. "We will consider reasonable offers") counts as a sale signal.
const PLATFORM_TEMPLATES = [
  {
    name: 'epik-parking',
    detect: /parked using the epik parking platform|parked free,? courtesy of epik/i,
    strip: [
      /why purchase this domain with epik\??/gi,
      /the domain you are buying is delivered upon purchase\.?/gi,
      /buyer protection program/gi,
      /buy with confidence\.?/gi,
      /your purchase is secured by epik\.?/gi,
      /secure (&|and) instant domain delivery/gi,
    ],
  },
];

function platformOf(chains) {
  for (const c of chains) {
    if (!c) continue;
    const blob = `${c.title || ''} ${c.text_excerpt || ''}`;
    for (const p of PLATFORM_TEMPLATES) if (p.detect.test(blob)) return p;
  }
  return null;
}

function saleSignals(chains, dnsInfo) {
  const sig = new Set();
  const platform = platformOf(chains);
  for (const c of chains) {
    if (!c) continue;
    let blob = `${c.title || ''} ${c.text_excerpt || ''}`;
    if (platform) for (const re of platform.strip) blob = blob.replace(re, ' ');
    if (SALE_TEXT.test(blob)) sig.add(`page text: "${(blob.match(SALE_TEXT) || [''])[0].toLowerCase()}"`);
    for (const h of c.hops) {
      const host = hostOf(h.url);
      if (MARKET_HOSTS.test(host) || MARKET_PATHS.test(h.url)) sig.add(`redirect to marketplace: ${host}`);
    }
  }
  for (const ns of dnsInfo.ns || []) if (MARKET_NS.test(ns)) sig.add(`marketplace/parking nameserver: ${ns}`);
  return [...sig].sort();
}

function disabledSignal(chains) {
  for (const c of chains) {
    if (!c) continue;
    const blob = `${c.title || ''} ${c.text_excerpt || ''}`;
    const m = blob.match(DISABLED_TEXT);
    if (m) return m[0].toLowerCase();
  }
  return null;
}

/** Strip query strings and fragments so tracking parameters don't register as changes. */
function normUrl(u) {
  try { const x = new URL(u); return `${x.protocol}//${x.hostname.toLowerCase()}${x.pathname}`; } catch (e) { return u || null; }
}

async function checkMarketplaces(domain, config, sleep, rateMs) {
  const tpl = config.marketplaces || DEFAULT_MARKETPLACES;
  const label = domain.split('.')[0];
  const out = {};
  for (const [name, t] of Object.entries(tpl)) {
    await sleep(rateMs);
    const url = t.replace('{domain}', encodeURIComponent(domain)).replace('{label}', encodeURIComponent(label));
    const r = await getOnce(url);
    const body = r.body || '';
    const text = htmlToText(body);
    const blocked = r.status === 403 || r.status === 429 || BLOCK_TEXT.test(body.slice(0, 20000));
    const mentions = (text.toLowerCase().match(new RegExp(domain.replace(/\./g, '\\.'), 'g')) || []).length;
    let state = 'unknown';
    if (r.error) state = 'error';
    else if (blocked) state = 'blocked';
    else if (r.status === 200 && mentions > 0 && SALE_TEXT.test(text)) state = 'listed';
    out[name] = { url, http_status: r.status, location: r.location || null, state, mentions, blocked, title: titleOf(body), body_sha256: body ? sha256(body) : null, error: r.error || null, fetched_at: new Date().toISOString() };
  }
  return out;
}

/**
 * Capture the website, DNS and marketplace state for a domain.
 * @returns {Promise<{raw: object, summary: object}>}
 */
async function captureWeb(domain, config, sleep) {
  const rateMs = config.whois_rate_limit_ms || 1200;
  const captured_at = new Date().toISOString();
  const dnsInfo = await resolveDns(domain);
  const http = await followChain(`http://${domain}/`);
  await sleep(rateMs);
  const https = await followChain(`https://${domain}/`);
  const marketplaces = config.marketplaces === false ? {} : await checkMarketplaces(domain, config, sleep, rateMs);

  const primary = http.final_status ? http : https;
  const summary = {
    site_final_url: primary.final_status ? normUrl(primary.final_url) : null,
    site_status: primary.final_status || (primary.final_error ? 'unreachable' : null),
    site_title: primary.title || null,
    site_sale_signals: saleSignals([http, https], dnsInfo),
    site_disabled: disabledSignal([http, https]),
    site_platform: (platformOf([http, https]) || {}).name || null,
    marketplace_listed: Object.entries(marketplaces).filter(([, v]) => v.state === 'listed').map(([k]) => k).sort(),
  };
  return { raw: { captured_at, dns: dnsInfo, http, https, marketplaces }, summary };
}

module.exports = { captureWeb, followChain, saleSignals, normUrl };
