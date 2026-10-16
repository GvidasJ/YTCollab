/*
 * Storage schema, merge rules and the hand-off code format.
 *
 * Everything persistent lives in chrome.storage.local. Only the service
 * worker writes (through a lock in background.js); the popup and options page
 * read directly and ask the service worker to change things.
 *
 * Keys
 *   settings   { dryRun, stepDelayMs, stepTimeoutMs, backgroundTabs }
 *   channels   [ { id, handle, name, label, addedAt, updatedAt } ]  (array order = display order)
 *   invites    { [inviteId]: Invite }
 *   jobs       { [jobId]: Job }      (the run queue + live progress)
 *   recorder   { on, startedAt }
 *   recIndex   { seq, chars, count } and rec:000001… one key per recorded event
 *
 * Invite
 *   { id, videoId, videoTitle,
 *     from: { id, handle, name },          inviting (uploading) channel
 *     to:   { id, handle, name },          invited channel
 *     link, analytics: true,
 *     status: 'pending' | 'accepted' | 'failed' | 'removed',
 *     error, errorCode, note,
 *     createdAt, updatedAt, acceptedAt, removedAt }
 *
 *   pending   link created, not accepted yet
 *   accepted  the invited channel accepted it
 *   failed    the invite couldn't be created (no usable link)
 *   removed   the collaborator was taken off the video (Manager tab)
 */
(function () {
  const YTC = (globalThis.YTC = globalThis.YTC || {});
  if (YTC.store) return;
  const U = YTC.util;

  const S = (YTC.store = {});

  S.DEFAULT_SETTINGS = {
    // Dry run stays on until you've watched it highlight the right things.
    dryRun: true,
    // Pause between actions (ms). Keeps it to one action at a time.
    stepDelayMs: 700,
    // How long to wait for any single element / page state (ms).
    stepTimeoutMs: 20000,
    // Open the tabs the extension needs (invite links for Accept, a video's
    // Details page for Remove / Retry) in the background (true) or focused.
    // Dry runs always open them focused so you can watch.
    backgroundTabs: true,
  };

  S.MAX_COLLABORATORS = 10;

  S.STATUSES = ['pending', 'accepted', 'failed', 'removed'];

  S.getAll = async () => {
    const d = await chrome.storage.local.get(['settings', 'channels', 'invites', 'jobs', 'recorder', 'recIndex']);
    return {
      settings: { ...S.DEFAULT_SETTINGS, ...(d.settings || {}) },
      channels: Array.isArray(d.channels) ? d.channels : [],
      invites: d.invites && typeof d.invites === 'object' ? d.invites : {},
      jobs: d.jobs && typeof d.jobs === 'object' ? d.jobs : {},
      recorder: d.recorder || { on: false },
      recIndex: d.recIndex || { seq: 0, chars: 0, count: 0 },
    };
  };

  // ---------------------------------------------------------------------
  // Sanitising anything that comes from outside (imports, pasted codes)
  // ---------------------------------------------------------------------

  const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

  S.cleanChannelRef = (c) => {
    if (!c || typeof c !== 'object') return null;
    const id = U.CHANNEL_ID_RE.test(c.id) ? c.id : '';
    const handle = U.normHandle(str(c.handle, 40));
    if (!id && !handle) return null;
    return { id, handle, name: str(c.name, 200) };
  };

  S.cleanChannel = (c) => {
    const ref = S.cleanChannelRef(c);
    if (!ref || !ref.id) return null;
    return {
      ...ref,
      label: str(c.label, 200),
      addedAt: num(c.addedAt) || Date.now(),
      updatedAt: num(c.updatedAt) || Date.now(),
    };
  };

  S.cleanInvite = (i) => {
    if (!i || typeof i !== 'object' || typeof i.id !== 'string' || !/^inv_[\w]{4,40}$/.test(i.id)) return null;
    const to = S.cleanChannelRef(i.to);
    const from = S.cleanChannelRef(i.from);
    if (!to) return null;
    const status = S.STATUSES.includes(i.status) ? i.status : 'pending';
    const link = typeof i.link === 'string' && U.isAllowedInviteLink(i.link) ? i.link : '';
    return {
      id: i.id,
      videoId: U.VIDEO_ID_RE.test(i.videoId) ? i.videoId : '',
      videoTitle: str(i.videoTitle, 300),
      from,
      to,
      link,
      analytics: i.analytics === true,
      status,
      error: str(i.error, 500),
      errorCode: str(i.errorCode, 40),
      note: str(i.note, 300),
      createdAt: num(i.createdAt),
      updatedAt: num(i.updatedAt),
      acceptedAt: num(i.acceptedAt),
      removedAt: num(i.removedAt),
    };
  };

  // ---------------------------------------------------------------------
  // Merge rules
  // ---------------------------------------------------------------------

  /** Add channels we don't know; refresh name/handle of ones we do (keeps your label and order). */
  S.mergeChannels = (existing, incoming) => {
    const out = existing.map((c) => ({ ...c }));
    let added = 0;
    let updated = 0;
    for (const raw of incoming || []) {
      const c = S.cleanChannel(raw);
      if (!c) continue;
      const cur = out.find((x) => x.id === c.id);
      if (!cur) {
        out.push({ ...c, label: c.label || '' });
        added++;
      } else if (c.updatedAt > (cur.updatedAt || 0) && (c.name !== cur.name || c.handle !== cur.handle)) {
        cur.name = c.name || cur.name;
        cur.handle = c.handle || cur.handle;
        cur.updatedAt = c.updatedAt;
        updated++;
      }
    }
    return { channels: out, added, updated };
  };

  /**
   * Newer updatedAt wins, with two guards: an accepted invite never goes back
   * to pending/failed, and a removed one only changes on a newer record.
   * Acceptance from the other profile always gets through (clocks differ).
   */
  S.mergeInvites = (existing, incoming) => {
    const out = { ...existing };
    let added = 0;
    let updated = 0;
    for (const raw of incoming || []) {
      const inv = S.cleanInvite(raw);
      if (!inv) continue;
      const cur = out[inv.id];
      if (!cur) {
        out[inv.id] = inv;
        added++;
        continue;
      }
      if (cur.status === 'accepted' && (inv.status === 'pending' || inv.status === 'failed')) continue;
      const newer = inv.updatedAt > (cur.updatedAt || 0);
      const promotes = inv.status === 'accepted' && (cur.status === 'pending' || cur.status === 'failed');
      if (newer || promotes) {
        out[inv.id] = { ...cur, ...inv, link: inv.link || cur.link };
        updated++;
      }
    }
    return { invites: out, added, updated };
  };

  // ---------------------------------------------------------------------
  // Hand-off code: "YTC1." + base64url(gzip(JSON))
  // One code carries channels + invites (with links) between Chrome profiles.
  // ---------------------------------------------------------------------

  const PREFIX = 'YTC1.';

  const b64urlEncode = (bytes) => {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const b64urlDecode = (s) => {
    const b = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b + '='.repeat((4 - (b.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  };
  const pipe = async (bytes, stream) =>
    new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

  S.encodeCode = async (payload) => {
    const json = new TextEncoder().encode(JSON.stringify(payload));
    return PREFIX + b64urlEncode(await pipe(json, new CompressionStream('gzip')));
  };

  /** Accepts a YTC1 code or plain JSON (an export file works too). */
  S.decodeCode = async (text) => {
    const t = String(text || '').trim().replace(/\s+/g, '');
    let obj;
    if (t.startsWith(PREFIX)) {
      try {
        const bytes = await pipe(b64urlDecode(t.slice(PREFIX.length)), new DecompressionStream('gzip'));
        obj = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new Error("That code is damaged or incomplete. Copy it again and paste the whole thing.");
      }
    } else {
      try {
        obj = JSON.parse(String(text || '').trim());
      } catch {
        throw new Error('That is not a YT Collab code (it should start with YTC1.) or an export file.');
      }
    }
    if (!obj || typeof obj !== 'object') throw new Error('Nothing to import in that code.');
    return {
      channels: Array.isArray(obj.channels) ? obj.channels : [],
      invites: Array.isArray(obj.invites) ? obj.invites : Object.values(obj.invites || {}),
    };
  };
})();
