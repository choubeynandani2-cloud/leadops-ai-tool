/* LeadOps AI: dependency-free browser/Node audit engine. No I/O or network. */
(function (root) {
  'use strict';
  const LIMITS = Object.freeze({ bytes: 2097152, records: 2000, columns: 100, headerBytes: 128 });
  const encoder = new TextEncoder();
  const aliases = {
    company_name: ['company', 'companyname', 'business', 'businessname', 'organization', 'organisation', 'account', 'accountname', 'name'],
    website: ['website', 'websiteurl', 'companywebsite', 'businesswebsite', 'web', 'webpage', 'url', 'domain', 'homepage', 'webaddress'],
    source_url: ['source', 'sourceurl', 'evidenceurl', 'listingurl', 'referenceurl', 'profileurl']
  };
  class AuditError extends Error {
    constructor(code, message) { super(message); this.name = 'AuditError'; this.code = code; }
  }
  function fail(code, message) { throw new AuditError(code, message); }
  function companyKey(value) {
    return String(value).normalize('NFKC').toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ').replace(/[^\p{L}\p{N}]/gu, '');
  }
  function formulaRisk(value) {
    const string = String(value);
    const normalized = string.normalize('NFKC').replace(/^[\s\p{Cf}]+/gu, '');
    return /^[\t\r\n]/.test(string) || /^[=+@-]/.test(normalized);
  }
  function safeCell(value) { const string = String(value); return formulaRisk(string) ? "'" + string : string; }
  function websiteKey(value) {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\s\\\p{Cf}]/u.test(value)) return null;
    try {
      const authority = value.match(/^https?:\/\/([^/?#]*)/i)[1];
      if (!authority || authority.includes('@') || authority.includes('%')) return null;
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
      let host = url.hostname.toLowerCase().replace(/\.+$/, '');
      if (host.startsWith('www.')) host = host.slice(4);
      if (host.startsWith('[') && host.endsWith(']')) return host; // URL validates IPv6 syntax.
      if (!host || host.length > 253 || !host.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part))) return null;
      return host;
    } catch (_) { return null; }
  }
  function decode(input) {
    const bytes = typeof input === 'string' ? encoder.encode(input) : input;
    if (!(bytes instanceof Uint8Array)) fail('INVALID_UPLOAD', 'Choose a UTF-8 CSV file.');
    if (bytes.byteLength > LIMITS.bytes) fail('UPLOAD_TOO_LARGE', 'Your CSV exceeds 2 MB (2,097,152 bytes).');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (_) { fail('INVALID_ENCODING', 'Save your CSV as UTF-8, with or without a BOM.'); }
    if (!text.trim()) fail('EMPTY_UPLOAD', 'This file is empty. Include column headings and try again.');
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) fail('INVALID_CONTENT', 'Unsupported control characters were found. Use a plain UTF-8 CSV.');
    return text;
  }
  function delimiterFor(text) {
    const counts = { ',': 0, ';': 0, '\t': 0 };
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        if (quoted && text[i + 1] === '"') i++;
        else quoted = !quoted;
      } else if (!quoted) {
        if (c === '\r' || c === '\n') break;
        if (Object.hasOwn ? Object.hasOwn(counts, c) : Object.prototype.hasOwnProperty.call(counts, c)) counts[c]++;
      }
    }
    return [',', ';', '\t'].sort((a, b) => counts[b] - counts[a])[0];
  }
  function parseCSV(input) {
    const text = decode(input), delimiter = delimiterFor(text);
    const all = [];
    let row = [], field = '', state = 'start', touched = false;
    function endField() {
      row.push(field); field = ''; state = 'start';
      if (row.length > LIMITS.columns) fail('TOO_MANY_COLUMNS', 'Use at most 100 columns.');
    }
    function endRow() {
      if (touched || row.length || field) {
        endField(); all.push(row);
        if (all.length > LIMITS.records + 1) fail('TOO_MANY_RECORDS', 'Use at most 2,000 data records per audit.');
      }
      row = []; field = ''; state = 'start'; touched = false;
    }
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (state === 'quoted') {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else state = 'after';
        } else field += c;
        continue;
      }
      if (c === delimiter) { touched = true; endField(); continue; }
      if (c === '\r' || c === '\n') { endRow(); if (c === '\r' && text[i + 1] === '\n') i++; continue; }
      if (state === 'after') fail('MALFORMED_CSV', 'Unexpected text follows a closing quote. Check CSV quoting.');
      if (c === '"') {
        if (state !== 'start') fail('MALFORMED_CSV', 'Quotes inside a field must be doubled and the field quoted.');
        state = 'quoted'; touched = true;
      } else { field += c; state = 'plain'; touched = true; }
    }
    if (state === 'quoted') fail('MALFORMED_CSV', 'A quoted field was not closed.');
    endRow();
    const headers = all.shift();
    if (!headers || headers.some(h => !h.trim())) fail('INVALID_HEADERS', 'Every column needs a non-empty heading.');
    if (headers.some(h => encoder.encode(h).byteLength > LIMITS.headerBytes)) fail('INVALID_HEADERS', 'Column headings must be at most 128 UTF-8 bytes.');
    const keys = headers.map(companyKey);
    if (keys.some(k => !k) || new Set(keys).size !== keys.length) fail('AMBIGUOUS_HEADERS', 'Column headings must be unique after normalization.');
    const mapping = {};
    for (const [canonical, names] of Object.entries(aliases)) {
      const hits = keys.map((key, index) => names.includes(key) ? index : -1).filter(index => index >= 0);
      if (hits.length > 1) fail('AMBIGUOUS_HEADERS', 'More than one column maps to the same company, website or source field.');
      if (hits.length) mapping[canonical] = hits[0];
    }
    if (mapping.company_name === undefined && mapping.website === undefined) fail('UNRECOGNIZED_HEADERS', 'Include a Company/Business/Name or Website/Domain column.');
    if (all.some(values => values.length !== headers.length)) fail('MALFORMED_CSV', 'Every record must have the same number of fields as the header.');
    return { headers, records: all, mapping, delimiter };
  }
  function exportCSV(headers, records) {
    const line = values => values.map(value => '"' + safeCell(value).replace(/"/g, '""') + '"').join(',');
    return '\ufeff' + [headers, ...records].map(line).join('\r\n') + '\r\n';
  }
  function auditCSV(input) {
    const parsed = parseCSV(input), { headers, records, mapping } = parsed;
    const seenWebsites = new Map(), seenNames = new Map(), cleanWebsites = new Set(), cleanNames = new Set();
    const rows = records.map((values, index) => {
      const number = index + 1, lead = {};
      for (const [key, position] of Object.entries(mapping)) lead[key] = values[position].trim();
      const issues = [];
      const issue = (code, field, reason, duplicate = null) => issues.push({ code, field, reason, duplicate_of_record: duplicate });
      let missing = false, invalid = false;
      for (const field of ['company_name', 'website', 'source_url']) {
        if (field === 'source_url' && mapping.source_url === undefined) continue;
        const value = lead[field] || '';
        if (!value) { missing = true; issue('MISSING_' + field.toUpperCase(), field, field.replace(/_/g, ' ') + ' is missing.'); }
        else if (field !== 'company_name' && !websiteKey(value)) {
          invalid = true; issue('INVALID_' + field.toUpperCase(), field, field.replace(/_/g, ' ') + ' must be an absolute HTTP(S) URL with a valid host, no credentials or spaces.');
        }
      }
      const host = websiteKey(lead.website || ''), name = companyKey(lead.company_name || '');
      if (host) {
        if (seenWebsites.has(host)) issue('DUPLICATE_WEBSITE', 'website', 'Normalized website matches record ' + seenWebsites.get(host) + '.', seenWebsites.get(host));
        else seenWebsites.set(host, number);
      }
      if (name) {
        if (seenNames.has(name)) issue('DUPLICATE_COMPANY', 'company_name', 'Normalized company name matches record ' + seenNames.get(name) + '.', seenNames.get(name));
        else seenNames.set(name, number);
      }
      const formula = values.some(formulaRisk);
      if (formula) issue('FORMULA_RISK', 'csv_cells', 'Formula-like content found. Exports add a protective apostrophe.');
      if (missing) issue('INCOMPLETE_RECORD', 'record', 'Required information is missing. Keep this record for review.');
      const included = !missing && !invalid && !formula && !cleanWebsites.has(host) && !cleanNames.has(name);
      if (included) { cleanWebsites.add(host); cleanNames.add(name); }
      return { record_number: number, original: Object.fromEntries(headers.map((h, i) => [h, values[i]])), values: values.slice(),
        company_name: lead.company_name || '', website: lead.website || '', normalized_website: host, normalized_company: name,
        issues, included_in_cleaned: included, verification_status: issues.length ? 'REVIEW_REQUIRED' : 'FORMAT_CHECKS_PASSED_UNVERIFIED' };
    });
    const count = code => rows.filter(row => row.issues.some(issue => issue.code === code)).length;
    const metrics = {
      total_records: rows.length, records_with_issues: rows.filter(row => row.issues.length).length,
      cleaned_records: rows.filter(row => row.included_in_cleaned).length,
      duplicate_records: rows.filter(row => row.issues.some(issue => issue.code.startsWith('DUPLICATE_'))).length,
      duplicate_website_records: count('DUPLICATE_WEBSITE'), duplicate_company_records: count('DUPLICATE_COMPANY'),
      missing_names: count('MISSING_COMPANY_NAME'), invalid_url_records: rows.filter(row => row.issues.some(issue => issue.code.startsWith('INVALID_'))).length,
      incomplete_records: count('INCOMPLETE_RECORD'), formula_risk_records: count('FORMULA_RISK')
    };
    const used = new Set(headers.map(companyKey));
    const extra = ['audit_record_number', 'audit_issues', 'audit_reasons', 'audit_included_in_cleaned', 'audit_verification_status'].map(name => {
      while (used.has(companyKey(name))) name = 'leadops_' + name;
      used.add(companyKey(name)); return name;
    });
    return { headers, rows, metrics, delimiter: parsed.delimiter,
      audited_csv: exportCSV([...headers, ...extra], rows.map(row => [...row.values, String(row.record_number), row.issues.map(issue => issue.code).join(' | '),
        row.issues.map(issue => issue.reason).join(' | '), String(row.included_in_cleaned), row.verification_status])),
      cleaned_csv: exportCSV(headers, rows.filter(row => row.included_in_cleaned).map(row => row.values)),
      warnings: headers.some(formulaRisk) ? ['Formula-like column headings are escaped in exports.'] : [] };
  }
  function selectRows(rows, query = '', issuesOnly = false, page = 1, pageSize = 25) {
    const term = String(query).toLowerCase();
    const selected = rows.filter(row => (!issuesOnly || row.issues.length > 0) &&
      (JSON.stringify(row.original) + ' ' + row.issues.map(issue => issue.code + ' ' + issue.reason).join(' ')).toLowerCase().includes(term));
    const pages = Math.max(1, Math.ceil(selected.length / pageSize));
    const current = Math.min(pages, Math.max(1, Math.trunc(page) || 1));
    return { rows: selected.slice((current - 1) * pageSize, current * pageSize), total: selected.length, page: current, pages };
  }
  function linkedinURL(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value.trim());
      if (url.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(url.hostname) || url.username || url.password || url.port ||
          url.search || url.hash || !/^\/in\/[a-zA-Z0-9_%~-]+\/?$/.test(url.pathname)) return null;
      return url.href;
    } catch (_) { return null; }
  }
  root.LeadAudit = Object.freeze({ LIMITS, AuditError, companyKey, formulaRisk, safeCell, websiteKey, parseCSV, exportCSV, auditCSV, selectRows, linkedinURL });
})(typeof globalThis !== 'undefined' ? globalThis : window);
