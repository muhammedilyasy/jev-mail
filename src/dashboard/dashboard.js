import { loadSettings, saveSettings, DEFAULT_CATEGORIES, DEFAULTS } from '../common/settings.js';
import { getToken, signOut, invalidateToken, redirectUrl } from '../common/auth.js';
import { getAllEmails, clearEmails } from '../common/db.js';
import { listModels } from '../common/jev.js';
import { syncInbox, classifyAll } from '../common/pipeline.js';

const $ = (id) => document.getElementById(id);

// A 20k-message inbox is ~120k DOM nodes if rendered whole, so the table draws
// a page at a time.
const PAGE_SIZE = 400;

const state = {
  settings: null,
  emails: new Map(),
  ownerEmail: '',
  connected: false,
  running: false,
  controller: null,
  sort: { key: 'date', dir: 'desc' },
  renderLimit: PAGE_SIZE,
  issues: []
};

const trIndex = new Map();

/* ------------------------------------------------------------------ boot */

init();

async function init() {
  state.settings = await loadSettings();
  for (const row of await getAllEmails()) state.emails.set(row.id, row);

  buildCategoryFilter();
  wireEvents();
  render();

  state.connected = await probeConnection();
  updateOnboarding();
  setStatus(state.emails.size ? 'Ready.' : 'Ready. Hit Start to pull your inbox and classify it.');
}

async function probeConnection() {
  try {
    await getToken({ interactive: false });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ events */

function wireEvents() {
  $('btn-start').addEventListener('click', onStartStop);
  $('btn-sync').addEventListener('click', () => runGuarded(() => doSync()));
  $('btn-export').addEventListener('click', exportCsv);
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-log').addEventListener('click', () => {
    $('logbody').textContent = state.issues.join('\n') || 'Nothing to report.';
    $('logdialog').showModal();
  });
  $('log-close').addEventListener('click', () => $('logdialog').close());

  $('search').addEventListener('input', debounce(resetAndRender, 120));
  $('filter-category').addEventListener('change', resetAndRender);
  $('filter-priority').addEventListener('change', resetAndRender);

  for (const th of document.querySelectorAll('th.sortable')) {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === 'desc' ? 'asc' : 'desc';
      } else {
        state.sort = { key, dir: key === 'sender' || key === 'category' ? 'asc' : 'desc' };
      }
      resetAndRender();
    });
  }

  $('s-cancel').addEventListener('click', () => $('settings').close());
  $('s-save').addEventListener('click', saveSettingsFromForm);
  $('s-test').addEventListener('click', testJevKey);
  $('s-signout').addEventListener('click', async () => {
    await signOut();
    state.connected = false;
    updateOnboarding();
    setStatus('Signed out of Gmail.');
  });
  $('s-reset').addEventListener('click', async () => {
    if (!confirm('Delete every fetched message and classification from this extension? Your Gmail is untouched.')) return;
    await clearEmails();
    state.emails.clear();
    trIndex.clear();
    render();
    setStatus('Local data cleared.');
  });
}

/* ------------------------------------------------------------------ run */

async function onStartStop() {
  if (state.running) {
    state.controller?.abort();
    setStatus('Stopping…');
    return;
  }
  await runGuarded(async () => {
    if (!state.settings.jevApiKey.trim()) {
      openSettings();
      throw new Error('Add your Jev API key first.');
    }
    if (!state.emails.size) await doSync();
    await doClassify();
  });
}

async function runGuarded(task) {
  if (state.running) return;
  state.running = true;
  state.controller = new AbortController();
  state.issues = [];
  $('btn-log').hidden = true;
  setRunning(true);

  try {
    await ensureConnected();
    // Start the clock after authorization, so time spent in Google's consent
    // popup doesn't count toward the run.
    state.startedAt = performance.now();
    await task();
  } catch (err) {
    if (err.name === 'AbortError') {
      setStatus('Stopped.');
    } else {
      setStatus(err.message);
      pushIssue(err.message);
    }
  } finally {
    state.running = false;
    setRunning(false);
    setProgress(0);
    render();
  }
}

async function ensureConnected() {
  if (state.connected) return;
  setStatus('Waiting for Gmail authorization…');
  await getToken({ interactive: true });
  state.connected = true;
  updateOnboarding();
}

async function doSync() {
  await syncInbox(state.settings, { onEvent: handleEvent, signal: state.controller.signal });
}

async function doClassify() {
  const stats = await classifyAll(state.settings, {
    rows: [...state.emails.values()],
    ownerEmail: state.ownerEmail,
    onEvent: handleEvent,
    signal: state.controller.signal
  });
  if (stats.done) {
    const elapsed = formatDuration(performance.now() - state.startedAt);
    setStatus(
      `Classified ${stats.done.toLocaleString()} emails in ${elapsed} · ${formatCost(stats.inputTokens)}` +
        (stats.failed ? ` · ${stats.failed} failed` : '')
    );
  }
}

function handleEvent(evt) {
  switch (evt.type) {
    case 'profile':
      state.ownerEmail = evt.email;
      $('account').textContent = evt.email;
      break;
    case 'stage':
      setStatus(evt.text);
      break;
    case 'rows':
      for (const row of evt.rows) state.emails.set(row.id, row);
      scheduleRender();
      break;
    case 'row':
      state.emails.set(evt.row.id, evt.row);
      patchRow(evt.row);
      scheduleStats();
      break;
    case 'progress':
      setProgress(evt.total ? evt.done / evt.total : 0);
      setStatus(
        evt.phase === 'fetch'
          ? `Fetching messages… ${evt.done} / ${evt.total}`
          : `Classifying… ${evt.done} / ${evt.total}${evt.inputTokens ? ` · ${formatCost(evt.inputTokens)}` : ''}`
      );
      break;
    case 'warn':
      pushIssue(evt.text);
      break;
  }
}

function pushIssue(text) {
  state.issues.push(text);
  $('btn-log').hidden = false;
  $('btn-log').textContent = `${state.issues.length} issue${state.issues.length === 1 ? '' : 's'}`;
}

function formatDuration(ms) {
  const total = Math.max(1, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

// Jev bills $42 per billion input tokens; output tokens are free.
function formatCost(tokens) {
  const usd = (tokens / 1e9) * 42;
  if (usd < 0.01) return `${tokens.toLocaleString()} tok · <$0.01`;
  return `${tokens.toLocaleString()} tok · $${usd.toFixed(2)}`;
}

/* ------------------------------------------------------------------ render */

let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  // Each render re-sorts the whole set, so back off once the inbox is large.
  const delay = state.emails.size > 2000 ? 700 : 200;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    render();
  }, delay);
}

let statsTimer = null;
function scheduleStats() {
  if (statsTimer) return;
  statsTimer = setTimeout(() => {
    statsTimer = null;
    renderStats();
  }, 250);
}

function visibleRows() {
  const q = $('search').value.trim().toLowerCase();
  const cat = $('filter-category').value;
  const prio = $('filter-priority').value;

  let rows = [...state.emails.values()];
  if (q) {
    rows = rows.filter(
      (r) =>
        r.fromName.toLowerCase().includes(q) ||
        r.fromEmail.toLowerCase().includes(q) ||
        r.subject.toLowerCase().includes(q)
    );
  }
  if (cat) rows = rows.filter((r) => r.result?.category === cat);
  if (prio) rows = rows.filter((r) => r.result?.priority === prio);

  const rank = { High: 3, Normal: 2, Low: 1 };
  const key = state.sort.key;
  const dir = state.sort.dir === 'asc' ? 1 : -1;
  const value = (r) => {
    switch (key) {
      case 'sender': return r.fromName.toLowerCase();
      case 'category': return (r.result?.category || '~').toLowerCase();
      case 'priority': return rank[r.result?.priority] || 0;
      case 'spam': return r.result?.spam ?? -1;
      case 'reply': return r.result?.reply ?? -1;
      default: return r.internalDate || 0;
    }
  };
  rows.sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va < vb) return -dir;
    if (va > vb) return dir;
    return (b.internalDate || 0) - (a.internalDate || 0);
  });
  return rows;
}

function resetAndRender() {
  state.renderLimit = PAGE_SIZE;
  render();
}

function render() {
  const rows = visibleRows();
  const shown = rows.slice(0, state.renderLimit);
  const tbody = $('rows');
  const frag = document.createDocumentFragment();
  trIndex.clear();

  for (const row of shown) {
    const tr = buildRow(row);
    trIndex.set(row.id, tr);
    frag.appendChild(tr);
  }

  if (rows.length > shown.length) frag.appendChild(moreRow(shown.length, rows.length));

  tbody.replaceChildren(frag);
  $('empty').hidden = rows.length > 0;
  $('empty').textContent = state.emails.size
    ? 'Nothing matches those filters.'
    : 'No messages yet. Hit Start to pull your inbox and classify it.';

  for (const th of document.querySelectorAll('th.sortable')) {
    if (th.dataset.sort === state.sort.key) th.dataset.dir = state.sort.dir;
    else delete th.dataset.dir;
  }

  renderStats();
}

function moreRow(shownCount, totalCount) {
  const tr = document.createElement('tr');
  tr.className = 'more-row';
  const cell = document.createElement('td');
  cell.colSpan = 6;

  const label = document.createElement('span');
  label.textContent = `Showing ${shownCount.toLocaleString()} of ${totalCount.toLocaleString()}`;

  const button = document.createElement('button');
  button.className = 'ghost';
  button.textContent = `Show ${Math.min(PAGE_SIZE, totalCount - shownCount).toLocaleString()} more`;
  button.addEventListener('click', () => {
    state.renderLimit += PAGE_SIZE;
    render();
  });

  const all = document.createElement('button');
  all.className = 'linkish';
  all.textContent = 'Show all';
  all.addEventListener('click', () => {
    state.renderLimit = Infinity;
    render();
  });

  cell.append(label, button, all);
  tr.appendChild(cell);
  return tr;
}

function buildRow(row) {
  const tr = document.createElement('tr');
  tr.dataset.id = row.id;
  if (row.labelIds?.includes('UNREAD')) tr.classList.add('unread');

  const sender = td('sender');
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = dotColor(row.fromEmail);
  sender.append(dot, document.createTextNode(row.fromName));
  sender.title = `${row.fromName} <${row.fromEmail}>`;

  const subject = td('subject', row.subject);
  subject.title = row.snippet ? `${row.subject}\n\n${row.snippet}` : row.subject;

  tr.append(sender, subject, td('category'), td('priority'), td('col-num'), td('col-num'));
  fillResult(tr, row);
  return tr;
}

function td(cls, text) {
  const cell = document.createElement('td');
  cell.className = cls;
  if (text !== undefined) cell.textContent = text;
  return cell;
}

function fillResult(tr, row) {
  const [, , cat, prio, spam, reply] = tr.children;

  if (row.status === 'error') {
    cat.className = 'failed';
    cat.textContent = 'Failed';
    cat.title = row.error || '';
    prio.replaceChildren();
    spam.replaceChildren();
    reply.replaceChildren();
    return;
  }

  if (!row.result) {
    cat.className = 'category waiting';
    cat.replaceChildren(skeleton());
    prio.className = 'priority waiting';
    prio.replaceChildren(skeleton());
    spam.className = 'col-num waiting';
    spam.replaceChildren(skeleton());
    reply.className = 'col-num waiting';
    reply.replaceChildren(skeleton());
    return;
  }

  cat.className = 'category';
  cat.textContent = row.result.category;
  cat.title = row.result.categoryConfidence != null
    ? `confidence ${(row.result.categoryConfidence * 100).toFixed(0)}%`
    : '';

  prio.className = 'priority';
  prio.replaceChildren(pill(row.result.priority, row.result.priorityConfidence));

  spam.className = 'col-num';
  spam.replaceChildren(metric(row.result.spam));

  reply.className = 'col-num';
  reply.replaceChildren(metric(row.result.reply));
}

function patchRow(row) {
  const tr = trIndex.get(row.id);
  // Not on the rendered page: nothing to repaint. The run's final render picks
  // it up, so don't rebuild the whole table for every off-screen result.
  if (tr) fillResult(tr, row);
}

function skeleton() {
  const s = document.createElement('span');
  s.className = 'sk';
  return s;
}

function pill(level, confidence) {
  const el = document.createElement('span');
  el.className = `pill ${level}`;
  el.textContent = level;
  if (confidence != null) el.title = `confidence ${(confidence * 100).toFixed(0)}%`;
  return el;
}

function metric(value) {
  const el = document.createElement('span');
  el.className = 'metric';
  if (value == null) {
    el.textContent = '—';
    return el;
  }
  if (value >= 0.5) el.classList.add('hot');
  else if (value >= 0.3) el.classList.add('mid');

  const rail = document.createElement('span');
  rail.className = 'rail';
  const fill = document.createElement('i');
  fill.style.height = `${Math.max(8, Math.round(value * 100))}%`;
  rail.appendChild(fill);

  el.append(rail, document.createTextNode(`${Math.round(value * 100)}%`));
  return el;
}

function renderStats() {
  const all = [...state.emails.values()];
  const done = all.filter((r) => r.result);
  const high = done.filter((r) => r.result.priority === 'High').length;
  const spam = done.filter((r) => (r.result.spam ?? 0) >= 0.5).length;
  const reply = done.filter((r) => (r.result.reply ?? 0) >= 0.5).length;

  const chips = [
    `<span class="chip"><b>${all.length}</b> emails</span>`,
    `<span class="chip"><b>${done.length}</b> classified</span>`
  ];
  if (high) chips.push(`<span class="chip hot"><b>${high}</b> high priority</span>`);
  if (reply) chips.push(`<span class="chip"><b>${reply}</b> need a reply</span>`);
  if (spam) chips.push(`<span class="chip"><b>${spam}</b> likely spam</span>`);

  $('stats').innerHTML = chips.join('');
}

function dotColor(email) {
  const seed = email || '?';
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360} 52% 58%)`;
}

function setStatus(text) {
  $('status').textContent = text;
}

function setProgress(fraction) {
  $('progress-bar').style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}

function setRunning(running) {
  const start = $('btn-start');
  start.textContent = running ? 'Stop' : 'Start';
  start.dataset.state = running ? 'running' : '';
  $('btn-sync').disabled = running;
  $('btn-settings').disabled = running;
}

/* ------------------------------------------------------------------ onboarding */

function updateOnboarding() {
  const panel = $('onboarding');
  const needsClientId = !state.settings.googleClientId.trim();
  const needsKey = !state.settings.jevApiKey.trim();

  if (!needsClientId && !needsKey && state.connected) {
    panel.hidden = true;
    return;
  }

  const steps = [];
  if (needsClientId) {
    steps.push(`In Google Cloud, <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noreferrer">enable the Gmail API</a> and set up the OAuth consent screen with your account as a test user.`);
    steps.push(`Under <b>Credentials → Create credentials → OAuth client ID</b>, choose <b>Web application</b> and add this to <b>Authorized redirect URIs</b>: <code>${redirectUrl()}</code>`);
    steps.push(`Paste the client ID into <b>Settings → Gmail</b>.`);
  }
  if (needsKey) {
    steps.push(`Add your Jev API key from <a href="https://console.typesafe.ai/" target="_blank" rel="noreferrer">console.typesafe.ai</a> in <b>Settings</b>.`);
  }
  if (!state.connected) {
    steps.push(`Hit <b>Start</b> and approve read-only access to Gmail.`);
  }

  panel.hidden = false;
  panel.innerHTML = `
    <h2>Finish setup</h2>
    <p>Jev Mail reads message metadata from Gmail and scores each one with TypeSafe's Jev model. Nothing leaves your browser except the sender, subject and preview line sent to api.typesafe.ai.</p>
    ${needsClientId ? `<p><b>You may not need any of this.</b> With just a Jev API key, the in-Gmail badges already work — open <a href="https://mail.google.com/" target="_blank" rel="noreferrer">Gmail</a> and rows get classified as you scroll. The steps below only unlock this dashboard, which reads your whole inbox at once through the Gmail API.</p>` : ''}
    <ol>${steps.map((s) => `<li>${s}</li>`).join('')}</ol>
    <div class="cta"><button type="button" class="primary" id="ob-settings">Open settings</button></div>
  `;
  $('ob-settings').addEventListener('click', openSettings);
}

/* ------------------------------------------------------------------ settings */

function openSettings() {
  const s = state.settings;
  $('s-key').value = s.jevApiKey;
  $('s-model').value = s.jevModel;
  $('s-concurrency').value = s.concurrency;
  $('s-query').value = s.gmailQuery;
  $('s-max').value = s.maxEmails;
  $('s-clientid').value = s.googleClientId;
  $('s-redirect').textContent = redirectUrl();
  $('s-overlay').checked = s.overlayEnabled;
  $('s-overlay-auto').checked = s.overlayAutoClassify;
  $('s-categories').value = s.categories.map((c) => `${c.name}: ${c.description || ''}`.trim()).join('\n');
  $('s-test-result').textContent = '';
  $('s-test-result').className = 'test-result';
  $('settings').showModal();
}

function parseCategories(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    const name = (idx === -1 ? trimmed : trimmed.slice(0, idx)).trim();
    const description = idx === -1 ? '' : trimmed.slice(idx + 1).trim();
    if (name) out.push({ name, description });
  }
  return out.length >= 2 ? out : DEFAULT_CATEGORIES;
}

async function saveSettingsFromForm() {
  const previousClientId = state.settings.googleClientId;
  state.settings = await saveSettings({
    googleClientId: $('s-clientid').value.trim(),
    jevApiKey: $('s-key').value.trim(),
    jevModel: $('s-model').value.trim() || DEFAULTS.jevModel,
    concurrency: clamp(Number($('s-concurrency').value) || DEFAULTS.concurrency, 1, 24),
    gmailQuery: $('s-query').value.trim(),
    maxEmails: parseMax($('s-max').value),
    overlayEnabled: $('s-overlay').checked,
    overlayAutoClassify: $('s-overlay-auto').checked,
    categories: parseCategories($('s-categories').value)
  });

  // A token minted for another client is useless to this one.
  if (state.settings.googleClientId !== previousClientId) await invalidateToken();

  buildCategoryFilter();
  $('settings').close();
  state.connected = await probeConnection();
  updateOnboarding();
  setStatus('Settings saved.');
}

async function testJevKey() {
  const out = $('s-test-result');
  out.className = 'test-result';
  out.textContent = 'Checking…';
  try {
    const models = await listModels({
      ...state.settings,
      jevApiKey: $('s-key').value.trim()
    });
    out.className = 'test-result ok';
    out.textContent = models.length
      ? `Key works. Available: ${models.map((m) => m.name).join(', ')}`
      : 'Key works.';
  } catch (err) {
    out.className = 'test-result bad';
    out.textContent = err.message;
  }
}

function buildCategoryFilter() {
  const select = $('filter-category');
  const current = select.value;
  select.replaceChildren(new Option('All categories', ''));
  for (const c of state.settings.categories) select.add(new Option(c.name, c.name));
  select.value = current;
}

/* ------------------------------------------------------------------ export */

function exportCsv() {
  const rows = visibleRows();
  if (!rows.length) return;

  const header = ['Date', 'From', 'Email', 'Subject', 'Category', 'Priority', 'Spam %', 'Reply %'];
  const lines = [header.join(',')];

  for (const r of rows) {
    lines.push(
      [
        r.internalDate ? new Date(r.internalDate).toISOString() : '',
        r.fromName,
        r.fromEmail,
        r.subject,
        r.result?.category ?? '',
        r.result?.priority ?? '',
        r.result?.spam != null ? Math.round(r.result.spam * 100) : '',
        r.result?.reply != null ? Math.round(r.result.reply * 100) : ''
      ]
        .map(csvCell)
        .join(',')
    );
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `jev-mail-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/* ------------------------------------------------------------------ utils */

// Blank restores the default; 0 means "every message the query matches".
function parseMax(raw) {
  const text = raw.trim();
  if (text === '') return DEFAULTS.maxEmails;
  const n = Math.floor(Number(text));
  return Number.isFinite(n) ? clamp(n, 0, 200000) : DEFAULTS.maxEmails;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
