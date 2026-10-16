/*
 * Content-script message handler (top frame only): page context for the
 * popup, starting / cancelling flow runs, and whole-page snapshots for the
 * recorder.
 */
(function () {
  const YTC = (globalThis.YTC = globalThis.YTC || {});
  if (YTC.agent || window.top !== window) return;
  const D = YTC.dom;
  const U = YTC.util;
  const SEL = YTC.SEL;
  YTC.agent = true;

  /** What's open in this tab: video ID / title and whether the upload dialog is showing. Read-only. */
  function pageContext() {
    const parsed = U.parsePageUrl(location.href);
    const out = { url: location.href, kind: parsed.kind, videoId: parsed.videoId || '', channelId: parsed.channelId || '' };

    const dialog = SEL.context.uploadDialog ? D.visible(SEL.context.uploadDialog) : null;
    out.uploadDialogOpen = !!dialog;
    if (dialog) {
      out.kind = 'studio-upload';
      if (!out.videoId && SEL.context.uploadVideoLink) {
        for (const a of D.queryAll(SEL.context.uploadVideoLink, dialog)) {
          const m = (a.getAttribute('href') || a.textContent || '').match(SEL.context.videoIdFromLink);
          if (m) {
            out.videoId = m[1];
            break;
          }
        }
      }
    }

    if (SEL.context.videoTitle) {
      const t = D.visible(SEL.context.videoTitle, dialog || document);
      if (t) out.videoTitle = (t.innerText || t.value || t.textContent || '').trim().slice(0, 300);
    }
    return out;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg && msg.type) {
      case 'ping':
        sendResponse({ ok: true, running: YTC.flows.isRunning() });
        return false;
      case 'page:context':
        sendResponse({ ok: true, context: pageContext() });
        return false;
      case 'flow:run':
        // Acknowledge at once; progress and the result come back as messages.
        YTC.flows.run(msg.job, msg.settings).catch(() => {});
        sendResponse({ ok: true });
        return false;
      case 'flow:cancel':
        sendResponse({ ok: true, cancelled: YTC.flows.cancel(msg.jobId) });
        return false;
      case 'rec:snapshotPage':
        sendResponse({ ok: true, ...YTC.recorder.snapshotPage() });
        return false;
      default:
        return false;
    }
  });
})();
