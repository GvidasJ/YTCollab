/*
 * Popup. Shows what fits the current tab: invite panel on a video's Details
 * page / upload dialog, accept panel for the signed-in channel's pending
 * invites, live progress, hand-off codes, channels, recorder and history.
 *
 * All work runs in the service worker + content scripts, so closing the
 * popup never stops a run; reopening shows the current state.
 */
(function () {
  const YTC = globalThis.YTC;
  const U = YTC.util;
  const S = YTC.store;
  const UI = YTC.ui;
  const { $, esc } = UI;

  const st = {
    tabId: null,
    ctx: null,
    active: null,
    activeState: 'idle', // idle | detecting | ok | error
    activeError: '',
    data: null,
    selected: new Set(),
  };

  const noticeEl = $('#notice');
  const say = (text, kind = 'info', opts) => UI.notice(noticeEl, text, kind, opts);
  const fail = (e) => say(e.message || String(e), 'bad');

  // ------------------------------------------------------------------
  // Data
  // ------------------------------------------------------------------

  const invitesList = () => Object.values(st.data.invites);
  const isVideoPage = () => st.ctx && (st.ctx.kind === 'studio-video' || st.ctx.kind === 'studio-upload');
  const latest = (list) => list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;

  function inviteFor(videoId, channelId) {
    return latest(invitesList().filter((i) => i.videoId === videoId && i.to.id === channelId));
  }

  function jobFor(pred) {
    return latest(
      Object.values(st.data.jobs).filter(
        (j) => pred(j) && (!['done', 'error', 'cancelled'].includes(j.state) || Date.now() - j.updatedAt < 30 * 60000),
      ),
    );
  }

  const isLive = (j) => j && (j.state === 'queued' || j.state === 'running');

  async function loadData() {
    st.data = await S.getAll();
    const { active } = await chrome.storage.session.get('active');
    if (active && st.activeState !== 'detecting' && (!st.active || active.at > st.active.at)) {
      st.active = active;
      st.activeState = 'ok';
    }
  }

  async function detectActive(maxAgeMs = 120000) {
    st.activeState = 'detecting';
    renderAll();
    try {
      const r = await UI.send('activeChannel', { tabId: st.tabId, maxAgeMs });
      st.active = r.active;
      st.activeState = 'ok';
    } catch (e) {
      st.activeState = 'error';
      st.activeError = e.message;
    }
    renderAll();
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  function renderHeader() {
    $('#dry').classList.toggle('hidden', !st.data.settings.dryRun);
    const el = $('#active');
    if (st.activeState === 'detecting') el.innerHTML = '<span class="spinner"></span> Checking which channel is signed in…';
    else if (st.activeState === 'error') {
      el.innerHTML = `<span class="err">${esc(st.activeError)}</span> <button class="link" data-act="detect">Try again</button>`;
    } else if (st.active) {
      el.innerHTML = `Signed in as <b>${esc(UI.activeText(st.active, st.data.channels))}</b> <button class="link small" data-act="detect" title="Check again (opens Studio briefly in a background tab)">re-check</button>`;
    } else {
      el.innerHTML = `<button class="link" data-act="detect">Check which channel is signed in</button>`;
    }
  }

  function channelRow(ch, videoId) {
    const inv = inviteFor(videoId, ch.id);
    const job = jobFor((j) => j.type === 'invite' && j.video.id === videoId && j.target.id === ch.id);
    const live = isLive(job);
    const hasInvite = inv && (inv.status === 'pending' || inv.status === 'accepted');
    const eligible = !live && !hasInvite && !!ch.handle && st.activeState === 'ok';
    if (!eligible) st.selected.delete(ch.id);

    let status = '';
    let actions = '';
    if (live) {
      status = `<div class="step">${UI.jobIcon(job)} ${esc(job.step)}</div>`;
      actions = `<button class="tiny" data-act="job-cancel" data-job="${esc(job.id)}">Stop</button>`;
    } else if (hasInvite) {
      status = inv.note ? `<div class="note">${esc(inv.note)}</div>` : '';
      actions = `${UI.chip(inv.status)}${inv.link ? ` <button class="tiny" data-act="copy-link" data-inv="${esc(inv.id)}">Copy link</button>` : ''}`;
    } else {
      const lastErr = job && job.state === 'error' ? job.step : inv && inv.status === 'failed' ? inv.error : '';
      const dry = job && job.state === 'done' && job.dryRun ? job.step : '';
      if (lastErr) status = `<div class="err">❌ ${esc(lastErr)}</div>`;
      else if (dry) status = `<div class="step">👁 ${esc(dry)}</div>`;
      if (!ch.handle) status += '<div class="err">No handle saved. Add it in Options.</div>';
      actions = `<button class="tiny${lastErr ? '' : ' primary'}" data-act="invite-one" data-ch="${esc(ch.id)}" ${eligible ? '' : 'disabled'}>${lastErr ? 'Retry' : 'Invite'}</button>`;
    }
    return `<li class="row ch-row">
      <input type="checkbox" data-sel="${esc(ch.id)}" ${st.selected.has(ch.id) ? 'checked' : ''} ${eligible ? '' : 'disabled'} aria-label="Select ${esc(U.channelLabel(ch))}">
      <div class="grow">
        <div class="ellipsis"><b>${esc(U.channelLabel(ch))}</b> <span class="muted small">${esc(ch.handle || '')}</span></div>
        ${status}
      </div>
      <div class="actions">${actions}</div>
    </li>`;
  }

  function renderInvite() {
    const el = $('#invite');
    if (!isVideoPage()) return el.classList.add('hidden');
    el.classList.remove('hidden');
    const c = st.ctx;
    if (!c.videoId) {
      el.innerHTML = `<h2>Invite collaborators</h2><p class="small muted">The upload dialog is open, but its video ID isn't showing yet. Wait until the upload has started, then reopen this popup.</p>`;
      return;
    }
    const others = st.data.channels.filter((ch) => !st.active || ch.id !== st.active.id);
    const known = latest(invitesList().filter((i) => i.videoId === c.videoId && i.videoTitle));
    const title = c.videoTitle || (known && known.videoTitle) || '';
    const header = `<h2>Invite collaborators</h2>
      <div class="small">Video: <b>${esc(title || 'untitled')}</b> <span class="mono muted">${esc(c.videoId)}</span></div>`;
    if (st.activeState !== 'ok') {
      el.innerHTML = `${header}<p class="small muted">Waiting to know which channel is signed in…</p>`;
      return;
    }
    if (!others.length) {
      el.innerHTML = `${header}<p class="small muted">No other channels saved yet. In each channel's profile press <b>Save this channel</b>, then bring them here with a hand-off code or Options → Import.</p>`;
      return;
    }
    const rows = others.map((ch) => channelRow(ch, c.videoId)).join('');
    const n = st.selected.size;
    el.innerHTML = `${header}
      <ul class="list">${rows}</ul>
      <div class="row footer-row">
        <button class="tiny" data-act="select-all">Select all</button>
        <span class="grow small muted">${st.data.settings.dryRun ? 'Dry run: nothing will be created.' : 'Analytics access is always switched on.'}</span>
        <button class="primary" data-act="invite-selected" ${n ? '' : 'disabled'}>Invite selected${n ? ` (${n})` : ''}</button>
      </div>`;
  }

  function renderAccept() {
    const el = $('#accept');
    const pending = invitesList().filter((i) => i.status === 'pending');
    if (!pending.length) return el.classList.add('hidden');
    el.classList.remove('hidden');
    if (st.activeState !== 'ok') {
      el.innerHTML = `<h2>Accept invites</h2><p class="small muted">${pending.length} pending invite(s). Waiting to know which channel is signed in…</p>`;
      return;
    }
    const mine = pending.filter((i) => i.to.id === st.active.id).sort((a, b) => b.createdAt - a.createdAt);
    const others = new Map();
    for (const i of pending) {
      if (i.to.id === st.active.id) continue;
      const k = i.to.id || i.to.handle;
      others.set(k, { to: i.to, n: (others.get(k) || { n: 0 }).n + 1 });
    }
    const rows = mine
      .map((i) => {
        const job = jobFor((j) => j.type === 'accept' && j.inviteId === i.id);
        const live = isLive(job);
        let line = '';
        if (live) line = `<div class="step">${UI.jobIcon(job)} ${esc(job.step)}</div>`;
        else if (job && job.state === 'error') line = `<div class="err">❌ ${esc(job.step)}</div>`;
        else if (job && job.state === 'done' && job.dryRun) line = `<div class="step">👁 ${esc(job.step)}</div>`;
        else if (i.note) line = `<div class="note">${esc(i.note)}</div>`;
        return `<li class="row ch-row">
          <div class="grow">
            <div class="ellipsis"><b>${esc(i.videoTitle || i.videoId || 'video')}</b></div>
            <div class="small muted">from ${esc(U.channelLong(i.from))} · ${esc(U.timeAgo(i.createdAt))}</div>
            ${line}
          </div>
          <div class="actions">
            ${live ? `<button class="tiny" data-act="job-cancel" data-job="${esc(job.id)}">Stop</button>` : `<button class="tiny primary" data-act="accept-one" data-inv="${esc(i.id)}">${job && job.state === 'error' ? 'Retry' : 'Accept'}</button>`}
            <button class="tiny" data-act="copy-link" data-inv="${esc(i.id)}">Copy link</button>
          </div>
        </li>`;
      })
      .join('');
    const otherHtml = [...others.values()]
      .map((o) => `<li>${esc(U.channelLong(o.to))}: ${o.n} invite(s). Switch to that channel to accept.</li>`)
      .join('');
    const acceptable = mine.filter((i) => !isLive(jobFor((j) => j.type === 'accept' && j.inviteId === i.id)));
    el.innerHTML = `<div class="row"><h2 class="grow">Accept invites for this channel</h2>
        ${acceptable.length > 1 ? `<button class="primary" data-act="accept-all">Accept all (${acceptable.length})</button>` : ''}</div>
      ${mine.length ? `<ul class="list">${rows}</ul>` : '<p class="small muted">No pending invites for the signed-in channel.</p>'}
      ${otherHtml ? `<div class="small muted" style="margin-top:8px">Waiting for other channels:</div><ul class="others">${otherHtml}</ul>` : ''}`;
  }

  function renderJobs() {
    const list = UI.recentJobs(st.data.jobs, { limit: 8 });
    $('#jobs').classList.toggle('hidden', !list.length);
    $('#jobs-list').innerHTML = UI.jobsHtml(list);
  }

  function renderChannels() {
    const chans = st.data.channels;
    const items = chans
      .map((c) => {
        const me = st.active && c.id === st.active.id;
        return `<li class="row"><span class="grow ellipsis">${esc(U.channelLabel(c))} <span class="muted">${esc(c.handle || 'no handle')}</span></span>${me ? '<span class="chip chip-accepted">signed in</span>' : ''}</li>`;
      })
      .join('');
    $('#channels').innerHTML = `<div class="row"><h2 class="grow">Your channels</h2><span class="small muted">${chans.length} saved</span></div>
      <div class="row"><button class="primary" data-act="save-channel" title="Reads the signed-in channel's ID, name and handle">Save this channel</button>
      <span class="small muted grow">Do this once in each channel's profile.</span></div>
      ${items ? `<ul class="list small" style="margin-top:6px">${items}</ul>` : ''}`;
  }

  function renderRecorder() {
    const on = st.data.recorder.on;
    const idx = st.data.recIndex;
    $('#rec-toggle').textContent = on ? 'Stop recording' : 'Start recording';
    $('#rec-toggle').classList.toggle('primary', !on);
    $('#rec-badge').innerHTML = on ? '<span class="chip chip-failed">● recording</span>' : idx.count ? `<span class="chip chip-queued">${idx.count} events</span>` : '';
    $('#rec-stats').textContent = idx.count ? `${idx.count} events · ${Math.round(idx.chars / 1024)} KB` : 'Nothing recorded yet.';
    $('#rec-reason').textContent = st.data.recorder.stoppedReason || '';
    if (on) $('#recorder').open = true;
  }

  function renderHistory() {
    const list = invitesList().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);
    const el = $('#history');
    if (!list.length) return el.classList.add('hidden');
    el.classList.remove('hidden');
    el.innerHTML = `<div class="row"><h2 class="grow">Recent invites</h2><button class="link small" data-act="open-manager">All in Manager →</button></div>
      <ul class="list">${list
        .map(
          (i) => `<li class="row">
          ${UI.chip(i.status)}
          <div class="grow">
            <div class="ellipsis">${esc(i.videoTitle || i.videoId)}</div>
            <div class="small muted ellipsis">${esc(U.channelLabel(i.from))} → ${esc(U.channelLong(i.to))} · ${esc(U.timeAgo(i.updatedAt))}</div>
            ${i.status === 'failed' && i.error ? `<div class="err">${esc(i.error)}</div>` : ''}
          </div>
          ${i.link ? `<button class="tiny" data-act="copy-link" data-inv="${esc(i.id)}">Copy link</button>` : ''}
          ${i.status === 'failed' ? `<button class="tiny" data-act="retry-invite" data-inv="${esc(i.id)}">Retry</button>` : ''}
        </li>`,
        )
        .join('')}</ul>`;
  }

  function renderAll() {
    if (!st.data) return;
    renderHeader();
    renderInvite();
    renderAccept();
    renderJobs();
    renderChannels();
    renderRecorder();
    renderHistory();
  }

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------

  async function startInvites(ids) {
    const r = await UI.send('invite:start', { tabId: st.tabId, targetIds: ids, videoId: st.ctx.videoId, videoTitle: st.ctx.videoTitle || '' });
    ids.forEach((id) => st.selected.delete(id));
    if (r.skipped.length) say(`Skipped:\n${r.skipped.join('\n')}`, 'warn');
    else say(`${st.data.settings.dryRun ? 'Dry run' : 'Invite'} started for ${r.count} channel(s). You can close this popup; it keeps going.`, 'ok');
  }

  async function startAccepts(ids) {
    const r = await UI.send('accept:start', { inviteIds: ids });
    if (r.skipped.length) say(`Skipped:\n${r.skipped.join('\n')}`, 'warn');
    else say(`${st.data.settings.dryRun ? 'Dry run' : 'Accept'} started for ${r.count} invite(s).`, 'ok');
  }

  async function buildRecording() {
    const all = await chrome.storage.local.get(null);
    const events = Object.keys(all)
      .filter((k) => k.startsWith('rec:'))
      .sort()
      .map((k) => all[k]);
    return JSON.stringify(
      {
        format: 'ytcollab-recording',
        version: 1,
        extensionVersion: chrome.runtime.getManifest().version,
        selectorsVersion: YTC.SEL.version,
        exportedAt: new Date().toISOString(),
        userAgent: navigator.userAgent,
        language: navigator.language,
        events,
      },
      null,
      1,
    );
  }

  const ACTIONS = {
    detect: () => detectActive(0),
    'open-manager': () => chrome.tabs.create({ url: chrome.runtime.getURL('manager/manager.html') }),
    'open-options': () => chrome.runtime.openOptionsPage(),

    'invite-one': (b) => startInvites([b.dataset.ch]),
    'invite-selected': () => startInvites([...st.selected]),
    'select-all': () => {
      for (const cb of document.querySelectorAll('[data-sel]:not(:disabled)')) st.selected.add(cb.dataset.sel);
      renderInvite();
    },
    'retry-invite': async (b) => {
      const r = await UI.send('invite:retry', { inviteId: b.dataset.inv, tabId: st.tabId });
      if (r.skipped && r.skipped.length) say(r.skipped.join('\n'), 'warn');
      else say('Retry queued.', 'ok');
    },
    'accept-one': (b) => startAccepts([b.dataset.inv]),
    'accept-all': () =>
      startAccepts(
        invitesList()
          .filter((i) => i.status === 'pending' && st.active && i.to.id === st.active.id)
          .filter((i) => !isLive(jobFor((j) => j.type === 'accept' && j.inviteId === i.id)))
          .map((i) => i.id),
      ),
    'copy-link': async (b) => {
      const inv = st.data.invites[b.dataset.inv];
      if (!inv || !inv.link) throw new Error(U.errorText('NO_LINK'));
      await UI.copy(inv.link);
      say(`Link for ${U.channelLong(inv.to)} copied.`, 'ok');
    },
    'jobs-clear': () => UI.send('jobs:clearFinished'),

    'save-channel': async (b) => {
      b.disabled = true;
      say('Reading the signed-in channel (opens Studio and the channel page briefly in background tabs)…', 'info', { sticky: true });
      try {
        const r = await UI.send('channels:saveCurrent', { tabId: st.tabId });
        st.active = { id: r.channel.id, at: Date.now(), source: 'probe' };
        st.activeState = 'ok';
        const text = `${r.created ? 'Saved' : 'Updated'} ${U.channelLong(r.channel)}.`;
        say(r.warning ? `${text} ${r.warning}` : text, r.warning ? 'warn' : 'ok');
      } finally {
        b.disabled = false;
      }
    },

    'copy-pending': async () => {
      const r = await UI.send('handoff:export', { kind: 'pending' });
      await UI.copy(r.code);
      say(`Code with ${r.count} pending invite(s) copied. In the invited channel's profile open this popup → Paste code.`, 'ok');
    },
    'copy-results': async () => {
      const r = await UI.send('handoff:export', { kind: 'results' });
      await UI.copy(r.code);
      say(`Code with ${r.count} accepted invite(s) copied. Paste it in the inviting channel's profile to update its history.`, 'ok');
    },
    'paste-toggle': () => {
      $('#paste-box').classList.toggle('hidden');
      $('#paste-text').focus();
    },
    'paste-cancel': () => {
      $('#paste-text').value = '';
      $('#paste-box').classList.add('hidden');
    },
    'paste-import': async () => {
      const r = await UI.send('import', { text: $('#paste-text').value });
      $('#paste-text').value = '';
      $('#paste-box').classList.add('hidden');
      say(
        `Imported: ${r.invitesAdded} new invite(s), ${r.invitesUpdated} updated; ${r.channelsAdded} new channel(s).`,
        r.invitesAdded + r.invitesUpdated + r.channelsAdded ? 'ok' : 'info',
      );
      if (st.activeState !== 'ok') detectActive();
    },

    'rec-toggle': async () => {
      const on = !st.data.recorder.on;
      await UI.send('recorder:set', { on });
      say(on ? 'Recording. Do the flow by hand in Studio; the red badge on the page shows it is on.' : 'Recording stopped.', 'ok');
    },
    'rec-note': async () => {
      const t = $('#rec-note').value.trim();
      if (!t) return;
      await UI.send('recorder:note', { text: t });
      $('#rec-note').value = '';
      say('Note added.', 'ok');
    },
    'rec-snapshot': async () => {
      const r = await UI.send('recorder:snapshot', { tabId: st.tabId });
      say(`Page saved into the recording (${Math.round(r.chars / 1024)} KB${r.truncated ? ', cut at the size limit' : ''}, ${r.dialogs} dialog(s)).`, 'ok');
    },
    'rec-copy': async () => {
      const json = await buildRecording();
      await UI.copy(json);
      say(`Recording copied (${Math.round(json.length / 1024)} KB). If it's too big to paste, use Download.`, 'ok');
    },
    'rec-download': async () => {
      UI.download(`ytcollab-recording-${UI.stamp()}.json`, await buildRecording());
    },
    'rec-clear': async () => {
      if (!confirm('Delete the recording stored in this profile?')) return;
      await UI.send('recorder:clear');
      say('Recording cleared.', 'ok');
    },
  };

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || !ACTIONS[b.dataset.act]) return;
    try {
      await ACTIONS[b.dataset.act](b);
    } catch (err) {
      fail(err);
    }
  });

  document.addEventListener('change', (e) => {
    const cb = e.target.closest('[data-sel]');
    if (!cb) return;
    cb.checked ? st.selected.add(cb.dataset.sel) : st.selected.delete(cb.dataset.sel);
    renderInvite();
  });

  $('#rec-note').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ACTIONS['rec-note']().catch(fail);
  });

  UI.bindJobButtons(document.body, { tabId: () => st.tabId, onError: (m) => say(m, 'bad') });

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------

  (async () => {
    const qs = new URLSearchParams(location.search);
    if (qs.has('tab')) st.tabId = Number(qs.get('tab'));
    else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      st.tabId = tab ? tab.id : null;
    }
    UI.send('wake').catch(() => {});
    await loadData();
    renderAll();
    UI.onStorage(async () => {
      await loadData();
      renderAll();
    });

    if (st.tabId != null) {
      try {
        st.ctx = (await UI.send('context', { tabId: st.tabId })).context;
      } catch {
        st.ctx = { kind: 'other' };
      }
    }
    if (st.ctx && st.ctx.channelId && st.activeState !== 'ok') {
      st.active = { id: st.ctx.channelId, at: Date.now(), source: 'tab' };
      st.activeState = 'ok';
    }
    renderAll();

    // Only open a background Studio tab when the answer matters here.
    const pending = invitesList().some((i) => i.status === 'pending');
    if (isVideoPage() || pending || (st.ctx && st.ctx.kind.startsWith('studio'))) await detectActive(120000);
  })().catch(fail);
})();
