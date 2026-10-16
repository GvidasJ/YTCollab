/*
 * The invite and accept flows, run inside the Studio / YouTube tab.
 *
 * The service worker starts a run with a `flow:run` message; the flow reports
 * every step back (`job:progress`) and ends with `job:finish`. Progress lives
 * in chrome.storage via the service worker, so the popup can close and reopen
 * at any time.
 *
 * Action classes (used by dry run):
 *   safe   – opens or reveals UI (expanding a section, opening the invite
 *            dialog, typing the search). Dry run highlights AND performs it so
 *            the following steps can be shown.
 *   commit – anything that creates, changes or accepts something. Dry run only
 *            highlights it (dashed orange) and stops.
 * FLOW.md lists which step is which.
 */
(function () {
  const YTC = (globalThis.YTC = globalThis.YTC || {});
  if (YTC.flows) return;
  const D = YTC.dom;
  const U = YTC.util;
  const SEL = YTC.SEL;
  const { FlowError } = U;

  const F = (YTC.flows = {});
  const running = new Map(); // jobId -> AbortController

  function report(type, payload) {
    try {
      return chrome.runtime.sendMessage({ type, ...payload }).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  /** Thrown when a dry run reaches its first commit action. */
  class DryRunStop extends Error {}

  function makeCtx(job, settings, signal) {
    let n = 0;
    const ctx = {
      job,
      settings,
      signal,
      dryRun: !!job.dryRun,
      highlights: [],

      /** Fail with DISCOVERY_PENDING unless every listed selector has been filled in. */
      require(section, keys) {
        const missing = keys.filter((k) => !SEL[section] || SEL[section][k] == null);
        if (missing.length) {
          throw new FlowError(
            'DISCOVERY_PENDING',
            `${U.errorText('DISCOVERY_PENDING')} Missing in selectors.js → ${section}: ${missing.join(', ')}.`,
          );
        }
      },

      sel(section, key) {
        const v = SEL[section] && SEL[section][key];
        if (v == null) throw new FlowError('DISCOVERY_PENDING', `selectors.js → ${section}.${key} is not filled in yet.`);
        return v;
      },

      /** Announce a step (shown live in the popup and in a banner on the page). */
      async step(text) {
        if (signal.aborted) throw new FlowError('CANCELLED', U.errorText('CANCELLED'));
        D.banner(`YT Collab${ctx.dryRun ? ' (dry run)' : ''}: ${text}`);
        await report('job:progress', { jobId: job.id, step: text });
      },

      /** The small pause between actions. */
      pause: () => D.delay(settings.stepDelayMs),

      waitFor: (finder, what) => D.waitFor(finder, { timeout: settings.stepTimeoutMs, what, signal }),

      /** Highlight, then click unless this is a commit action during a dry run. */
      async act(el, label, { commit = false } = {}) {
        n++;
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        D.highlight(el, `${n}. ${label}${commit && ctx.dryRun ? ' (would click)' : ''}`, { commit });
        ctx.highlights.push(label);
        await ctx.pause();
        if (ctx.dryRun && commit) throw new DryRunStop(label);
        if (signal.aborted) throw new FlowError('CANCELLED', U.errorText('CANCELLED'));
        D.click(el, label);
        await ctx.pause();
      },
    };
    return ctx;
  }

  // -------------------------------------------------------------------
  // INVITE: runs on the video's Details page or in the upload dialog.
  // job = { id, type: 'invite', video: {id, title}, target: {id, handle, name}, dryRun }
  // Resolves with { link, analyticsVerified: true, videoTitle }.
  // -------------------------------------------------------------------
  F.invite = async (ctx) => {
    ctx.require('invite', [
      'showMoreButton',
      'inviteButton',
      'inviteDialog',
      'searchInput',
      'searchResult',
      'analyticsOption',
      'analyticsState',
      'createLinkButton',
      'linkField',
    ]);
    // The step-by-step body is written from the discovery recording
    // (FLOW.md). Until then require() above stops the run before anything
    // is clicked.
    throw new FlowError('DISCOVERY_PENDING', U.errorText('DISCOVERY_PENDING'));
  };

  // -------------------------------------------------------------------
  // ACCEPT: runs in the tab the service worker opened on the invite link,
  // after it has confirmed the right channel is signed in.
  // job = { id, type: 'accept', inviteId, target: {id, handle, name}, link, dryRun }
  // Resolves with { accepted: true }.
  // -------------------------------------------------------------------
  F.accept = async (ctx) => {
    ctx.require('accept', ['root', 'acceptButton', 'successMarker', 'notActiveMarker']);
    throw new FlowError('DISCOVERY_PENDING', U.errorText('DISCOVERY_PENDING'));
  };

  // -------------------------------------------------------------------
  // REMOVE: runs on the video's Details page (opened by the service worker
  // after it confirmed the uploading channel is signed in). Takes ONE
  // collaborator off the video; touches nothing else.
  // job = { id, type: 'remove', inviteId, video: {id, title}, target: {id, handle, name}, dryRun }
  // Resolves with { removed: true }.
  // -------------------------------------------------------------------
  F.remove = async (ctx) => {
    ctx.require('invite', ['showMoreButton', 'collaborationSection', 'collaboratorRow']);
    ctx.require('remove', ['removeButton']);
    throw new FlowError('DISCOVERY_PENDING', U.errorText('DISCOVERY_PENDING'));
  };

  // -------------------------------------------------------------------
  // Runner
  // -------------------------------------------------------------------

  F.run = async (job, settings) => {
    if (running.size) throw new Error('Another run is already in progress in this tab.');
    const ac = new AbortController();
    running.set(job.id, ac);
    const ctx = makeCtx(job, settings, ac.signal);
    let outcome;
    try {
      const flow = F[job.type];
      if (!flow) throw new Error(`Unknown job type ${job.type}`);
      const result = await flow(ctx);
      outcome = { ok: true, result: result || {} };
    } catch (e) {
      if (e instanceof DryRunStop) {
        outcome = {
          ok: true,
          result: { dryRun: true, wouldClick: e.message, steps: ctx.highlights },
        };
      } else {
        outcome = {
          ok: false,
          error: { code: e.code || 'ERROR', message: e.message || String(e) },
          steps: ctx.highlights,
        };
      }
    } finally {
      running.delete(job.id);
      D.banner(null);
    }
    await report('job:finish', { jobId: job.id, ...outcome });
    return outcome;
  };

  F.cancel = (jobId) => {
    const ac = running.get(jobId);
    if (ac) ac.abort();
    return !!ac;
  };

  F.isRunning = () => running.size > 0;
})();
