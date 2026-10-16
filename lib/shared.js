/*
 * Small helpers shared by the service worker, popup, options page and
 * content scripts. Classic script: everything hangs off globalThis.YTC.
 */
(function () {
  const YTC = (globalThis.YTC = globalThis.YTC || {});
  if (YTC.util) return;

  const U = (YTC.util = {});

  U.CHANNEL_ID_RE = /^UC[\w-]{22}$/;
  U.VIDEO_ID_RE = /^[\w-]{11}$/;
  // YouTube handles: 3–30 chars of letters, digits, underscore, hyphen, period.
  U.HANDLE_RE = /^@[\p{L}\p{M}\p{N}._-]{3,30}$/u;

  U.now = () => Date.now();

  U.uid = (prefix) =>
    `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  /** "foo" / "@foo" / " @Foo " -> "@Foo" (or "" if empty). */
  U.normHandle = (h) => {
    const s = String(h || '').trim();
    if (!s) return '';
    return s.startsWith('@') ? s : `@${s}`;
  };

  /** Handles are case-insensitive on YouTube. */
  U.sameHandle = (a, b) => {
    const x = U.normHandle(a).toLowerCase();
    return !!x && x === U.normHandle(b).toLowerCase();
  };

  /** Collapse whitespace and lowercase, for text matching. */
  U.normText = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  U.channelLabel = (ch) => {
    if (!ch) return 'unknown channel';
    return ch.label || ch.name || ch.handle || ch.id || 'unknown channel';
  };

  U.channelLong = (ch) => {
    if (!ch) return 'unknown channel';
    const label = U.channelLabel(ch);
    return ch.handle && ch.handle !== label ? `${label} (${ch.handle})` : label;
  };

  U.timeAgo = (ts) => {
    if (!ts) return '';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24);
    if (d < 30) return `${d} d ago`;
    return new Date(ts).toLocaleDateString();
  };

  U.escapeHtml = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /** Is this an https link on one of the allowed invite-link hosts? */
  U.isAllowedInviteLink = (link) => {
    try {
      const u = new URL(link);
      const hosts = (YTC.SEL && YTC.SEL.urls.inviteLinkHosts) || [];
      if (u.protocol !== 'https:' || !hosts.includes(u.hostname)) return false;
      const pattern = YTC.SEL && YTC.SEL.urls.inviteLinkPattern;
      return pattern ? pattern.test(link) : true;
    } catch {
      return false;
    }
  };

  /** Parse a Studio / YouTube URL into what the extension cares about. */
  U.parsePageUrl = (href) => {
    const out = { kind: 'other', url: href || '' };
    let u;
    try {
      u = new URL(href);
    } catch {
      return out;
    }
    const S = YTC.SEL.urls;
    if (u.origin === S.studioOrigin) {
      out.kind = 'studio';
      const ch = u.pathname.match(S.studioChannelPath);
      if (ch) out.channelId = ch[1];
      const vid = u.pathname.match(S.studioVideoEditPath);
      if (vid) {
        out.kind = 'studio-video';
        out.videoId = vid[1];
      } else if (u.searchParams.get(S.uploadDialogParam) === S.uploadDialogValue) {
        out.kind = 'studio-upload';
        const v = u.searchParams.get(S.uploadVideoIdParam);
        if (v && U.VIDEO_ID_RE.test(v)) out.videoId = v;
      }
    } else if (u.hostname.endsWith('youtube.com')) {
      out.kind = 'youtube';
    }
    return out;
  };

  /** Error with a stable code and a plain-English message. */
  class FlowError extends Error {
    constructor(code, message, extra) {
      super(message);
      this.name = 'FlowError';
      this.code = code;
      if (extra) this.extra = extra;
    }
  }
  U.FlowError = FlowError;

  /** Plain-English text for error codes the UI might show. */
  U.ERROR_TEXT = {
    DISCOVERY_PENDING:
      "This flow hasn't been mapped to your Studio yet. Run the recorder (see FLOW.md) and send the recording so the selectors can be filled in.",
    HANDLE_NOT_FOUND: 'Handle not found in the collaborator search.',
    AMBIGUOUS_RESULT: 'Several results look similar and none matches the channel ID or exact handle, so nothing was picked.',
    ANALYTICS_NOT_FOUND: 'Analytics option not found, so no link was created.',
    ANALYTICS_NOT_ON: "Couldn't confirm analytics access is on, so no link was created.",
    LINK_NOT_FOUND: 'The link was created but could not be read from the page.',
    UNEXPECTED_UI: 'Something unexpected appeared on the page, so the run stopped.',
    WRONG_CHANNEL: 'A different channel is signed in.',
    LINK_NOT_ACTIVE: "The link isn't active yet (the upload probably hasn't finished). The invite stays pending.",
    NOT_SIGNED_IN: 'Not signed in to YouTube in this profile.',
    TAB_GONE: 'The tab was closed or reloaded while the run was in progress.',
    INTERRUPTED: 'The run was interrupted (tab closed, reloaded or stopped responding).',
    TIMEOUT: 'Timed out waiting for the page.',
    CANCELLED: 'Stopped.',
    NO_VIDEO: 'Open a video\'s Details page or the upload dialog first.',
    LIMIT: 'YouTube allows at most 10 collaborators per video.',
    COLLABORATOR_NOT_FOUND: "That channel isn't listed as a collaborator on this video, so nothing was removed.",
    REMOVE_NOT_CONFIRMED: "Studio didn't confirm the removal. Check the video's Collaboration section.",
    SAVE_REQUIRED: "Studio wants its Save button pressed for this change. The extension never presses Save on its own; see FLOW.md.",
    NO_LINK: 'This invite has no link saved.',
  };

  U.errorText = (code, fallback) => U.ERROR_TEXT[code] || fallback || code || 'Unknown error';
})();
