/*
 * Options: channels (rename / edit handle / remove / reorder / add by hand),
 * run settings (dry run, background tabs, timing), JSON export / import.
 */
(function () {
  const YTC = globalThis.YTC;
  const U = YTC.util;
  const S = YTC.store;
  const UI = YTC.ui;
  const { $, esc } = UI;

  let data = null;
  const noticeEl = $('#notice');
  const say = (text, kind = 'info') => UI.notice(noticeEl, text, kind);
  const fail = (e) => say(e.message || String(e), 'bad');

  function renderChannels() {
    const tbody = $('#channels');
    // Don't clobber a field you're typing in.
    if (tbody.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    $('#no-channels').classList.toggle('hidden', data.channels.length > 0);
    tbody.innerHTML = data.channels
      .map(
        (c, i) => `<tr data-id="${esc(c.id)}">
        <td class="order">
          <button class="tiny" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
          <button class="tiny" data-act="down" ${i === data.channels.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
        </td>
        <td><input type="text" data-field="label" value="${esc(c.label || '')}" placeholder="${esc(c.name || 'Name')}" aria-label="Display name"></td>
        <td><input type="text" data-field="handle" value="${esc(c.handle || '')}" placeholder="@handle" aria-label="Handle"></td>
        <td class="id mono">${esc(c.id)}</td>
        <td class="actions"><button class="tiny danger" data-act="remove">Remove</button></td>
      </tr>`,
      )
      .join('');
  }

  function renderSettings() {
    const s = data.settings;
    $('#dryRun').checked = s.dryRun;
    $('#backgroundTabs').checked = s.backgroundTabs;
    if (document.activeElement !== $('#stepDelayMs')) $('#stepDelayMs').value = s.stepDelayMs;
    if (document.activeElement !== $('#stepTimeoutS')) $('#stepTimeoutS').value = Math.round(s.stepTimeoutMs / 1000);
  }

  function renderStats() {
    const inv = Object.values(data.invites);
    const by = (st) => inv.filter((i) => i.status === st).length;
    $('#stats').textContent = `${data.channels.length} channel(s) · ${inv.length} invite(s): ${by('pending')} pending, ${by('accepted')} accepted, ${by('failed')} failed, ${by('removed')} removed · recording: ${data.recIndex.count} event(s), ${Math.round(data.recIndex.chars / 1024)} KB`;
  }

  async function load() {
    data = await S.getAll();
    renderChannels();
    renderSettings();
    renderStats();
  }

  function exportJson() {
    return JSON.stringify(
      {
        format: 'ytcollab-export',
        version: 1,
        exportedAt: new Date().toISOString(),
        channels: data.channels,
        invites: Object.values(data.invites),
      },
      null,
      2,
    );
  }

  async function importText(text) {
    const r = await UI.send('import', { text });
    say(
      `Imported: ${r.channelsAdded} new channel(s), ${r.channelsUpdated} updated; ${r.invitesAdded} new invite(s), ${r.invitesUpdated} updated.`,
      'ok',
    );
  }

  const rowId = (b) => b.closest('tr').dataset.id;

  const ACTIONS = {
    up: (b) => move(rowId(b), -1),
    down: (b) => move(rowId(b), +1),
    remove: async (b) => {
      const c = data.channels.find((x) => x.id === rowId(b));
      if (!c || !confirm(`Remove ${U.channelLong(c)} from your saved channels? Its invite history stays.`)) return;
      await UI.send('channels:remove', { id: c.id });
      say(`Removed ${U.channelLong(c)}.`, 'ok');
    },
    add: async () => {
      await UI.send('channels:add', { id: $('#add-id').value.trim(), handle: $('#add-handle').value.trim(), name: $('#add-name').value.trim() });
      for (const id of ['#add-id', '#add-handle', '#add-name']) $(id).value = '';
      say('Channel added.', 'ok');
    },
    'export-download': () => UI.download(`ytcollab-export-${UI.stamp()}.json`, exportJson()),
    'export-copy': async () => {
      await UI.copy(exportJson());
      say('Export copied to the clipboard.', 'ok');
    },
    'import-text': async () => {
      await importText($('#import-text').value);
      $('#import-text').value = '';
    },
    'clear-jobs': async () => {
      await UI.send('jobs:clearFinished');
      say('Finished runs cleared.', 'ok');
    },
    'clear-rec': async () => {
      if (!confirm('Delete the recording stored in this profile?')) return;
      await UI.send('recorder:clear');
      say('Recording cleared.', 'ok');
    },
  };

  async function move(id, dir) {
    const ids = data.channels.map((c) => c.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await UI.send('channels:reorder', { ids });
  }

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || !ACTIONS[b.dataset.act]) return;
    try {
      await ACTIONS[b.dataset.act](b);
    } catch (err) {
      fail(err);
    }
  });

  // Channel fields save when you leave them (or press Enter).
  $('#channels').addEventListener('change', async (e) => {
    const input = e.target.closest('input[data-field]');
    if (!input) return;
    try {
      await UI.send('channels:update', { id: rowId(input), [input.dataset.field]: input.value });
      say('Saved.', 'ok');
    } catch (err) {
      fail(err);
      load();
    }
  });
  $('#channels').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input[data-field]')) e.target.blur();
  });
  $('#channels').addEventListener('focusout', () => setTimeout(renderChannels, 0));

  const saveSetting = async (patch) => {
    try {
      await UI.send('settings:set', { patch });
      say('Saved.', 'ok');
    } catch (err) {
      fail(err);
    }
  };
  $('#dryRun').addEventListener('change', (e) => saveSetting({ dryRun: e.target.checked }));
  $('#backgroundTabs').addEventListener('change', (e) => saveSetting({ backgroundTabs: e.target.checked }));
  $('#stepDelayMs').addEventListener('change', (e) => saveSetting({ stepDelayMs: Number(e.target.value) }));
  $('#stepTimeoutS').addEventListener('change', (e) => saveSetting({ stepTimeoutMs: Number(e.target.value) * 1000 }));

  $('#import-file').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      await importText(await f.text());
    } catch (err) {
      fail(err);
    }
  });

  $('#selver').textContent = YTC.SEL.version;
  $('#ver').textContent = chrome.runtime.getManifest().version;

  load().catch(fail);
  UI.onStorage(() => load().catch(fail));
})();
