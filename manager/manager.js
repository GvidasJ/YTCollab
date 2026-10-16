/*
 * Manager tab: every invite this profile knows about, grouped by video, with
 * Accept, Retry, Copy link, Remove from video (drives Studio) and Remove from
 * list (local only). A full tab, so it doesn't close when you click away.
 */
(function () {
  const YTC = globalThis.YTC;
  const U = YTC.util;
  const S = YTC.store;
  const UI = YTC.ui;
  const { $, esc } = UI;

  const st = { data: null, active: null, activeState: 'idle', activeError: '', selected: new Set(), myTabId: null };

  const noticeEl = $('#notice');
  const say = (text, kind = 'info', opts) => UI.notice(noticeEl, text, kind, opts);
  const fail = (e) => say(e.message || String(e), 'bad');

  const isLive = (j) => j && (j.state === 'queued' || j.state === 'running');
  const liveJobFor = (inviteId) => Object.values(st.data.jobs).find((j) => isLive(j) && j.inviteId === inviteId);
  const lastJobFor = (inviteId) =>
    Object.values(st.data.jobs)
      .filter((j) => j.inviteId === inviteId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];

  async function loadData() {
    st.data = await S.getAll();
    const { active } = await chrome.storage.session.get('active');
    if (active && st.activeState !== 'detecting') {
      st.active = active;
      st.activeState = 'ok';
    }
  }

  async function detectActive(maxAgeMs) {
    st.activeState = 'detecting';
    render();
    try {
      st.active = (await UI.send('activeChannel', { maxAgeMs })).active;
      st.activeState = 'ok';
    } catch (e) {
      st.activeState = 'error';
      st.activeError = e.message;
    }
    render();
  }

  // ------------------------------------------------------------------
  // Filtering
  // ------------------------------------------------------------------

  function filtered() {
    const q = U.normText($('#q').value);
    const status = $('#status').value;
    const side = $('#side').value;
    return Object.values(st.data.invites).filter((i) => {
      if (status && i.status !== status) return false;
      if (side && st.active) {
        if (side === 'from' && i.from.id !== st.active.id) return false;
        if (side === 'to' && i.to.id !== st.active.id) return false;
      }
      if (!q) return true;
      const hay = U.normText([i.videoTitle, i.videoId, i.from.name, i.from.handle, i.to.name, i.to.handle, i.to.id].join(' '));
      return hay.includes(q);
    });
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  function renderHeader() {
    $('#dry').classList.toggle('hidden', !st.data.settings.dryRun);
    const el = $('#active');
    if (st.activeState === 'detecting') el.innerHTML = '<span class="spinner"></span> Checking which channel is signed in…';
    else if (st.activeState === 'error') el.innerHTML = `<span class="err">${esc(st.activeError)}</span> <button class="link" data-act="detect">Try again</button>`;
    else if (st.active) {
      el.innerHTML = `Signed in as <b>${esc(UI.activeText(st.active, st.data.channels))}</b> <button class="link small" data-act="detect">re-check</button>`;
    } else el.innerHTML = '<button class="link" data-act="detect">Check which channel is signed in</button>';
  }

  function inviteRow(i) {
    const live = liveJobFor(i.id);
    const last = lastJobFor(i.id);
    const recentErr = last && last.state === 'error' && Date.now() - last.updatedAt < 60 * 60000 ? last.step : '';
    const recentDry = last && last.state === 'done' && last.dryRun && Date.now() - last.updatedAt < 60 * 60000 ? last.step : '';
    let detail = '';
    if (live) detail = `<div class="step">${UI.jobIcon(live)} ${esc(live.step)}</div>`;
    else if (recentErr) detail = `<div class="err">❌ ${esc(recentErr)}</div>`;
    else if (recentDry) detail = `<div class="step">👁 ${esc(recentDry)}</div>`;
    else if (i.status === 'failed' && i.error) detail = `<div class="err">${esc(i.error)}</div>`;
    else if (i.error) detail = `<div class="err">${esc(i.error)}</div>`;
    if (!live && i.note) detail += `<div class="note">${esc(i.note)}</div>`;

    const when = [
      `invited ${U.timeAgo(i.createdAt)}`,
      i.acceptedAt ? `accepted ${U.timeAgo(i.acceptedAt)}` : '',
      i.removedAt ? `removed ${U.timeAgo(i.removedAt)}` : '',
    ]
      .filter(Boolean)
      .join(' · ');

    const btn = (act, label, cls = '') => `<button class="tiny ${cls}" data-act="${act}" data-inv="${esc(i.id)}">${label}</button>`;
    const actions = live
      ? `<button class="tiny" data-act="job-cancel" data-job="${esc(live.id)}">Stop</button>`
      : [
          i.link ? btn('copy-link', 'Copy link') : '',
          i.status === 'pending' ? btn('accept', 'Accept', 'primary') : '',
          i.status === 'failed' ? btn('retry', 'Retry') : '',
          i.status === 'pending' || i.status === 'accepted' ? btn('remove', 'Remove from video', 'danger') : '',
          btn('forget', 'Remove from list'),
        ].join('');

    return `<tr>
      <td class="sel"><input type="checkbox" data-sel="${esc(i.id)}" ${st.selected.has(i.id) ? 'checked' : ''} ${live ? 'disabled' : ''} aria-label="Select"></td>
      <td><b>${esc(U.channelLabel(i.to))}</b> <span class="muted small">${esc(i.to.handle || '')}</span>
        <div class="small muted">${esc(when)}</div>${detail}</td>
      <td>${UI.chip(i.status)}${i.analytics ? ' <span class="small muted" title="Analytics access was verified on before the link was created">📊</span>' : ''}</td>
      <td class="actions">${actions}</td>
    </tr>`;
  }

  function renderVideos() {
    const list = filtered();
    const groups = new Map();
    for (const i of list) {
      const k = i.videoId || '(no video ID)';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(i);
    }
    const sorted = [...groups.entries()].sort(
      (a, b) => Math.max(...b[1].map((i) => i.updatedAt || 0)) - Math.max(...a[1].map((i) => i.updatedAt || 0)),
    );
    $('#empty').classList.toggle('hidden', Object.keys(st.data.invites).length > 0);
    $('#videos').innerHTML = sorted
      .map(([videoId, invs]) => {
        const title = (invs.find((i) => i.videoTitle) || {}).videoTitle || 'Untitled video';
        const froms = [...new Set(invs.map((i) => U.channelLong(i.from)))].join(', ');
        const counts = S.STATUSES.map((s) => [s, invs.filter((i) => i.status === s).length])
          .filter(([, n]) => n)
          .map(([s, n]) => `${n} ${s}`)
          .join(' · ');
        invs.sort((a, b) => (a.to.name || a.to.handle).localeCompare(b.to.name || b.to.handle));
        return `<section class="card">
          <div class="row video-head">
            <div class="grow">
              <h3 class="ellipsis">${esc(title)}</h3>
              <div class="meta">${esc(videoId)} · uploaded by ${esc(froms)} · ${esc(counts)}</div>
            </div>
            ${U.VIDEO_ID_RE.test(videoId) ? `<button class="tiny" data-act="open-video" data-video="${esc(videoId)}">Open in Studio</button>` : ''}
          </div>
          <table>
            <thead><tr><th></th><th>Collaborator</th><th>Status</th><th></th></tr></thead>
            <tbody>${invs.map(inviteRow).join('')}</tbody>
          </table>
        </section>`;
      })
      .join('');
    if (list.length === 0 && Object.keys(st.data.invites).length) $('#videos').innerHTML = '<p class="muted">Nothing matches the filter.</p>';
  }

  function renderBulk() {
    for (const id of [...st.selected]) if (!st.data.invites[id]) st.selected.delete(id);
    const n = st.selected.size;
    $('#bulk').classList.toggle('hidden', !n);
    $('#bulk-count').textContent = `${n} selected`;
  }

  function renderJobs() {
    const list = UI.recentJobs(st.data.jobs, { limit: 20, sinceMs: 30 * 60000 });
    $('#jobs').classList.toggle('hidden', !list.length);
    $('#jobs-list').innerHTML = UI.jobsHtml(list);
  }

  function render() {
    if (!st.data) return;
    renderHeader();
    renderJobs();
    renderVideos();
    renderBulk();
  }

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------

  const inv = (b) => st.data.invites[b.dataset.inv];

  function describe(list) {
    return list.map((i) => `• ${U.channelLong(i.to)} on “${i.videoTitle || i.videoId}”`).join('\n');
  }

  async function removeFromVideos(list) {
    const ok = list.filter((i) => i.status === 'pending' || i.status === 'accepted');
    if (!ok.length) throw new Error('Only pending or accepted collaborators can be removed from a video.');
    const dry = st.data.settings.dryRun;
    const msg = dry
      ? `Dry run: highlight what would be clicked to remove these collaborators? Nothing is changed.\n\n${describe(ok)}`
      : `Remove these collaborators from their videos in YouTube Studio?\n\n${describe(ok)}\n\nThis must run in the uploading channel's profile. For each one the extension opens the video's Details page and clicks that collaborator's remove control. Nothing else on the video is changed. You can invite them again later.`;
    if (!confirm(msg)) return;
    const r = await UI.send('remove:start', { inviteIds: ok.map((i) => i.id) });
    report(r, dry ? 'Dry run' : 'Removal');
  }

  async function forget(list) {
    if (!confirm(`Remove these records from this profile's list?\n\n${describe(list)}\n\nYouTube is not touched; collaborators stay on their videos.`)) return;
    const r = await UI.send('invites:forget', { inviteIds: list.map((i) => i.id) });
    list.forEach((i) => st.selected.delete(i.id));
    say(`Removed ${r.removed} record(s) from the list.`, 'ok');
  }

  function report(r, what) {
    if (r.skipped && r.skipped.length) say(`${what} queued for ${r.count}. Skipped:\n${r.skipped.join('\n')}`, r.count ? 'warn' : 'bad');
    else say(`${what} queued for ${r.count}. Progress shows above; you can keep using Chrome.`, 'ok');
  }

  const selectedInvites = () => [...st.selected].map((id) => st.data.invites[id]).filter(Boolean);

  const ACTIONS = {
    detect: () => detectActive(0),
    'open-video': (b) => UI.send('open:video', { videoId: b.dataset.video }),
    'copy-link': async (b) => {
      const i = inv(b);
      if (!i || !i.link) throw new Error(U.errorText('NO_LINK'));
      await UI.copy(i.link);
      say(`Link for ${U.channelLong(i.to)} copied.`, 'ok');
    },
    accept: async (b) => report(await UI.send('accept:start', { inviteIds: [b.dataset.inv] }), st.data.settings.dryRun ? 'Dry run' : 'Accept'),
    retry: async (b) => report(await UI.send('invite:retry', { inviteId: b.dataset.inv }), 'Retry'),
    remove: (b) => removeFromVideos([inv(b)].filter(Boolean)),
    forget: (b) => forget([inv(b)].filter(Boolean)),
    'bulk-accept': async () => {
      const ids = selectedInvites().filter((i) => i.status === 'pending').map((i) => i.id);
      if (!ids.length) throw new Error('None of the selected invites is pending.');
      report(await UI.send('accept:start', { inviteIds: ids }), 'Accept');
    },
    'bulk-remove': () => removeFromVideos(selectedInvites()),
    'bulk-forget': () => forget(selectedInvites()),
    'bulk-clear': () => {
      st.selected.clear();
      render();
    },
    'jobs-stop-all': () => UI.send('job:cancelAll'),
    'jobs-clear': () => UI.send('jobs:clearFinished'),
    'copy-pending': async () => {
      const r = await UI.send('handoff:export', { kind: 'pending' });
      await UI.copy(r.code);
      say(`Code with ${r.count} pending invite(s) copied.`, 'ok');
    },
    'copy-results': async () => {
      const r = await UI.send('handoff:export', { kind: 'results' });
      await UI.copy(r.code);
      say(`Code with ${r.count} accepted / removed invite(s) copied.`, 'ok');
    },
    'paste-import': async () => {
      const r = await UI.send('import', { text: $('#paste-text').value });
      $('#paste-text').value = '';
      say(`Imported: ${r.invitesAdded} new invite(s), ${r.invitesUpdated} updated; ${r.channelsAdded} new channel(s).`, 'ok');
    },
  };

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || !ACTIONS[b.dataset.act]) return;
    b.disabled = true;
    try {
      await ACTIONS[b.dataset.act](b);
    } catch (err) {
      fail(err);
    } finally {
      b.disabled = false;
    }
  });

  document.addEventListener('change', (e) => {
    const cb = e.target.closest('[data-sel]');
    if (!cb) return;
    cb.checked ? st.selected.add(cb.dataset.sel) : st.selected.delete(cb.dataset.sel);
    renderBulk();
  });

  for (const id of ['#q', '#status', '#side']) $(id).addEventListener('input', () => renderVideos());

  UI.bindJobButtons(document.body, { tabId: () => null, onError: (m) => say(m, 'bad') });

  (async () => {
    UI.send('wake').catch(() => {});
    await loadData();
    render();
    UI.onStorage(async () => {
      await loadData();
      render();
    });
    if (st.activeState !== 'ok' && Object.keys(st.data.invites).length) detectActive(120000);
  })().catch(fail);
})();
