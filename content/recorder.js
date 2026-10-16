/*
 * Recorder (discovery mode).
 *
 * While it's on, every click, keypress and typed text on studio.youtube.com /
 * www.youtube.com is logged with the element's tag, id, aria-label, role,
 * text and a stable selector, plus HTML snapshots of the clicked element's
 * surroundings (before the click) and of every open dialog (after the page
 * settles). Snapshots include shadow-root contents, marked <#shadow-root>,
 * and live state the HTML doesn't show (data-rec-checked, data-rec-value).
 *
 * Events go to the service worker, which stores them; the popup copies them
 * as one JSON file. Only real (trusted) user events are recorded, so the
 * extension's own automated clicks never end up in a recording.
 */
(function () {
  const YTC = (globalThis.YTC = globalThis.YTC || {});
  if (YTC.recorder) return;
  const D = YTC.dom;
  const U = YTC.util;
  const SEL = YTC.SEL;
  const RS = SEL.recorder;
  const R = (YTC.recorder = {});

  const isTop = window.top === window;
  const DROP = new Set(RS.dropTags);
  const EMPTY = new Set(RS.emptyTags);
  const KNOWN_ATTRS = new Set([
    'id', 'class', 'style', 'role', 'aria-label', 'aria-checked', 'aria-expanded', 'aria-selected',
    'aria-disabled', 'aria-pressed', 'name', 'type', 'title', 'placeholder', 'href', 'checked', 'disabled',
  ]);

  let on = false;
  let lastPointerAt = 0;
  let lastUrl = location.href;
  let urlTimer = 0;
  let badge = null;
  const inputTimers = new WeakMap();
  const dialogHashes = new WeakMap();

  // ---------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------

  const alive = () => {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  };

  function send(event) {
    if (!alive()) return stop();
    event.t = Date.now();
    event.url = location.href;
    event.frame = isTop ? 'top' : 'subframe';
    chrome.runtime.sendMessage({ type: 'rec:event', event }).catch(() => {});
  }

  // ---------------------------------------------------------------------
  // Describing elements
  // ---------------------------------------------------------------------

  const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
  const textOf = (el) => clip((el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(), 160);

  function short(el) {
    let s = el.localName;
    if (el.id) s += '#' + el.id;
    const role = el.getAttribute('role');
    if (role) s += `[role=${role}]`;
    const al = el.getAttribute('aria-label');
    if (al) s += `[aria-label="${clip(al, 40)}"]`;
    if (el.getRootNode() instanceof ShadowRoot) s += ' (in shadow root)';
    return s;
  }

  const looksGenerated = (id) => /\d{4,}|^[a-f0-9-]{16,}$/i.test(id);

  function segment(el, isTarget) {
    const tag = el.localName;
    if (el.id && !looksGenerated(el.id)) return { s: `${tag}#${CSS.escape(el.id)}`, id: true };
    let s = tag;
    const al = el.getAttribute('aria-label');
    if (al && al.length <= 80) s += `[aria-label="${al.replace(/["\\]/g, '\\$&')}"]`;
    const role = el.getAttribute('role');
    if (role) s += `[role="${role}"]`;
    const distinctive = isTarget || tag.includes('-') || s !== tag;
    return { s: distinctive ? s : null, id: false };
  }

  /**
   * A readable, stable-ish selector: custom tags, ids, aria-labels and roles,
   * walking up until an id that is unique in its root. " >>> " marks a
   * shadow-root boundary (left side = host).
   */
  function stableSelector(el) {
    const parts = [];
    let n = el;
    let root = el.getRootNode();
    let first = true;
    while (n && n.nodeType === 1 && parts.length < 8) {
      const seg = segment(n, first);
      first = false;
      if (seg.s) parts.unshift(seg.s);
      if (seg.id) {
        try {
          if (root.querySelectorAll('#' + CSS.escape(n.id)).length === 1) break;
        } catch {}
      }
      if (n.parentElement) n = n.parentElement;
      else if (n.parentNode instanceof ShadowRoot) {
        parts.unshift('>>>');
        n = n.parentNode.host;
        root = n.getRootNode();
      } else break;
    }
    while (parts[0] === '>>>') parts.shift();
    const selector = parts.join(' ');
    let matches = null;
    if (!selector.includes('>>>')) {
      try {
        matches = el.getRootNode().querySelectorAll(selector).length;
      } catch {}
    }
    return { selector, matches };
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) return null;
    const d = { tag: el.localName };
    const a = (name) => el.getAttribute(name);
    if (el.id) d.id = el.id;
    const map = [
      ['role', 'role'], ['ariaLabel', 'aria-label'], ['ariaChecked', 'aria-checked'], ['ariaExpanded', 'aria-expanded'],
      ['ariaSelected', 'aria-selected'], ['ariaDisabled', 'aria-disabled'], ['ariaPressed', 'aria-pressed'],
      ['name', 'name'], ['type', 'type'], ['title', 'title'], ['placeholder', 'placeholder'], ['href', 'href'],
    ];
    for (const [k, n] of map) {
      const v = a(n);
      if (v != null && v !== '') d[k] = clip(v, 200);
    }
    if (el.hasAttribute('checked')) d.checkedAttr = a('checked');
    if (el.hasAttribute('disabled')) d.disabledAttr = true;
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) d.checked = el.checked;
    else if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value) d.value = clip(el.value, 300);
    const state = D.readChecked(el);
    if (state !== null) d.checkedState = state;
    const text = textOf(el);
    if (text) d.text = text;
    if (typeof el.className === 'string' && el.className) d.classes = clip(el.className, 160); // reference only, never used as a hook
    const extra = {};
    let count = 0;
    for (const at of el.attributes) {
      if (KNOWN_ATTRS.has(at.name) || count >= 20) continue;
      extra[at.name] = clip(at.value, 120);
      count++;
    }
    if (count) d.attrs = extra;
    const root = el.getRootNode();
    if (root instanceof ShadowRoot) d.shadowHost = root.host.localName;
    d.visible = D.isVisible(el);
    const sel = stableSelector(el);
    d.selector = sel.selector;
    if (sel.matches !== null) d.selectorMatches = sel.matches;
    return d;
  }

  const pathOf = (e) =>
    e.composedPath().filter((n) => n.nodeType === 1).slice(0, 20).map(short);

  // ---------------------------------------------------------------------
  // Snapshots
  // ---------------------------------------------------------------------

  /** Hidden for snapshot purposes: no box or visibility:hidden. Opacity is ignored (dialogs animate in). */
  function hiddenForSnapshot(el) {
    if (typeof el.checkVisibility !== 'function') return false;
    if (el.checkVisibility({ checkVisibilityCSS: true })) return false;
    return getComputedStyle(el).display !== 'contents';
  }

  /** HTML of `rootEl` including shadow roots, with hidden subtrees and noise left out. */
  function serialize(rootEl, maxChars) {
    const out = [];
    let size = 0;
    let truncated = false;
    let shadowRoots = 0;
    let hiddenPruned = 0;
    let elements = 0;
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escA = (s) => esc(s).replace(/"/g, '&quot;');
    const push = (s) => {
      if (truncated) return;
      if (size + s.length > maxChars) {
        truncated = true;
        out.push('<!-- truncated: size limit -->');
        return;
      }
      out.push(s);
      size += s.length;
    };
    const open = (el, hidden) => {
      let s = '<' + el.localName;
      for (const at of el.attributes) {
        if (at.name === 'style' && at.value.length > 100) continue;
        const v = clip(at.value, 200);
        s += ' ' + at.name + (v === '' ? '' : `="${escA(v)}"`);
      }
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) s += ` data-rec-checked="${el.checked}"`;
      else if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value) s += ` data-rec-value="${escA(clip(el.value, 300))}"`;
      if (hidden) s += ' data-rec-hidden';
      return s + '>';
    };
    const walkShadow = (el) => {
      const sr = D.shadowOf(el);
      if (!sr) return;
      shadowRoots++;
      push('<#shadow-root>');
      walk(sr);
      push('</#shadow-root>');
    };
    const walk = (parent) => {
      for (const c of parent.childNodes) {
        if (truncated) return;
        if (c.nodeType === 3) {
          const t = c.data.replace(/\s+/g, ' ');
          if (t.trim()) push(esc(clip(t, 300)));
          continue;
        }
        if (c.nodeType !== 1 || DROP.has(c.localName) || D.isOwnOverlay(c)) continue;
        elements++;
        if (EMPTY.has(c.localName)) {
          push(open(c, false) + `</${c.localName}>`);
          continue;
        }
        const hidden = hiddenForSnapshot(c);
        push(open(c, hidden));
        if (hidden) {
          const n = c.getElementsByTagName('*').length;
          if (n) {
            hiddenPruned += n;
            push(`<!-- hidden: ${n} elements -->`);
          }
        } else {
          walkShadow(c);
          walk(c);
        }
        push(`</${c.localName}>`);
      }
    };
    push(open(rootEl, false));
    walkShadow(rootEl);
    walk(rootEl);
    push(`</${rootEl.localName}>`);
    return { html: out.join(''), chars: size, truncated, shadowRoots, hiddenPruned, elements };
  }

  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  }

  /** Grow from the clicked element up to the biggest ancestor under the element cap. */
  function neighborhood(el) {
    let best = el;
    for (let n = D.parentOf(el); n && n !== document.documentElement && n !== document.body; n = D.parentOf(n)) {
      if (n.getElementsByTagName('*').length > RS.neighborhoodMaxElements) break;
      best = n;
    }
    return best;
  }

  /** Visible dialogs / popups. A wrapper and its near-identical child count once. */
  function openDialogs() {
    const sel = [...SEL.common.dialogs, ...RS.popups];
    const found = D.queryAll(sel).filter((el) => !D.isOwnOverlay(el) && !hiddenForSnapshot(el) && D.isVisible(el));
    const size = new Map(found.map((el) => [el, el.getElementsByTagName('*').length + 1]));
    return found.filter(
      (inner) => !found.some((outer) => outer !== inner && D.contains(outer, inner) && size.get(outer) < size.get(inner) * 1.5),
    );
  }

  async function afterAction(parentId, ctxEl) {
    await D.settle({ quietMs: 450, maxMs: 4000 });
    if (!on) return;
    const dialogs = [];
    for (const dlg of openDialogs()) {
      const snap = serialize(dlg, RS.maxSnapshotChars);
      const h = hash(snap.html);
      const prev = dialogHashes.get(dlg);
      if (prev === h) continue;
      dialogHashes.set(dlg, h);
      if (prev && snap.chars > 150000) {
        dialogs.push({ root: describe(dlg), changed: true, note: 'large dialog changed; see neighbourhood snapshot' });
        continue;
      }
      dialogs.push({ root: describe(dlg), firstSeen: !prev, ...snap });
    }
    let after = null;
    if (ctxEl && ctxEl.isConnected) after = { root: describe(ctxEl), ...serialize(ctxEl, RS.maxSnapshotChars) };
    send({ kind: 'after', parentId, dialogs, neighborhood: after });
    checkUrl();
  }

  // ---------------------------------------------------------------------
  // Listeners
  // ---------------------------------------------------------------------

  function recordAction(kind, e, el, extra = {}) {
    const id = U.uid('ev');
    const ctx = neighborhood(el);
    const before = { root: describe(ctx), ...serialize(ctx, RS.maxSnapshotChars) };
    send({ kind, id, target: describe(el), path: pathOf(e), ...extra, before });
    afterAction(id, ctx);
  }

  const targetOf = (e) => {
    const el = e.composedPath()[0];
    return el && el.nodeType === 1 && !D.isOwnOverlay(el) ? el : null;
  };

  function onPointerDown(e) {
    if (!e.isTrusted || e.button !== 0) return;
    const el = targetOf(e);
    if (!el) return;
    lastPointerAt = Date.now();
    recordAction('click', e, el);
  }

  function onClick(e) {
    if (!e.isTrusted || Date.now() - lastPointerAt < 1500) return; // already logged on pointerdown
    const el = targetOf(e);
    if (el) recordAction('click', e, el, { viaKeyboard: e.detail === 0 });
  }

  function onInput(e) {
    if (!e.isTrusted) return;
    const el = targetOf(e);
    if (!el) return;
    const path = pathOf(e);
    clearTimeout(inputTimers.get(el));
    inputTimers.set(
      el,
      setTimeout(() => {
        const id = U.uid('ev');
        send({ kind: 'input', id, target: describe(el), path });
        afterAction(id, neighborhood(el));
      }, 900),
    );
  }

  function onChange(e) {
    if (!e.isTrusted) return;
    const el = targetOf(e);
    if (el) send({ kind: 'change', target: describe(el), path: pathOf(e) });
  }

  function onKeyDown(e) {
    if (!e.isTrusted || !['Enter', 'Escape', 'Tab', ' '].includes(e.key)) return;
    const el = targetOf(e);
    if (!el) return;
    const id = U.uid('ev');
    send({ kind: 'key', id, key: e.key, target: describe(el) });
    if (e.key !== 'Tab') afterAction(id, neighborhood(el));
  }

  function onCopy(e) {
    if (!e.isTrusted) return;
    const el = targetOf(e);
    let text = String(document.getSelection() || '');
    if (!text && el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
      text = el.value.slice(el.selectionStart || 0, el.selectionEnd || 0);
    }
    send({ kind: 'copy', text: clip(text, 1000), target: describe(el) });
  }

  // Written by the MAIN-world hook the service worker injects while recording
  // (catches "Copy" buttons that use navigator.clipboard.writeText).
  function onWindowMessage(e) {
    if (e.source !== window || !e.data || e.data.__ytcRecorder !== 'clipboard') return;
    send({ kind: 'clipboard', text: clip(String(e.data.text || ''), 1000), how: String(e.data.how || '') });
  }

  function checkUrl() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    send({ kind: 'navigate', title: document.title });
  }

  const LISTENERS = [
    ['pointerdown', onPointerDown],
    ['click', onClick],
    ['input', onInput],
    ['change', onChange],
    ['keydown', onKeyDown],
    ['copy', onCopy],
  ];

  function showBadge(show) {
    if (!isTop) return;
    if (!show) {
      if (badge) badge.remove();
      badge = null;
      return;
    }
    if (badge && badge.isConnected) return;
    badge = document.createElement('div');
    badge.setAttribute('data-ytc-overlay', '');
    badge.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;pointer-events:none;';
    const root = badge.attachShadow({ mode: 'closed' });
    root.innerHTML =
      '<div style="font:600 12px/1 system-ui,sans-serif;background:#c00;color:#fff;padding:7px 10px;border-radius:14px;box-shadow:0 2px 8px rgba(0,0,0,.3)">● Recording clicks (YT Collab)</div>';
    document.documentElement.append(badge);
  }

  function start() {
    if (on || !alive()) return;
    on = true;
    for (const [type, fn] of LISTENERS) window.addEventListener(type, fn, true);
    window.addEventListener('message', onWindowMessage);
    lastUrl = location.href;
    urlTimer = setInterval(checkUrl, 1000);
    showBadge(true);
    send({
      kind: 'page',
      title: document.title,
      lang: document.documentElement.lang || '',
      referrer: document.referrer || '',
      viewport: `${innerWidth}x${innerHeight}`,
    });
  }

  function stop() {
    if (!on) return;
    on = false;
    for (const [type, fn] of LISTENERS) window.removeEventListener(type, fn, true);
    window.removeEventListener('message', onWindowMessage);
    clearInterval(urlTimer);
    showBadge(false);
  }

  /** Whole-page snapshot on request (popup → "Snapshot this page"). Top frame only. */
  R.snapshotPage = () => {
    const page = serialize(document.body, RS.maxPageSnapshotChars);
    const dialogs = openDialogs().map((dlg) => ({ root: describe(dlg), ...serialize(dlg, RS.maxSnapshotChars) }));
    send({ kind: 'snapshot', title: document.title, page, dialogs });
    return { chars: page.chars, truncated: page.truncated, dialogs: dialogs.length };
  };

  R.isOn = () => on;

  // Exposed for the page-context reader and tests.
  R.describe = describe;
  R.serialize = serialize;

  // ---------------------------------------------------------------------
  // Boot: follow the on/off switch in storage.
  // ---------------------------------------------------------------------
  try {
    chrome.storage.local.get('recorder').then((d) => {
      if (d.recorder && d.recorder.on) start();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.recorder) return;
      const v = changes.recorder.newValue;
      v && v.on ? start() : stop();
    });
  } catch {
    // Extension was reloaded; this copy of the script is orphaned.
  }
})();
