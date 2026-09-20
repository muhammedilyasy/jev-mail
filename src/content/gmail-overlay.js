// Renders Jev's verdict inline on Gmail's own thread list.
//
// Gmail's class names are obfuscated and Google changes them, so every selector
// here is best-effort: if a hook disappears this script quietly does nothing
// rather than breaking the inbox. It also never removes or reorders anything
// Gmail rendered — it only appends one <span> per row.

(() => {
  'use strict';

  const SEL = {
    row: 'tr.zA',
    sender: 'span[email]',
    subject: 'span.bog',
    snippet: 'span.y2',
    // Badges are pinned to the right edge of the subject cell rather than
    // dropped into the subject's text flow, where a long subject would push
    // them out of the clipped cell.
    host: 'td.a4W'
  };

  const MAX_BATCH = 40;

  const state = {
    enabled: false,
    autoClassify: false,
    cache: new Map(), // matchKey -> summary | null (null = asked, nothing stored)
    inFlight: new Set(),
    scanning: false
  };

  const matchKey = (email, subject) =>
    `${String(email || '').trim().toLowerCase()}|${String(subject || '').replace(/\s+/g, ' ').trim().toLowerCase()}`;

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (reply) => {
          // Reading lastError suppresses the "unchecked runtime.lastError" noise
          // when the worker is asleep or the extension was just reloaded.
          void chrome.runtime.lastError;
          resolve(reply || {});
        });
      } catch {
        resolve({});
      }
    });

  /* ------------------------------------------------------------- extraction */

  const TABS = { personal: 'Primary', updates: 'Updates', promotions: 'Promotions', social: 'Social', forums: 'Forums' };

  // Which list is on screen, from Gmail's URL: #spam, #category/promotions, ...
  // Only claims what the URL actually says; anything else stays unknown.
  function currentView() {
    const hash = decodeURIComponent(location.hash || '').toLowerCase();
    const tab = hash.match(/^#category\/(\w+)/)?.[1];
    return {
      gmailSpam: hash.startsWith('#spam') || /\bin:spam\b/.test(hash),
      gmailCategory: (tab && TABS[tab]) || null
    };
  }

  function readRow(row) {
    const senderEl = row.querySelector(SEL.sender);
    const subjectEl = row.querySelector(SEL.subject);
    if (!senderEl || !subjectEl) return null;

    const fromEmail = senderEl.getAttribute('email') || '';
    const subject = (subjectEl.textContent || '').trim();
    if (!fromEmail || !subject) return null;

    const snippetEl = row.querySelector(SEL.snippet);
    const snippet = (snippetEl?.textContent || '').replace(/^[\s ]*[-–—][\s ]*/, '').trim();

    return {
      ...currentView(),
      matchKey: matchKey(fromEmail, subject),
      fromEmail,
      fromName: senderEl.getAttribute('name') || (senderEl.textContent || '').trim() || fromEmail,
      subject,
      snippet,
      threadId: row.getAttribute('data-legacy-thread-id') || null,
      date: row.querySelector('span[title]')?.getAttribute('title') || ''
    };
  }

  /* ---------------------------------------------------------------- badges */

  function badgeHost(row) {
    const cell = row.querySelector(SEL.host) || row.querySelector(SEL.subject)?.closest('td');
    if (cell) cell.classList.add('jev-host');
    return cell;
  }

  function chip(className, text, title) {
    const el = document.createElement('span');
    el.className = className;
    el.textContent = text;
    if (title) el.title = title;
    return el;
  }

  function metric(label, value) {
    const pct = Math.round(value * 100);
    const cls = value >= 0.5 ? 'jev-m jev-hot' : value >= 0.3 ? 'jev-m jev-mid' : 'jev-m';
    return chip(cls, `${label} ${pct}%`, label === 'S' ? `Spam ${pct}%` : `Needs a reply: ${pct}%`);
  }

  function decorate(row, key, summary) {
    const host = badgeHost(row);
    if (!host) return;

    let group = host.querySelector(':scope > .jev-badges');
    if (!group) {
      group = document.createElement('span');
      group.className = 'jev-badges';
      host.appendChild(group);
    }
    if (group.dataset.key === key && group.dataset.stateTag === (summary ? 'done' : 'pending')) return;

    group.dataset.key = key;
    group.dataset.stateTag = summary ? 'done' : 'pending';
    group.replaceChildren();

    if (!summary) {
      group.appendChild(chip('jev-pending', '•', 'Classifying…'));
      return;
    }

    group.append(
      chip('jev-cat', summary.category, summary.confidence != null ? `confidence ${Math.round(summary.confidence * 100)}%` : ''),
      chip(`jev-pri jev-${summary.priority}`, summary.priority, 'Priority'),
      withTitle(metric('S', summary.spam ?? 0), summary.why),
      metric('R', summary.reply ?? 0)
    );
  }

  function withTitle(el, extra) {
    if (extra) el.title = `${el.title}\n${extra}`;
    return el;
  }

  function clearBadges() {
    for (const el of document.querySelectorAll('.jev-badges')) el.remove();
  }

  /* ------------------------------------------------------------------ scan */

  async function scan() {
    if (!state.enabled || state.scanning) return;
    state.scanning = true;

    try {
      const rows = document.querySelectorAll(SEL.row);
      if (!rows.length) return;

      const seen = [];
      const unknownKeys = [];

      for (const row of rows) {
        const data = readRow(row);
        if (!data) continue;
        seen.push({ row, data });

        if (state.cache.has(data.matchKey)) {
          decorate(row, data.matchKey, state.cache.get(data.matchKey));
        } else if (!unknownKeys.includes(data.matchKey)) {
          unknownKeys.push(data.matchKey);
        }
      }

      if (!unknownKeys.length) return;

      const { results = {} } = await send({ type: 'overlay:lookup', keys: unknownKeys });
      for (const key of unknownKeys) state.cache.set(key, results[key] || null);

      const toClassify = [];
      for (const { row, data } of seen) {
        const hit = state.cache.get(data.matchKey);
        if (hit) {
          decorate(row, data.matchKey, hit);
        } else if (state.autoClassify && !state.inFlight.has(data.matchKey)) {
          if (toClassify.length < MAX_BATCH && !toClassify.some((i) => i.matchKey === data.matchKey)) {
            toClassify.push(data);
            state.inFlight.add(data.matchKey);
            decorate(row, data.matchKey, null);
          }
        }
      }

      if (!toClassify.length) return;

      const reply = await send({ type: 'overlay:classify', items: toClassify });
      for (const item of toClassify) {
        state.inFlight.delete(item.matchKey);
        const summary = reply.results?.[item.matchKey] || null;
        if (summary) state.cache.set(item.matchKey, summary);
        else state.cache.delete(item.matchKey); // let a later scan retry
      }

      // Re-walk: Gmail may have re-rendered rows while we waited.
      for (const row of document.querySelectorAll(SEL.row)) {
        const data = readRow(row);
        if (!data) continue;
        const summary = state.cache.get(data.matchKey);
        if (summary) decorate(row, data.matchKey, summary);
        else if (!state.inFlight.has(data.matchKey)) {
          row.querySelector('.jev-badges[data-state-tag="pending"]')?.remove();
        }
      }
    } catch (err) {
      console.warn('[jev-mail] overlay scan failed', err);
    } finally {
      state.scanning = false;
    }
  }

  /* ------------------------------------------------------------------ theme */

  function syncTheme() {
    const probe = document.querySelector(SEL.row) || document.body;
    const bg = getComputedStyle(probe).backgroundColor;
    const nums = bg.match(/\d+(\.\d+)?/g);
    if (!nums || nums.length < 3) return;
    const [r, g, b] = nums.map(Number);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    document.documentElement.classList.toggle('jev-dark', luminance < 0.5);
  }

  /* ------------------------------------------------------------------- boot */

  let timer = null;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      syncTheme();
      scan();
    }, 400);
  };

  async function refreshConfig() {
    const config = await send({ type: 'overlay:config' });
    state.enabled = Boolean(config.enabled);
    state.autoClassify = Boolean(config.autoClassify);
    if (!state.enabled) clearBadges();
    else schedule();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      state.cache.clear();
      clearBadges();
      refreshConfig();
    }
  });

  // Gmail rewrites the list constantly — on navigation, on new mail, on every
  // read/star. One debounced observer covers all of it.
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });

  refreshConfig();
})();
