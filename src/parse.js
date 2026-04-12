'use strict';

function extractField(text, labels) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${escaped}\\s*:\\s*(.+)$`, 'im');
    const m = text.match(re);
    if (m && m[1].trim()) return m[1].trim().toLowerCase();
  }
  return null;
}

function extractArray(text, labels) {
  const results = [];
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${escaped}\\s*:\\s*(.+)$`, 'gim');
    let m;
    while ((m = re.exec(text)) !== null) {
      const clean = m[1].trim();
      if (clean) results.push(clean);
    }
  }
  return [...new Set(results)].sort();
}

function getVcardVal(vcardArray, prop) {
  if (!vcardArray || vcardArray[0] !== 'vcard') return null;
  const arr = vcardArray[1] || [];
  const entry = arr.find(e => e[0] === prop);
  if (!entry) return null;
  if (prop === 'adr') {
    if (entry[1] && entry[1].cc) return entry[1].cc.toUpperCase();
    return null;
  }
  // format tel properly if it is a URI
  if (prop === 'tel' && entry[2] === 'uri' && entry[3].startsWith('tel:')) {
    return entry[3].slice(4);
  }
  return entry[3];
}

function searchEntities(entities, roles, prop) {
  const q = [].concat(entities || []);
  while(q.length > 0) {
    const ent = q.shift();
    if (ent.roles && roles.some(r => ent.roles.includes(r))) {
      if (prop === 'publicIds' && ent.publicIds) return ent.publicIds;
      if (prop !== 'publicIds') {
        const val = getVcardVal(ent.vcardArray, prop);
        if (val) return val;
      }
    }
    if (ent.entities) q.push(...ent.entities);
  }
  return null;
}

function extractRdapEvents(events) {
  let created = null, updated = null, expires = null;
  for (const e of (events || [])) {
    if (/registration/i.test(e.eventAction)) created = e.eventDate;
    else if (/expiration|registrar expiration/i.test(e.eventAction)) {
       if (!expires || new Date(e.eventDate) > new Date(expires)) expires = e.eventDate;
    }
    else if (/last changed|last update of rdap database/i.test(e.eventAction)) {
       if (!updated || new Date(e.eventDate) > new Date(updated)) updated = e.eventDate;
    }
  }
  return { created, updated, expires };
}

function detectAnomalies(parsed) {
  const anomalies = {};
  
  if (parsed.created && parsed.expires) {
    if (new Date(parsed.created) > new Date(parsed.expires)) {
      anomalies.created = "Creation date is after expiration date";
      anomalies.expires = "Expiration date is before creation date";
    }
  }
  if (parsed.updated && parsed.created) {
    if (new Date(parsed.updated) < new Date(parsed.created)) {
      anomalies.updated = "Updated date is before creation date";
    }
  }
  if (parsed.abuse_email && !/^\S+@\S+\.\S+$/.test(parsed.abuse_email)) {
    anomalies.abuse_email = "Invalid email format";
  }
  if (parsed.expires) {
    if (new Date(parsed.expires) < new Date()) {
      anomalies.expires = "Domain is expired";
    }
  }
  
  // Also check if epik and registry statuses conflict
  if (parsed.epik_data && parsed.registry_data) {
    const eStatus = (parsed.epik_data.status || []).join(', ');
    const rStatus = (parsed.registry_data.status || []).join(', ');
    if (eStatus && rStatus && eStatus !== rStatus) {
      anomalies.status = `Status mismatch: Epik (${eStatus}) vs Registry (${rStatus})`;
    }
  }
  
  if (!parsed.status || parsed.status.length === 0) {
    anomalies.status = "Domain has no status codes reported";
  }
  
  parsed.anomalies = anomalies;
  return parsed;
}

function extractSubObject(rdap) {
  if (!rdap || Object.keys(rdap).length === 0) return null;
  const ev = extractRdapEvents(rdap.events);
  
  let dnssec = null;
  if (rdap.secureDNS && typeof rdap.secureDNS.delegationSigned === 'boolean') {
    dnssec = rdap.secureDNS.delegationSigned ? 'signedDelegation' : 'unsigned';
  }
  const pId = searchEntities(rdap.entities, ['registrar'], 'publicIds');
  
  let rdap_server = null;
  if (rdap.links) {
    const selfL = rdap.links.find(l => l.rel === 'self' && l.href);
    if (selfL) {
      try { rdap_server = new URL(selfL.href).origin; } catch(e) { rdap_server = selfL.href; }
    }
  }

  let rdap_build = null;
  const notices = (rdap.notices || []).concat(rdap.remarks || []);
  const srvInfo = notices.find(n => (n.title || '').toLowerCase().includes('server information'));
  if (srvInfo && srvInfo.description) {
     const buildLine = srvInfo.description.find(d => d.startsWith('Build:'));
     if (buildLine) rdap_build = buildLine.replace('Build:', '').trim();
  }

  return {
    registrar: searchEntities(rdap.entities, ['registrar'], 'fn') || searchEntities(rdap.entities, ['registrar'], 'org'),
    registrar_iana_id: pId && pId.length ? pId[0].identifier : null,
    rdap_server,
    rdap_build,
    status: [...new Set((rdap.status || []))].map(s => s.replace(/\s+(.)/g, (m, g) => g.toUpperCase())).sort(),
    nameservers: (rdap.nameservers || []).map(ns => ns.ldhName.toLowerCase()).sort(),
    created: ev.created,
    updated: ev.updated,
    expires: ev.expires,
    registrant_org: searchEntities(rdap.entities, ['registrant'], 'org') || searchEntities(rdap.entities, ['registrant'], 'fn'),
    registrant_country: searchEntities(rdap.entities, ['registrant'], 'adr'),
    dnssec,
    roid: rdap.handle || null,
    abuse_email: searchEntities(rdap.entities, ['abuse'], 'email'),
    abuse_phone: searchEntities(rdap.entities, ['abuse'], 'tel')
  };
}

function parseDomainData(rawReg, rawTld, registrarRdap, tldRdap, domain) {
  // Gracefully fallback to old parser if neither RDAP is valid
  if ((!registrarRdap || registrarRdap.error) && (!tldRdap || tldRdap.error)) {
     const raw = rawReg || rawTld || '';
     const p = parseWhoisText(raw, domain);
     return detectAnomalies(p);
  }

  // Merge the two JSons (registrar takes precedence for entities, tld takes precedence for dns/status)
  const reg = (!registrarRdap || registrarRdap.error) ? {} : registrarRdap;
  const tld = (!tldRdap || tldRdap.error) ? {} : tldRdap;
  
  const epik_data = extractSubObject(reg);
  const registry_data = extractSubObject(tld);
  
  const entities = (reg.entities || []).concat(tld.entities || []);
  const events = (reg.events || []).concat(tld.events || []);
  
  const ev = extractRdapEvents(events);
  
  const nameservers = (tld.nameservers || reg.nameservers || [])
      .map(ns => ns.ldhName.toLowerCase()).sort();
  const status = [...new Set((tld.status || reg.status || []))].map(s => s.replace(/\s+(.)/g, (m, g) => g.toUpperCase())).sort();
  
  let dnssec = null;
  const sec = tld.secureDNS || reg.secureDNS;
  if (sec && typeof sec.delegationSigned === 'boolean') {
    dnssec = sec.delegationSigned ? 'signedDelegation' : 'unsigned';
  }

  let rdap_server = null;
  let rdap_build = null;
  const links = (tld.links || []).concat(reg.links || []);
  const selfL = links.find(l => l.rel === 'self' && l.href);
  if (selfL) {
    try { rdap_server = new URL(selfL.href).origin; } catch(e) { rdap_server = selfL.href; }
  }

  const notices = (tld.notices || []).concat(tld.remarks || []).concat(reg.notices || []).concat(reg.remarks || []);
  const srvInfo = notices.find(n => (n.title || '').toLowerCase().includes('server information'));
  if (srvInfo && srvInfo.description) {
     const buildLine = srvInfo.description.find(d => d.startsWith('Build:'));
     if (buildLine) rdap_build = buildLine.replace('Build:', '').trim();
  }

  const pId = searchEntities(entities, ['registrar'], 'publicIds');
  const registrar_iana_id = pId && pId.length ? pId[0].identifier : null;
  
  const roid = tld.handle || reg.handle || null;

  const parsed = {
    domain: (domain || '').toLowerCase().trim(),
    registrar: searchEntities(entities, ['registrar'], 'fn') || searchEntities(entities, ['registrar'], 'org'),
    registrar_iana_id,
    rdap_server,
    rdap_build,
    status,
    nameservers,
    created: ev.created,
    updated: ev.updated,
    expires: ev.expires,
    registrant_org: searchEntities(entities, ['registrant'], 'org') || searchEntities(entities, ['registrant'], 'fn'),
    registrant_country: searchEntities(entities, ['registrant'], 'adr'),
    dnssec,
    roid,
    abuse_email: searchEntities(entities, ['abuse'], 'email'),
    abuse_phone: searchEntities(entities, ['abuse'], 'tel'),
    epik_data,
    registry_data
  };
  
  // For any missing fields, try a quick text scrape fallback
  const rawFallback = rawReg || rawTld || '';
  if (rawFallback) {
     const textFallback = parseWhoisText(rawFallback, domain);
     for (const k of Object.keys(parsed)) {
       if ((!parsed[k] || parsed[k].length === 0) && textFallback[k]) {
         parsed[k] = textFallback[k];
       }
     }
  }

  return detectAnomalies(parsed);
}

function parseWhoisText(raw, domain) {
  if (!raw || typeof raw !== 'string') {
    return {
      domain: (domain || '').toLowerCase().trim(),
      registrar: null, registrar_iana_id: null, rdap_server: null, rdap_build: null,
      status: [], nameservers: [], created: null, updated: null,
      expires: null, registrant_org: null, registrant_country: null,
      dnssec: null, roid: null, abuse_email: null, abuse_phone: null
    };
  }
  const text = raw;
  return {
    domain: domain.toLowerCase().trim(),
    registrar: extractField(text, ['Registrar', 'registrar']),
    registrar_iana_id: extractField(text, ['Registrar IANA ID', 'registrar iana id']),
    rdap_server: extractField(text, ['Registrar WHOIS Server', 'WHOIS Server', 'whois server']),
    rdap_build: null,
    status: extractArray(text, ['Domain Status', 'Status', 'status']),
    nameservers: extractArray(text, ['Name Server', 'Nameserver', 'nserver', 'name server']),
    created: extractField(text, ['Creation Date', 'Created Date', 'Domain Registration Date', 'created', 'Registered']),
    updated: extractField(text, ['Updated Date', 'Last Updated Date', 'Last Modified', 'changed', 'modified', 'updated']),
    expires: extractField(text, ['Registry Expiry Date', 'Registrar Registration Expiration Date', 'Expiration Date', 'Expiry Date', 'expires', 'paid-till']),
    registrant_org: extractField(text, ['Registrant Organization', 'Registrant Organisation', 'org']),
    registrant_country: extractField(text, ['Registrant Country', 'country']),
    dnssec: extractField(text, ['DNSSEC', 'dnssec']),
    roid: extractField(text, ['Registry Domain ID', 'Domain ID']),
    abuse_email: extractField(text, ['Registrar Abuse Contact Email', 'abuse contact email']),
    abuse_phone: extractField(text, ['Registrar Abuse Contact Phone', 'abuse contact phone']),
  };
}

module.exports = { parseDomainData, parseWhois: parseWhoisText };
