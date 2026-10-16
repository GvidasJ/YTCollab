/*
 * Helpers shared by the popup, the Manager tab and the options page.
 * Pages never write storage themselves; they ask the service worker.
 */
(function () {
  const YTC = globalThis.YTC;
  const U = YTC.util;
  const UI = (YTC.ui = {});

  UI.$ = (sel, root = document) => root.querySelector(sel);
  UI.esc = U.escapeHtml;

  /** Ask the service worker; throws an Error with its plain-English message. */
  UI.send = async (type, payload = {}) => {
    let r;
    try {
      r = await chrome.runtime.sendMessage({ type, ...payload });
    } catch (e) {
      throw new Error(`The extension didn't answer (${e.message}). Try again.`);
    }
    if (!r || !r.ok) {
      const err = new Error((r && r.error) || 'The extension did not answer.');
      err.code = r && r.code;
      throw err;
    }
    return r;
  };

  UI.copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (!ok) throw new Error('Could not copy to the clipboard.');
    }
  };

  UI.download = (filename, text, type = 'application/json') => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  UI.stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

  const STATUS_LABEL = {
    pending: 'pending',
    accepted: 'accepted',
    failed: 'failed',
    removed: 'removed',
    queued: 'queued',
    running: 'running',
    done: 'done',
    error: 'error',
    cancelled: 'stopped',
  };
  UI.chip = (status) => `<span class="chip chip-${UI.esc(status)}">${UI.esc(STATUS_LABEL[status] || status)}</span>`;

  /** "Accept on @foo", "Invite @foo", "Remove @foo" */
  UI.jobTitle = (j) => {
    const who = U.channelLong(j.target);
    const video = j.video && (j.video.title || j.video.id);
    const on = video ? ` · “${video}”` : '';
    if (j.type === 'invite') return `Invite ${who}${on}`;
    if (j.type === 'accept') return `Accept as ${who}${on}`;
    return `Remove ${who}${on}`;
  };

  UI.jobIcon = (j) => {
    if (j.state === 'running') return '<span class="spinner" aria-label="running"></span>';
    if (j.state === 'queued') return '⏳';
    if (j.state === 'done') return j.dryRun ? '👁' : '✅';
    if (j.state === 'cancelled') return '⏹';
    return '❌';
  };

  /** Jobs that are live, or finished within `sinceMs`. Newest first. */
  UI.recentJobs = (jobs, { sinceMs = 15 * 60000, limit = 10, filter } = {}) =>
    Object.values(jobs)
      .filter((j) => (j.state === 'queued' || j.state === 'running' || Date.now() - (j.updatedAt || 0) < sinceMs) && (!filter || filter(j)))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);

  UI.jobsHtml = (list) =>
    list
      .map((j) => {
        const live = j.state === 'queued' || j.state === 'running';
        const retry = j.state === 'error' || j.state === 'cancelled';
        return `<li class="job ${UI.esc(j.state)}">
          <div class="row">
            <span>${UI.jobIcon(j)}</span>
            <span class="grow ellipsis" title="${UI.esc(UI.jobTitle(j))}">${UI.esc(UI.jobTitle(j))}${j.dryRun ? ' <span class="chip chip-dry">dry run</span>' : ''}</span>
            ${live ? `<button class="tiny" data-act="job-cancel" data-job="${UI.esc(j.id)}">Stop</button>` : ''}
            ${retry ? `<button class="tiny" data-act="job-retry" data-job="${UI.esc(j.id)}">Retry</button>` : ''}
          </div>
          <div class="step">${UI.esc(j.step || '')}</div>
        </li>`;
      })
      .join('');

  /** Wire Stop / Retry buttons rendered by jobsHtml. Call once per page. */
  UI.bindJobButtons = (root, { tabId, onError }) => {
    root.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act="job-cancel"], [data-act="job-retry"]');
      if (!b) return;
      b.disabled = true;
      try {
        if (b.dataset.act === 'job-cancel') await UI.send('job:cancel', { jobId: b.dataset.job });
        else {
          const r = await UI.send('job:retry', { jobId: b.dataset.job, tabId: tabId() });
          if (r.skipped && r.skipped.length) onError(r.skipped.join('\n'));
        }
      } catch (err) {
        onError(err.message);
      } finally {
        b.disabled = false;
      }
    });
  };

  /** Show a message in a .notice element; clears after a while unless sticky. */
  UI.notice = (el, text, kind = 'info', { sticky = false } = {}) => {
    clearTimeout(el._t);
    if (!text) {
      el.className = 'notice hidden';
      el.textContent = '';
      return;
    }
    el.className = `notice ${kind}`;
    el.textContent = text;
    if (!sticky) el._t = setTimeout(() => UI.notice(el, ''), kind === 'bad' ? 15000 : 7000);
  };

  /** Re-run fn whenever extension storage changes (coalesced). */
  UI.onStorage = (fn) => {
    let t = 0;
    chrome.storage.onChanged.addListener((_c, area) => {
      if (area !== 'local' && area !== 'session') return;
      clearTimeout(t);
      t = setTimeout(fn, 60);
    });
  };

  UI.activeText = (active, channels) => {
    if (!active) return '';
    const ch = channels.find((c) => c.id === active.id);
    return ch ? U.channelLong(ch) : `${active.id} (not saved yet)`;
  };
})();
