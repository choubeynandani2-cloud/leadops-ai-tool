/* UI only. Files and results stay in memory; no fetch, analytics or storage. */
(function () {
  'use strict';
  const audit = globalThis.LeadAudit;
  const byId = id => document.getElementById(id);
  const fileInput = byId('csv-file'), sampleButton = byId('sample-button');
  const resultPanel = byId('audit-results'), status = byId('audit-status');
  const search = byId('issue-search'), issuesOnly = byId('issues-only');
  let result = null, downloads = [], page = 1, generation = 0;
  function message(value, error = false) { status.textContent = value; status.classList.toggle('error', error); }
  function element(tag, value, className) {
    const node = document.createElement(tag);
    if (value !== undefined) node.textContent = String(value);
    if (className) node.className = className;
    return node;
  }
  function clearResults() {
    downloads.forEach(url => URL.revokeObjectURL(url)); downloads = [];
    result = null; page = 1; resultPanel.hidden = true;
    byId('result-rows').replaceChildren(); byId('metrics').replaceChildren();
    byId('audited-download').removeAttribute('href'); byId('cleaned-download').removeAttribute('href');
    search.value = ''; issuesOnly.checked = false;
  }
  function busy(value) { fileInput.disabled = value; sampleButton.disabled = value; }
  function renderRows() {
    if (!result) return;
    const selection = audit.selectRows(result.rows, search.value, issuesOnly.checked, page);
    page = selection.page;
    const fragment = document.createDocumentFragment();
    for (const row of selection.rows) {
      const tr = element('tr');
      tr.append(element('td', row.record_number));
      const company = element('td');
      company.append(element('b', row.company_name || 'Missing company name'), element('p', row.website || 'Missing website'));
      const original = element('details'); original.append(element('summary', 'Original record'));
      const list = element('dl');
      result.headers.forEach((header, index) => list.append(element('dt', header), element('dd', row.values[index] || '(empty)')));
      original.append(list); company.append(original); tr.append(company);
      const issues = element('td');
      if (!row.issues.length) issues.append(element('span', 'Passes format checks', 'tag mint'), element('p', 'Business information remains unverified.'));
      for (const issue of row.issues) issues.append(element('span', issue.code.replace(/_/g, ' '), 'issue-code'), element('p', issue.reason));
      tr.append(issues);
      const cleaned = element('td');
      cleaned.append(element('span', row.included_in_cleaned ? 'Included' : 'Excluded', 'tag ' + (row.included_in_cleaned ? 'mint' : 'amber')),
        element('p', row.included_in_cleaned ? 'First complete representative.' : 'Original preserved in audited CSV.'));
      tr.append(cleaned); fragment.append(tr);
    }
    if (!selection.rows.length) {
      const tr = element('tr'), cell = element('td', 'No matching records. Try another search or turn off “Issues only”.');
      cell.colSpan = 4; tr.append(cell); fragment.append(tr);
    }
    byId('result-rows').replaceChildren(fragment);
    byId('result-count').textContent = selection.total ? 'Page ' + page + ' of ' + selection.pages + ' · ' + selection.total + ' matching records' : '0 matching records';
    byId('previous-page').disabled = page <= 1; byId('next-page').disabled = page >= selection.pages;
  }
  function show(input, synthetic) {
    const current = audit.auditCSV(input);
    clearResults(); result = current;
    const cards = [
      ['Total records', current.metrics.total_records], ['Duplicate records', current.metrics.duplicate_records],
      ['Missing names', current.metrics.missing_names], ['Invalid URLs', current.metrics.invalid_url_records],
      ['Incomplete records', current.metrics.incomplete_records], ['Cleaned records', current.metrics.cleaned_records]
    ];
    cards.forEach(([label, value]) => {
      const card = element('div', undefined, 'metric'); card.append(element('b', value), element('span', label)); byId('metrics').append(card);
    });
    [['audited-download', current.audited_csv], ['cleaned-download', current.cleaned_csv]].forEach(([id, content]) => {
      const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
      downloads.push(url); byId(id).href = url;
    });
    byId('data-badge').textContent = synthetic ? 'SYNTHETIC SAMPLE · NOT REAL BUSINESSES' : 'YOUR CSV · PROCESSED LOCALLY';
    byId('quality-summary').textContent = current.metrics.records_with_issues + ' of ' + current.metrics.total_records + ' records flagged · ' +
      current.metrics.duplicate_website_records + ' website duplicates · ' + current.metrics.duplicate_company_records + ' company-name duplicates · ' + current.metrics.formula_risk_records + ' formula-risk records.';
    byId('export-warning').textContent = 'All originals are preserved in the audited export. Formula-like cells are escaped; those records are excluded from the cleaned export. ' + current.warnings.join(' ');
    resultPanel.hidden = false; renderRows();
    message((synthetic ? 'Synthetic sample complete. ' : 'Audit complete. ') + 'Your data was processed entirely in this browser.');
  }
  function errorMessage(error) {
    message(error instanceof audit.AuditError ? error.message : 'This file could not be audited. Check its encoding and CSV structure, then try again.', true);
  }
  async function readFile(file) {
    const ticket = ++generation;
    clearResults();
    if (!file) return;
    if (file.size > audit.LIMITS.bytes) { message('Your CSV exceeds 2 MB (2,097,152 bytes).', true); fileInput.value = ''; return; }
    busy(true); message('Reading your CSV locally…');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (ticket === generation) show(bytes, false);
    } catch (error) { if (ticket === generation) errorMessage(error); }
    finally { if (ticket === generation) { busy(false); fileInput.value = ''; } }
  }
  fileInput.addEventListener('change', () => readFile(fileInput.files[0]));
  sampleButton.addEventListener('click', () => {
    generation++; clearResults(); busy(false);
    try { show(globalThis.LEADOPS_SAMPLE, true); } catch (error) { errorMessage(error); }
  });
  byId('clear-button').addEventListener('click', () => {
    generation++; clearResults(); busy(false); fileInput.value = '';
    message('Audit cleared. No file or result was uploaded or saved by this tool.');
  });
  search.addEventListener('input', () => { page = 1; renderRows(); });
  issuesOnly.addEventListener('change', () => { page = 1; renderRows(); });
  byId('previous-page').addEventListener('click', () => { page--; renderRows(); });
  byId('next-page').addEventListener('click', () => { page++; renderRows(); });
  const dropzone = byId('dropzone');
  ['dragenter', 'dragover'].forEach(name => dropzone.addEventListener(name, event => { event.preventDefault(); dropzone.classList.add('drag-active'); }));
  ['dragleave', 'drop'].forEach(name => dropzone.addEventListener(name, event => { event.preventDefault(); dropzone.classList.remove('drag-active'); }));
  dropzone.addEventListener('drop', event => {
    const files = event.dataTransfer.files;
    if (files.length !== 1) { message('Choose one CSV at a time.', true); return; }
    readFile(files[0]);
  });
  const contact = audit.linkedinURL(globalThis.LEADOPS_CONFIG && globalThis.LEADOPS_CONFIG.linkedinUrl);
  if (contact) { byId('contact-link').href = contact; byId('contact-link').hidden = false; byId('contact-unconfigured').hidden = true; }
  globalThis.addEventListener('pagehide', () => { generation++; clearResults(); });
})();
