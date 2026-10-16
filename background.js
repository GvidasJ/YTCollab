/*
 * Service worker: the coordinator.
 *
 *  - Owns every write to chrome.storage.local (through one lock), so the
 *    popup, Manager tab, options page and content scripts never race.
 *  - Runs the job queue: invite / accept / remove, ONE at a time. A job's
 *    browser work happens in a content script in the right tab; this file
 *    opens / checks tabs, confirms the signed-in channel, and records
 *    progress + results.
 *  - Survives restarts: jobs and progress live in storage. A content script
 *    keeps running when this worker sleeps, and its next message wakes it.
 *    A job whose page stopped answering is marked "interrupted" (Retry).
 *  - Detects the signed-in channel by opening Studio in a background tab
 *    (Studio redirects to /channel/<id>), and reads a channel's name and
 *    handle from its public page.
 *  - Stores recorder events and builds hand-off codes.
 */
importScripts('selectors.js', 'lib/shared.js', 'lib/store.js');

const { util: U, store: S, SEL } = self.YTC;
const { FlowError } = U;

// Same files, same order, as manifest.json → content_scripts.
const CONTENT_FILES = ['selectors.js', 'lib/shared.js', 'content/dom.js', 'content/recorder.js', 'content/flows.js', 'content/agent.js'];
const YT_HOSTS = ['studio.youtube.com', 'www.youtube.com'];
const EXT_ORIGIN = chrome.runtime.getURL('');

// Errors that stop the rest of a batch: something is off and continuing
// would mean guessing.
const STOP_BATCH = new Set([
  'UNEXPECTED_UI', 'TIMEOUT', 'INTERRUPTED', 'TAB_GONE', 'WRONG_CHANNEL', 'NOT_SIGNED_IN', 'DISCOVERY_PENDING',
  'ANALYTICS_NOT_FOUND', 'ANALYTICS_NOT_ON', 'LINK_NOT_FOUND', 'SAVE_REQUIRED', 'REMOVE_NOT_CONFIRMED', 'ERROR',
]);
// Errors that leave an accept/remove tab open so you can look at it.
const KEEP_TAB = new Set(['UNEXPECTED_UI', 'TIMEOUT', 'ERROR', 'SAVE_REQUIRED', 'REMOVE_NOT_CONFIRMED', 'NOT_SIGNED_IN']);
const MAX_JOBS_KEPT = 80;

// =====================================================================
// Storage lock
// =====================================================================

let chain = Promise.resolve();
function locked(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

/** Read everything, let fn change it in place, write back the named keys. */
function tx(keys, fn) {
  return locked(async () => {
    const d = await S.getAll();
    const result = await fn(d);
    const out = {};
    for (const k of keys) out[k] = d[k];
    if (keys.includes('jobs')) pruneJobs(out.jobs);
    await chrome.storage.local.set(out);
    return result;
  });
}

function pruneJobs(jobs) {
  const list = Object.values(jobs);
  if (list.length <= MAX_JOBS_KEPT) return;
  const finished = list.filter((j) => isFinal(j.state)).sort((a, b) => a.updatedAt - b.updatedAt);
  for (const j of finished.slice(0, list.length - MAX_JOBS_KEPT)) delete jobs[j.id];
}

const isFinal = (state) => state === 'done' || state === 'error' || state === 'cancelled';
const ref = (c) => ({ id: (c && c.id) || '', handle: (c && c.handle) || '', name: (c && (c.label || c.name)) || '' });

// =====================================================================
// Tabs
// =====================================================================

const tabExists = (tabId) => chrome.tabs.get(tabId).then(() => true, () => false);

function isYouTubeUrl(url) {
  try {
    return YT_HOSTS.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isVerificationUrl(url) {
  try {
    return SEL.common.verificationHosts.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Resolve with the tab's URL once pred(url, tab) holds. */
function waitForTab(tabId, pred, timeout, what) {
  return new Promise((resolve, reject) => {
    let timer = 0;
    const done = (err, url) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      err ? reject(err) : resolve(url);
    };
    const test = (tab) => {
      const url = tab.url || tab.pendingUrl || '';
      if (url && pred(url, tab)) done(null, url);
    };
    const onUpdated = (id, _info, tab) => id === tabId && test(tab);
    const onRemoved = (id) => id === tabId && done(new FlowError('TAB_GONE', 'The tab was closed.'));
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    timer = setTimeout(() => done(new FlowError('TIMEOUT', `Timed out waiting for ${what}.`)), timeout);
    chrome.tabs.get(tabId).then(test, () => done(new FlowError('TAB_GONE', 'The tab was closed.')));
  });
}

const loadedOn = (hosts) => (url, tab) => {
  if (tab.status !== 'complete') return false;
  try {
    const h = new URL(url).hostname;
    return hosts.includes(h) || SEL.common.verificationHosts.includes(h);
  } catch {
    return false;
  }
};

/** Keep this worker alive during long waits that produce no extension events. */
function keepAlive() {
  const t = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  return () => clearInterval(t);
}

async function ensureInjected(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'ping' }, { frameId: 0 });
    if (r && r.ok) return;
  } catch {}
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: CONTENT_FILES });
}

async function sendToTab(tabId, msg) {
  await ensureInjected(tabId);
  return chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
}

async function openTab(url, { active }) {
  const tab = await chrome.tabs.create({ url, active: !!active });
  chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
  return tab;
}

// =====================================================================
// Which channel is signed in?
// =====================================================================

async function remember(id, source) {
  const active = { id, at: Date.now(), source };
  await chrome.storage.session.set({ active });
  return active;
}

let probing = null;

/** Open Studio's root in a background tab; Studio redirects to /channel/<active id>. */
function probeStudioChannel() {
  if (probing) return probing;
  probing = (async () => {
    const stop = keepAlive();
    const tab = await chrome.tabs.create({ url: SEL.urls.studioRoot, active: false });
    try {
      const url = await waitForTab(
        tab.id,
        (u) => !!U.parsePageUrl(u).channelId || isVerificationUrl(u),
        30000,
        'Studio to show the signed-in channel',
      );
      if (isVerificationUrl(url)) {
        throw new FlowError('NOT_SIGNED_IN', 'Studio asked you to sign in in this profile. Open studio.youtube.com, sign in, then try again.');
      }
      return U.parsePageUrl(url).channelId;
    } finally {
      stop();
      chrome.tabs.remove(tab.id).catch(() => {});
    }
  })();
  return probing.finally(() => {
    probing = null;
  });
}

/**
 * The signed-in channel. Order: the given tab's Studio URL (if it shows
 * /channel/<id>), a recent detection (younger than maxAgeMs), a fresh probe.
 * requireProbe: only trust a probe (a tab's URL can be stale after you
 * switch accounts in another tab). Used before Accept / Remove.
 */
async function detectActiveChannel({ tabId, maxAgeMs = 120000, requireProbe = false } = {}) {
  if (tabId != null && !requireProbe) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const p = tab && U.parsePageUrl(tab.url || '');
    if (p && p.channelId) return remember(p.channelId, 'tab');
  }
  if (maxAgeMs > 0) {
    const { active } = await chrome.storage.session.get('active');
    if (active && Date.now() - active.at < maxAgeMs && (!requireProbe || active.source === 'probe')) return active;
  }
  return remember(await probeStudioChannel(), 'probe');
}

// Runs in the page (MAIN world) on www.youtube.com/channel/<id>.
function readChannelMetadata(path) {
  let o = window;
  for (const k of path) o = o == null ? o : o[k];
  if (!o || typeof o !== 'object') return null;
  return { title: String(o.title || ''), externalId: String(o.externalId || ''), vanityChannelUrl: String(o.vanityChannelUrl || '') };
}

/** Name and handle from the channel's public page, opened in a background tab. */
async function readChannelInfo(channelId) {
  const stop = keepAlive();
  const tab = await openTab(SEL.urls.publicChannelUrl(channelId), { active: false });
  try {
    const url = await waitForTab(tab.id, loadedOn(['www.youtube.com']), 30000, 'the channel page to load');
    if (isVerificationUrl(url)) throw new Error('YouTube asked you to sign in');
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: readChannelMetadata,
      args: [SEL.channelPage.metadataPath],
    });
    const meta = res && res.result;
    let name = '';
    let handle = '';
    if (meta && meta.externalId === channelId) {
      name = meta.title;
      const m = meta.vanityChannelUrl.match(SEL.channelPage.handleFromVanityUrl);
      if (m) {
        try {
          handle = decodeURIComponent(m[1]);
        } catch {
          handle = m[1];
        }
      }
    }
    if (!name) {
      const [og] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (sel) => (document.querySelector(sel) || {}).content || '',
        args: [SEL.channelPage.ogTitle],
      });
      name = (og && og.result) || '';
    }
    return { name: String(name).slice(0, 200), handle: U.HANDLE_RE.test(U.normHandle(handle)) ? U.normHandle(handle) : '' };
  } finally {
    stop();
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// =====================================================================
// Channels
// =====================================================================

async function saveCurrentChannel({ tabId }) {
  const active = await detectActiveChannel({ tabId, maxAgeMs: 0 });
  let info = { name: '', handle: '' };
  let warning = '';
  try {
    info = await readChannelInfo(active.id);
  } catch (e) {
    warning = `Saved the channel ID, but couldn't read its name and handle (${e.message}). Add them in Options.`;
  }
  if (!warning && !info.handle) warning = "Couldn't read this channel's handle. Add it in Options: invites search by handle.";
  const now = Date.now();
  const res = await tx(['channels'], (d) => {
    const cur = d.channels.find((c) => c.id === active.id);
    if (cur) {
      cur.name = info.name || cur.name;
      cur.handle = info.handle || cur.handle;
      cur.updatedAt = now;
      return { channel: { ...cur }, created: false };
    }
    const ch = { id: active.id, handle: info.handle, name: info.name, label: '', addedAt: now, updatedAt: now };
    d.channels.push(ch);
    return { channel: ch, created: true };
  });
  return { ...res, warning };
}

function addChannel({ id, handle, name }) {
  if (!U.CHANNEL_ID_RE.test(String(id || '').trim())) throw new Error('Channel ID must look like UC followed by 22 letters, digits, - or _.');
  const h = U.normHandle(handle);
  if (h && !U.HANDLE_RE.test(h)) throw new Error('That handle doesn\'t look right (e.g. @MyChannel).');
  const now = Date.now();
  return tx(['channels'], (d) => {
    if (d.channels.some((c) => c.id === id.trim())) throw new Error('That channel is already saved.');
    d.channels.push({ id: id.trim(), handle: h, name: String(name || '').slice(0, 200), label: '', addedAt: now, updatedAt: now });
    return {};
  });
}

function updateChannel({ id, label, handle, name }) {
  return tx(['channels'], (d) => {
    const c = d.channels.find((x) => x.id === id);
    if (!c) throw new Error('Channel not found.');
    if (label !== undefined) c.label = String(label).trim().slice(0, 200);
    if (name !== undefined) c.name = String(name).trim().slice(0, 200);
    if (handle !== undefined) {
      const h = U.normHandle(handle);
      if (h && !U.HANDLE_RE.test(h)) throw new Error('That handle doesn\'t look right (e.g. @MyChannel).');
      c.handle = h;
    }
    c.updatedAt = Date.now();
    return {};
  });
}

function removeChannel({ id }) {
  return tx(['channels'], (d) => {
    d.channels = d.channels.filter((c) => c.id !== id);
    return {};
  });
}

function reorderChannels({ ids }) {
  return tx(['channels'], (d) => {
    const pos = new Map((ids || []).map((id, i) => [id, i]));
    d.channels.sort((a, b) => (pos.has(a.id) ? pos.get(a.id) : 1e9) - (pos.has(b.id) ? pos.get(b.id) : 1e9));
    return {};
  });
}

function setSettings({ patch }) {
  return tx(['settings'], (d) => {
    const p = patch || {};
    if ('dryRun' in p) d.settings.dryRun = !!p.dryRun;
    if ('backgroundTabs' in p) d.settings.backgroundTabs = !!p.backgroundTabs;
    if ('stepDelayMs' in p) d.settings.stepDelayMs = Math.min(5000, Math.max(200, Number(p.stepDelayMs) || S.DEFAULT_SETTINGS.stepDelayMs));
    if ('stepTimeoutMs' in p) d.settings.stepTimeoutMs = Math.min(120000, Math.max(5000, Number(p.stepTimeoutMs) || S.DEFAULT_SETTINGS.stepTimeoutMs));
    return { settings: d.settings };
  });
}

// =====================================================================
// Page context for the popup
// =====================================================================

async function getContext({ tabId }) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { context: { kind: 'other' } };
  const parsed = U.parsePageUrl(tab.url || '');
  const context = {
    tabId,
    url: tab.url || '',
    kind: parsed.kind,
    videoId: parsed.videoId || '',
    channelId: parsed.channelId || '',
    videoTitle: '',
    uploadDialogOpen: false,
  };
  if (parsed.kind.startsWith('studio')) {
    try {
      const r = await sendToTab(tabId, { type: 'page:context' });
      const c = (r && r.context) || {};
      if (c.kind === 'studio-upload') context.kind = 'studio-upload';
      context.videoId = context.videoId || c.videoId || '';
      context.videoTitle = c.videoTitle || '';
      context.uploadDialogOpen = !!c.uploadDialogOpen;
    } catch (e) {
      context.contentError = e.message;
    }
  }
  return { context };
}

// =====================================================================
// Jobs
// =====================================================================

function newJob(type, fields) {
  const now = Date.now();
  return { id: U.uid('job'), type, state: 'queued', step: 'Waiting to start…', log: [], createdAt: now, updatedAt: now, ...fields };
}

const liveJobFor = (jobs, pred) => Object.values(jobs).some((j) => (j.state === 'queued' || j.state === 'running') && pred(j));

/** Queue invites for saved channels on the video open in tabId. Skips (with a reason) anything that can't go. */
async function startInvites({ tabId, targetIds, videoId, videoTitle }) {
  if (!U.VIDEO_ID_RE.test(videoId || '')) throw new FlowError('NO_VIDEO', U.errorText('NO_VIDEO'));
  const active = await detectActiveChannel({ tabId, maxAgeMs: 120000 });
  const r = await tx(['jobs'], (d) => {
    const skipped = [];
    const live = Object.values(d.invites).filter((i) => i.videoId === videoId && (i.status === 'pending' || i.status === 'accepted'));
    const queued = Object.values(d.jobs).filter(
      (j) => j.type === 'invite' && j.video.id === videoId && !isFinal(j.state) && !j.dryRun,
    );
    let room = S.MAX_COLLABORATORS - live.length - queued.length;
    const from = d.channels.find((c) => c.id === active.id) || { id: active.id };
    const batchId = U.uid('batch');
    let count = 0;
    for (const id of targetIds || []) {
      const t = d.channels.find((c) => c.id === id);
      const label = t ? U.channelLong(t) : id;
      if (!t) skipped.push(`${label}: not a saved channel`);
      else if (t.id === active.id) skipped.push(`${label}: that's the channel you're signed in as`);
      else if (!t.handle) skipped.push(`${label}: no handle saved (add it in Options)`);
      else if (live.some((i) => i.to.id === t.id)) skipped.push(`${label}: already invited to this video`);
      else if (liveJobFor(d.jobs, (j) => j.type === 'invite' && j.video.id === videoId && j.target.id === t.id)) skipped.push(`${label}: already queued`);
      else if (!d.settings.dryRun && room <= 0) skipped.push(`${label}: ${U.errorText('LIMIT')}`);
      else {
        const prior = Object.values(d.invites).find((i) => i.videoId === videoId && i.to.id === t.id && i.status === 'failed');
        const job = newJob('invite', {
          batchId,
          tabId,
          video: { id: videoId, title: String(videoTitle || '').slice(0, 300) },
          from: ref(from),
          target: ref(t),
          inviteId: prior ? prior.id : '',
          dryRun: !!d.settings.dryRun,
        });
        d.jobs[job.id] = job;
        count++;
        if (!d.settings.dryRun) room--;
      }
    }
    return { count, skipped, batchId };
  });
  pump();
  return r;
}

/** Retry a failed invite from the Manager / history: opens the video's Details page in its own tab. */
async function retryInvite({ inviteId, tabId }) {
  const { invites } = await S.getAll();
  const inv = invites[inviteId];
  if (!inv) throw new Error('Invite not found.');
  if (inv.status !== 'failed') throw new Error('Only failed invites can be retried.');
  if (tabId != null) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const p = tab && U.parsePageUrl(tab.url || '');
    if (p && p.videoId === inv.videoId) return startInvites({ tabId, targetIds: [inv.to.id], videoId: inv.videoId, videoTitle: inv.videoTitle });
  }
  const r = await tx(['jobs'], (d) => {
    if (liveJobFor(d.jobs, (j) => j.type === 'invite' && j.video.id === inv.videoId && j.target.id === inv.to.id)) {
      throw new Error('That invite is already queued.');
    }
    const job = newJob('invite', {
      batchId: U.uid('batch'),
      tabId: null,
      openVideoTab: true,
      video: { id: inv.videoId, title: inv.videoTitle },
      from: inv.from,
      target: inv.to,
      inviteId: inv.id,
      dryRun: !!d.settings.dryRun,
    });
    d.jobs[job.id] = job;
    return { count: 1, skipped: [] };
  });
  pump();
  return r;
}

function queueForInvites(type, inviteIds, allowed) {
  return tx(['jobs'], (d) => {
    const batchId = U.uid('batch');
    const skipped = [];
    let count = 0;
    for (const id of inviteIds || []) {
      const inv = d.invites[id];
      const label = inv ? `${U.channelLong(inv.to)} on "${inv.videoTitle || inv.videoId}"` : id;
      if (!inv) skipped.push(`${label}: not found`);
      else if (!allowed.includes(inv.status)) skipped.push(`${label}: status is ${inv.status}`);
      else if (type === 'accept' && !inv.link) skipped.push(`${label}: ${U.errorText('NO_LINK')}`);
      else if (type === 'remove' && !U.VIDEO_ID_RE.test(inv.videoId)) skipped.push(`${label}: no video ID saved`);
      else if (liveJobFor(d.jobs, (j) => j.inviteId === id && (j.type === 'accept' || j.type === 'remove'))) skipped.push(`${label}: already queued`);
      else {
        const job = newJob(type, {
          batchId,
          tabId: null,
          inviteId: id,
          video: { id: inv.videoId, title: inv.videoTitle },
          from: inv.from,
          target: inv.to,
          link: type === 'accept' ? inv.link : '',
          dryRun: !!d.settings.dryRun,
        });
        d.jobs[job.id] = job;
        count++;
      }
    }
    return { count, skipped, batchId };
  }).then((r) => {
    pump();
    return r;
  });
}

const startAccepts = ({ inviteIds }) => queueForInvites('accept', inviteIds, ['pending']);
const startRemovals = ({ inviteIds }) => queueForInvites('remove', inviteIds, ['pending', 'accepted']);

/** Record a step. Throws CANCELLED if the job was stopped meanwhile. */
function progress(jobId, step, extra = {}) {
  return tx(['jobs'], (d) => {
    const j = d.jobs[jobId];
    if (!j || isFinal(j.state)) throw new FlowError('CANCELLED', U.errorText('CANCELLED'));
    const now = Date.now();
    Object.assign(j, extra);
    if (step) {
      j.step = step;
      j.log = [...(j.log || []), { t: now, step }].slice(-40);
    }
    j.heartbeatAt = now;
    j.updatedAt = now;
    return { ...j };
  });
}

const activeRuns = new Set(); // jobs whose service-worker part runs in THIS worker instance
let pumping = false;
let pumpAgain = false;

/** Start the oldest queued job if nothing is running. */
async function pump() {
  if (pumping) {
    pumpAgain = true;
    return;
  }
  pumping = true;
  try {
    do {
      pumpAgain = false;
      await reconcile();
      const { jobs } = await S.getAll();
      const list = Object.values(jobs);
      if (list.some((j) => j.state === 'running')) break;
      const next = list.filter((j) => j.state === 'queued').sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!next) break;
      const now = Date.now();
      await tx(['jobs'], (d) => {
        const j = d.jobs[next.id];
        Object.assign(j, { state: 'running', phase: 'sw', startedAt: now, heartbeatAt: now, updatedAt: now, step: 'Starting…' });
      });
      runJob(next.id);
    } while (pumpAgain);
  } finally {
    pumping = false;
    updateBadge();
  }
}

/** Mark running jobs that can no longer finish as interrupted. */
async function reconcile() {
  const { jobs, settings } = await S.getAll();
  const staleMs = settings.stepTimeoutMs * 2 + 30000;
  for (const j of Object.values(jobs)) {
    if (j.state !== 'running') continue;
    let why = null;
    if (j.phase === 'sw' && !activeRuns.has(j.id)) why = 'The extension restarted during the run.';
    else if (Date.now() - (j.heartbeatAt || j.startedAt || 0) > staleMs) why = 'The page stopped responding.';
    else if (j.phase === 'page' && j.tabId != null && !(await tabExists(j.tabId))) why = 'The tab was closed.';
    if (why) await finishJob(j.id, { ok: false, error: { code: 'INTERRUPTED', message: `${U.errorText('INTERRUPTED')} ${why}` } }, { noPump: true });
  }
}

async function runJob(jobId) {
  activeRuns.add(jobId);
  const stop = keepAlive();
  try {
    const { jobs, settings } = await S.getAll();
    const job = jobs[jobId];
    if (!job) return;
    if (job.type === 'invite') await runInvite(job, settings);
    else if (job.type === 'accept') await runAccept(job, settings);
    else if (job.type === 'remove') await runRemove(job, settings);
    else throw new Error(`Unknown job type ${job.type}`);
  } catch (e) {
    if (e.code !== 'CANCELLED' || !(await isJobFinal(jobId))) {
      await finishJob(jobId, { ok: false, error: { code: e.code || 'ERROR', message: e.message || String(e) } });
    }
  } finally {
    stop();
    activeRuns.delete(jobId);
  }
}

const isJobFinal = async (jobId) => {
  const { jobs } = await S.getAll();
  return !jobs[jobId] || isFinal(jobs[jobId].state);
};

/** Hand the job to the content script in its tab. Results come back as job:progress / job:finish. */
async function startFlowInTab(job, settings) {
  const fresh = await progress(job.id, 'Starting on the page…', { phase: 'page', tabId: job.tabId });
  const r = await sendToTab(job.tabId, { type: 'flow:run', job: fresh, settings });
  if (!r || !r.ok) throw new FlowError('ERROR', (r && r.error) || 'The page did not accept the run.');
}

/** The signed-in channel must be `want`; otherwise say which one to switch to. */
async function requireChannel(jobId, want, verb) {
  await progress(jobId, 'Checking which channel is signed in…');
  const active = await detectActiveChannel({ maxAgeMs: 20000, requireProbe: true });
  const { channels } = await S.getAll();
  const known = channels.find((c) => c.id === active.id);
  const matches = want.id ? active.id === want.id : !!(known && U.sameHandle(known.handle, want.handle));
  if (!matches) {
    const now = known ? U.channelLong(known) : `channel ${active.id}`;
    throw new FlowError('WRONG_CHANNEL', `Signed in as ${now}. Switch to ${U.channelLong(want)} and press ${verb} again.`);
  }
  return active;
}

async function runInvite(job, settings) {
  if (job.openVideoTab && job.tabId == null) {
    await requireChannel(job.id, job.from, 'Retry');
    await progress(job.id, "Opening the video's Details page…");
    const tab = await openTab(studioEditUrl(job.video.id), { active: job.dryRun || !settings.backgroundTabs });
    await progress(job.id, null, { tabId: tab.id, ownsTab: true });
    job.tabId = tab.id;
    await waitForStudioVideo(tab.id, job.video.id, settings);
  }
  await progress(job.id, 'Checking the video tab…');
  const tab = await chrome.tabs.get(job.tabId).catch(() => null);
  if (!tab) throw new FlowError('TAB_GONE', "The video's tab is gone. Open the video's Details page and press Retry there.");
  if (!U.parsePageUrl(tab.url || '').kind.startsWith('studio')) {
    throw new FlowError('TAB_GONE', "That tab isn't on YouTube Studio any more. Open the video again and press Retry.");
  }
  const r = await sendToTab(job.tabId, { type: 'page:context' });
  const vid = r && r.context && r.context.videoId;
  if (vid && vid !== job.video.id) {
    throw new FlowError('UNEXPECTED_UI', `That tab now shows a different video (${vid}), so nothing was done.`);
  }
  await startFlowInTab(job, settings);
}

async function runAccept(job, settings) {
  await requireChannel(job.id, job.target, 'Accept');
  if (!U.isAllowedInviteLink(job.link)) throw new FlowError('ERROR', "That link isn't a YouTube link, so it wasn't opened.");
  await progress(job.id, 'Opening the invite link…');
  const tab = await openTab(job.link, { active: job.dryRun || !settings.backgroundTabs });
  await progress(job.id, null, { tabId: tab.id, ownsTab: true });
  job.tabId = tab.id;
  const url = await waitForTab(tab.id, loadedOn(YT_HOSTS), settings.stepTimeoutMs + 15000, 'the invite page to load');
  if (isVerificationUrl(url)) {
    throw new FlowError('NOT_SIGNED_IN', 'Google asked you to sign in or verify. Finish that in the tab, then press Accept again.');
  }
  await startFlowInTab(job, settings);
}

async function runRemove(job, settings) {
  await requireChannel(job.id, job.from, 'Remove');
  await progress(job.id, "Opening the video's Details page…");
  const tab = await openTab(studioEditUrl(job.video.id), { active: job.dryRun || !settings.backgroundTabs });
  await progress(job.id, null, { tabId: tab.id, ownsTab: true });
  job.tabId = tab.id;
  await waitForStudioVideo(tab.id, job.video.id, settings);
  await startFlowInTab(job, settings);
}

const studioEditUrl = (videoId) => `${SEL.urls.studioOrigin}/video/${videoId}/edit`;

async function waitForStudioVideo(tabId, videoId, settings) {
  const url = await waitForTab(tabId, loadedOn(['studio.youtube.com']), settings.stepTimeoutMs + 15000, "the video's Details page to load");
  if (isVerificationUrl(url)) throw new FlowError('NOT_SIGNED_IN', 'Google asked you to sign in or verify. Finish that in the tab, then try again.');
  if (U.parsePageUrl(url).videoId !== videoId) {
    throw new FlowError('UNEXPECTED_UI', "Studio didn't open that video's Details page (is the uploading channel signed in?).");
  }
}

/** Apply a job's outcome to the job and its invite record. */
async function finishJob(jobId, { ok, result = {}, error = null }, { noPump = false } = {}) {
  const job = await tx(['jobs', 'invites'], (d) => {
    const j = d.jobs[jobId];
    if (!j || isFinal(j.state)) return null;
    const now = Date.now();
    const res = sanitizeResult(result);
    let err = ok ? null : { code: String((error && error.code) || 'ERROR').slice(0, 40), message: String((error && error.message) || 'Unknown error').slice(0, 600) };

    // Hard rule: an invite only counts if analytics access was verified on.
    if (ok && !res.dryRun && j.type === 'invite') {
      if (res.analyticsVerified !== true) err = { code: 'ANALYTICS_NOT_ON', message: U.errorText('ANALYTICS_NOT_ON') };
      else if (!U.isAllowedInviteLink(res.link)) err = { code: 'LINK_NOT_FOUND', message: U.errorText('LINK_NOT_FOUND') };
    }
    const success = ok && !err;

    j.updatedAt = now;
    j.finishedAt = now;
    if (success) {
      j.state = 'done';
      j.result = res;
      j.step = res.dryRun ? dryRunSummary(res) : doneText(j);
    } else {
      j.state = err.code === 'CANCELLED' ? 'cancelled' : 'error';
      j.error = err;
      j.step = err.message;
    }
    j.log = [...(j.log || []), { t: now, step: j.step }].slice(-40);

    if (!j.dryRun && !(success && res.dryRun)) applyToInvite(d, j, success, res, err, now);

    if (!success && STOP_BATCH.has(err.code)) {
      for (const other of Object.values(d.jobs)) {
        if (other.batchId === j.batchId && other.state === 'queued') {
          Object.assign(other, {
            state: 'cancelled',
            step: 'Not started: an earlier step in this batch stopped (see above).',
            error: { code: 'CANCELLED', message: 'Not started: an earlier step in this batch stopped.' },
            updatedAt: now,
          });
        }
      }
    }
    return { ...j };
  });
  if (job && job.ownsTab && job.tabId != null) {
    const close = job.state === 'done' ? !job.dryRun : job.error && (job.error.code === 'LINK_NOT_ACTIVE' || !KEEP_TAB.has(job.error.code));
    if (close) chrome.tabs.remove(job.tabId).catch(() => {});
  }
  if (!noPump) pump();
  updateBadge();
  return job;
}

function applyToInvite(d, j, success, res, err, now) {
  const code = err && err.code;
  if (j.type === 'invite') {
    if (!success && (code === 'DISCOVERY_PENDING' || code === 'CANCELLED')) return;
    const inv = (j.inviteId && d.invites[j.inviteId]) || { id: U.uid('inv'), createdAt: now };
    Object.assign(inv, {
      videoId: j.video.id,
      videoTitle: res.videoTitle || j.video.title || inv.videoTitle || '',
      from: j.from,
      to: j.target,
      updatedAt: now,
      note: '',
    });
    if (success) Object.assign(inv, { link: res.link, analytics: true, status: 'pending', error: '', errorCode: '' });
    else Object.assign(inv, { status: 'failed', link: '', analytics: false, error: err.message, errorCode: code });
    d.invites[inv.id] = inv;
    j.inviteId = inv.id;
    return;
  }
  const inv = d.invites[j.inviteId];
  if (!inv || code === 'CANCELLED') return;
  inv.updatedAt = now;
  if (j.type === 'accept') {
    if (success) Object.assign(inv, { status: 'accepted', acceptedAt: now, error: '', errorCode: '', note: '' });
    else if (code === 'LINK_NOT_ACTIVE') Object.assign(inv, { note: `Link not active yet (checked ${new Date(now).toLocaleString()}).`, error: '', errorCode: '' });
    else Object.assign(inv, { error: err.message, errorCode: code });
  } else if (j.type === 'remove') {
    if (success) Object.assign(inv, { status: 'removed', removedAt: now, error: '', errorCode: '', note: '' });
    else Object.assign(inv, { error: `Remove failed: ${err.message}`, errorCode: code });
  }
}

function sanitizeResult(r) {
  const out = {};
  if (!r || typeof r !== 'object') return out;
  if (typeof r.link === 'string') out.link = r.link.slice(0, 500);
  if (r.analyticsVerified === true) out.analyticsVerified = true;
  if (typeof r.videoTitle === 'string') out.videoTitle = r.videoTitle.slice(0, 300);
  if (r.dryRun === true) out.dryRun = true;
  if (typeof r.wouldClick === 'string') out.wouldClick = r.wouldClick.slice(0, 200);
  if (Array.isArray(r.steps)) out.steps = r.steps.slice(0, 30).map((s) => String(s).slice(0, 200));
  return out;
}

const dryRunSummary = (r) =>
  `Dry run finished. Highlighted ${(r.steps || []).length} step(s); next it would click "${r.wouldClick || '?'}". Nothing was changed.`;

function doneText(j) {
  if (j.type === 'invite') return `Invite link created for ${U.channelLong(j.target)}.`;
  if (j.type === 'accept') return `Accepted on ${U.channelLong(j.target)}.`;
  return `Removed ${U.channelLong(j.target)} from the video.`;
}

async function cancelJob({ jobId }) {
  const { jobs } = await S.getAll();
  const j = jobs[jobId];
  if (!j || isFinal(j.state)) return {};
  if (j.state === 'running' && j.phase === 'page' && j.tabId != null) {
    const r = await chrome.tabs.sendMessage(j.tabId, { type: 'flow:cancel', jobId }, { frameId: 0 }).catch(() => null);
    if (r && r.cancelled) return {}; // the page reports CANCELLED itself
  }
  await finishJob(jobId, { ok: false, error: { code: 'CANCELLED', message: U.errorText('CANCELLED') } });
  return {};
}

async function cancelAll() {
  const { jobs } = await S.getAll();
  for (const j of Object.values(jobs)) if (!isFinal(j.state)) await cancelJob({ jobId: j.id });
  return {};
}

/** Queue the same work again. */
async function retryJob({ jobId, tabId }) {
  const { jobs } = await S.getAll();
  const j = jobs[jobId];
  if (!j || !isFinal(j.state)) throw new Error('Only finished jobs can be retried.');
  if (j.type === 'invite') {
    if (tabId != null) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab && U.parsePageUrl(tab.url || '').videoId === j.video.id) {
        return startInvites({ tabId, targetIds: [j.target.id], videoId: j.video.id, videoTitle: j.video.title });
      }
    }
    if (j.tabId != null && (await tabExists(j.tabId)) && !j.ownsTab) {
      return startInvites({ tabId: j.tabId, targetIds: [j.target.id], videoId: j.video.id, videoTitle: j.video.title });
    }
    if (j.inviteId) return retryInvite({ inviteId: j.inviteId });
    throw new Error("Open the video's Details page in Studio and press Retry from the popup there.");
  }
  return queueForInvites(j.type, [j.inviteId], j.type === 'accept' ? ['pending'] : ['pending', 'accepted']);
}

function clearFinishedJobs() {
  return tx(['jobs'], (d) => {
    for (const j of Object.values(d.jobs)) if (isFinal(j.state)) delete d.jobs[j.id];
    return {};
  });
}

/** Local only: forget invite records. Never touches YouTube. */
function forgetInvites({ inviteIds }) {
  return tx(['invites'], (d) => {
    let removed = 0;
    for (const id of inviteIds || []) {
      if (liveJobFor(d.jobs, (j) => j.inviteId === id)) throw new Error('One of those invites has a run in progress. Stop it first.');
      if (d.invites[id]) {
        delete d.invites[id];
        removed++;
      }
    }
    return { removed };
  });
}

// =====================================================================
// Hand-off codes and import
// =====================================================================

async function exportCode({ kind }) {
  const { invites, channels } = await S.getAll();
  let list = Object.values(invites);
  const monthAgo = Date.now() - 30 * 864e5;
  if (kind === 'pending') list = list.filter((i) => i.status === 'pending' && i.link);
  else list = list.filter((i) => (i.status === 'accepted' || i.status === 'removed') && (i.updatedAt || 0) > monthAgo);
  if (!list.length) {
    throw new Error(kind === 'pending' ? 'No pending invites with links to hand off.' : 'No accepted invites from the last 30 days to send back.');
  }
  const code = await S.encodeCode({ v: 1, app: 'ytcollab', kind, createdAt: Date.now(), channels, invites: list });
  return { code, count: list.length };
}

async function importCode({ text }) {
  const data = await S.decodeCode(text);
  return tx(['channels', 'invites'], (d) => {
    const c = S.mergeChannels(d.channels, data.channels);
    const i = S.mergeInvites(d.invites, data.invites);
    d.channels = c.channels;
    d.invites = i.invites;
    return { channelsAdded: c.added, channelsUpdated: c.updated, invitesAdded: i.added, invitesUpdated: i.updated };
  });
}

// =====================================================================
// Recorder storage
// =====================================================================

const RS = SEL.recorder;

function appendRecEvent(ev, sender) {
  return locked(async () => {
    const d = await chrome.storage.local.get(['recIndex', 'recorder']);
    const rec = d.recorder || { on: false };
    if (!rec.on && ev.kind !== 'snapshot' && ev.kind !== 'note') return { ignored: true };
    const idx = d.recIndex || { seq: 0, chars: 0, count: 0 };
    if (sender && sender.tab) {
      ev.tabId = sender.tab.id;
      ev.frameId = sender.frameId;
    }
    const json = JSON.stringify(ev);
    if (idx.count >= RS.maxEvents || idx.chars + json.length > RS.maxTotalChars) {
      await chrome.storage.local.set({ recorder: { ...rec, on: false, stoppedReason: 'The recording is full. Copy or download it, then clear it.' } });
      updateBadge();
      return { full: true };
    }
    idx.seq++;
    idx.count++;
    idx.chars += json.length;
    ev.seq = idx.seq;
    await chrome.storage.local.set({ ['rec:' + String(idx.seq).padStart(6, '0')]: ev, recIndex: idx });
    return {};
  });
}

// Runs in the page (MAIN world) while recording: report what "Copy" buttons write.
function clipboardHook() {
  if (window.__ytcClipboardHook) return;
  window.__ytcClipboardHook = true;
  const post = (text, how) => {
    try {
      window.postMessage({ __ytcRecorder: 'clipboard', text: String(text).slice(0, 1000), how }, location.origin);
    } catch {}
  };
  const cb = navigator.clipboard;
  if (cb && typeof cb.writeText === 'function') {
    const orig = cb.writeText.bind(cb);
    cb.writeText = (t) => {
      post(t, 'navigator.clipboard.writeText');
      return orig(t);
    };
  }
  if (cb && typeof cb.write === 'function') {
    const orig = cb.write.bind(cb);
    cb.write = (items) => {
      post(`[clipboard.write with ${(items && items.length) || 0} item(s)]`, 'navigator.clipboard.write');
      return orig(items);
    };
  }
}

// Runs in the page (MAIN world) while recording: what the page itself knows
// about the channel and language (for choosing detection hooks). No tokens.
function pageProbe(metaPath) {
  const out = { url: location.href, lang: document.documentElement.lang || '' };
  try {
    const cfg = window.ytcfg && window.ytcfg.data_;
    if (cfg && typeof cfg === 'object') {
      out.ytcfg = {};
      for (const k of Object.keys(cfg)) {
        if (!/CHANNEL|DELEGATED|PAGE_ID|HANDLE|^HL$|^GL$|LOCALE/i.test(k) || /TOKEN|KEY|SECRET|XSRF|SAPISID/i.test(k)) continue;
        const v = cfg[k];
        out.ytcfg[k] = typeof v === 'string' && (/^UC[\w-]{22}$/.test(v) || /^@/.test(v) || v.length <= 12) ? v : typeof v;
      }
    }
  } catch {}
  try {
    let o = window;
    for (const k of metaPath) o = o == null ? o : o[k];
    if (o && typeof o === 'object') out.channelMetadata = { title: o.title, externalId: o.externalId, vanityChannelUrl: o.vanityChannelUrl };
  } catch {}
  return out;
}

async function injectRecorderHooks(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'MAIN', func: clipboardHook });
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: pageProbe, args: [SEL.channelPage.metadataPath] });
    if (res && res.result) {
      await appendRecEvent({ kind: 'probe', t: Date.now(), url: res.result.url, frame: 'top', probe: res.result }, { tab: { id: tabId }, frameId: 0 });
    }
  } catch {}
}

async function setRecorder({ on }) {
  await tx(['recorder'], (d) => {
    d.recorder = on ? { on: true, startedAt: Date.now() } : { ...d.recorder, on: false, stoppedReason: '' };
  });
  if (on) {
    const tabs = await chrome.tabs.query({ url: YT_HOSTS.map((h) => `https://${h}/*`) });
    for (const t of tabs) {
      try {
        await ensureInjected(t.id);
        await injectRecorderHooks(t.id);
      } catch {}
    }
  }
  updateBadge();
  return {};
}

async function clearRecording() {
  await locked(async () => {
    const all = await chrome.storage.local.get(null);
    await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('rec:')));
    await chrome.storage.local.set({ recIndex: { seq: 0, chars: 0, count: 0 } });
  });
  return {};
}

async function snapshotPage({ tabId }) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !isYouTubeUrl(tab.url || '')) throw new Error('Open a YouTube or Studio page first.');
  const r = await sendToTab(tabId, { type: 'rec:snapshotPage' });
  return { chars: r.chars, truncated: r.truncated, dialogs: r.dialogs };
}

// =====================================================================
// Badge
// =====================================================================

async function updateBadge() {
  try {
    const { jobs, recorder } = await S.getAll();
    const live = Object.values(jobs).filter((j) => !isFinal(j.state)).length;
    if (recorder.on) {
      await chrome.action.setBadgeBackgroundColor({ color: '#cc0000' });
      await chrome.action.setBadgeText({ text: 'REC' });
    } else if (live) {
      await chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });
      await chrome.action.setBadgeText({ text: String(live) });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }
  } catch {}
}

// =====================================================================
// Messages
// =====================================================================

// From extension pages (popup, Manager, options).
const PAGE_HANDLERS = {
  wake: async () => {
    await pump();
    return {};
  },
  context: getContext,
  activeChannel: async ({ tabId, maxAgeMs }) => ({ active: await detectActiveChannel({ tabId, maxAgeMs }) }),
  'channels:saveCurrent': saveCurrentChannel,
  'channels:add': addChannel,
  'channels:update': updateChannel,
  'channels:remove': removeChannel,
  'channels:reorder': reorderChannels,
  'settings:set': setSettings,
  'invite:start': startInvites,
  'invite:retry': retryInvite,
  'accept:start': startAccepts,
  'remove:start': startRemovals,
  'job:cancel': cancelJob,
  'job:cancelAll': cancelAll,
  'job:retry': retryJob,
  'jobs:clearFinished': clearFinishedJobs,
  'invites:forget': forgetInvites,
  'handoff:export': exportCode,
  import: importCode,
  'recorder:set': setRecorder,
  'recorder:note': ({ text }) => appendRecEvent({ kind: 'note', t: Date.now(), url: '', text: String(text || '').slice(0, 1000) }),
  'recorder:snapshot': snapshotPage,
  'recorder:clear': clearRecording,
  'open:video': async ({ videoId }) => {
    if (!U.VIDEO_ID_RE.test(videoId || '')) throw new Error('No video ID.');
    await chrome.tabs.create({ url: studioEditUrl(videoId) });
    return {};
  },
};

// From content scripts.
const CONTENT_HANDLERS = {
  'rec:event': ({ event }, sender) => (event && typeof event === 'object' ? appendRecEvent(event, sender) : {}),
  'job:progress': async ({ jobId, step }, sender) => {
    if (!(await isJobTab(jobId, sender))) return { ignored: true };
    await progress(jobId, String(step || '').slice(0, 300)).catch(() => {});
    return {};
  },
  'job:finish': async ({ jobId, ok, result, error }, sender) => {
    if (!(await isJobTab(jobId, sender))) return { ignored: true };
    await finishJob(jobId, { ok: !!ok, result, error });
    return {};
  },
};

async function isJobTab(jobId, sender) {
  const { jobs } = await S.getAll();
  const j = jobs[jobId];
  return !!(j && sender.tab && j.tabId === sender.tab.id && sender.frameId === 0);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  const fromPage = sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(EXT_ORIGIN);
  const handler = fromPage ? PAGE_HANDLERS[msg.type] : sender.tab ? CONTENT_HANDLERS[msg.type] : null;
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(
      (r) => sendResponse({ ok: true, ...(r || {}) }),
      (e) => sendResponse({ ok: false, error: (e && e.message) || String(e), code: (e && e.code) || '' }),
    );
  return true;
});

// =====================================================================
// Tab events
// =====================================================================

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { jobs } = await S.getAll();
  for (const j of Object.values(jobs)) {
    if (j.state === 'running' && j.phase === 'page' && j.tabId === tabId) {
      await finishJob(j.id, { ok: false, error: { code: 'TAB_GONE', message: U.errorText('TAB_GONE') } });
    }
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status === 'loading') {
    // A reload or navigation away kills the page's part of a run. Studio's
    // in-app navigation keeps it, so ask the page before calling it.
    const { jobs } = await S.getAll();
    const j = Object.values(jobs).find((x) => x.state === 'running' && x.phase === 'page' && x.tabId === tabId);
    if (j) {
      setTimeout(async () => {
        const r = await chrome.tabs.sendMessage(tabId, { type: 'ping' }, { frameId: 0 }).catch(() => null);
        if (!r || !r.running) {
          await finishJob(j.id, { ok: false, error: { code: 'INTERRUPTED', message: `${U.errorText('INTERRUPTED')} The page reloaded or navigated away.` } });
        }
      }, 3000);
    }
  }
  if (info.status === 'complete' && isYouTubeUrl(tab.url || '')) {
    const { recorder } = await chrome.storage.local.get('recorder');
    if (recorder && recorder.on) injectRecorderHooks(tabId);
  }
});

chrome.runtime.onInstalled.addListener(() => updateBadge());
chrome.runtime.onStartup.addListener(() => pump());

// Every time the worker starts: pick up where it left off.
pump();
