/*
 * DOM helpers for driving Studio: shadow-root-aware queries, waiting with
 * MutationObserver + timeout, human-like clicks and typing, reading
 * checked state, and the dry-run highlighter.
 *
 * Runs in the content script's isolated world. Page JS variables are not
 * visible here; attributes (aria-checked, checked, …) and native element
 * state (input.checked / input.value) are.
 */
(function () {
  const YTC = (globalThis.YTC = globalThis.YTC || {});
  if (YTC.dom) return;
  const U = YTC.util;
  const D = (YTC.dom = {});

  // -------------------------------------------------------------------
  // Shadow DOM
  // -------------------------------------------------------------------

  /** Open shadow root, or a closed one via chrome.dom (content scripts only). */
  D.shadowOf = (el) => {
    if (el.shadowRoot) return el.shadowRoot;
    if (!el.localName || !el.localName.includes('-')) return null;
    try {
      return (globalThis.chrome && chrome.dom && chrome.dom.openOrClosedShadowRoot(el)) || null;
    } catch {
      return null;
    }
  };

  /** [root, ...every shadow root reachable below it]. */
  D.allRoots = (root = document) => {
    const roots = [root];
    for (let i = 0; i < roots.length; i++) {
      const walker = document.createTreeWalker(roots[i], NodeFilter.SHOW_ELEMENT);
      let n;
      while ((n = walker.nextNode())) {
        const sr = D.shadowOf(n);
        if (sr) roots.push(sr);
      }
    }
    return roots;
  };

  const pierce = () => !YTC.SEL || YTC.SEL.pierceShadowRoots !== false;

  /** querySelectorAll that also looks inside shadow roots. Accepts a selector or a list. */
  D.queryAll = (selector, root = document) => {
    const sel = Array.isArray(selector) ? selector.join(',') : selector;
    if (!sel) return [];
    const roots = pierce() ? D.allRoots(root) : [root];
    const out = [];
    for (const r of roots) for (const el of r.querySelectorAll(sel)) out.push(el);
    return out;
  };
  D.query = (selector, root) => D.queryAll(selector, root)[0] || null;

  /** Parent across shadow boundaries. */
  D.parentOf = (el) => el.parentElement || (el.parentNode && el.parentNode.host) || null;

  D.contains = (outer, inner) => {
    for (let n = inner; n; n = D.parentOf(n)) if (n === outer) return true;
    return false;
  };

  D.closest = (el, selector) => {
    for (let n = el; n; n = D.parentOf(n)) if (n.matches && n.matches(selector)) return n;
    return null;
  };

  // -------------------------------------------------------------------
  // Visibility, text, state
  // -------------------------------------------------------------------

  D.isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
      // display:contents wrappers have no box but their children can be visible.
      if (getComputedStyle(el).display !== 'contents') return false;
      return [...el.children].some(D.isVisible);
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  D.visibleAll = (selector, root) => D.queryAll(selector, root).filter(D.isVisible);
  D.visible = (selector, root) => D.visibleAll(selector, root)[0] || null;

  D.textOf = (el) => U.normText(el ? el.innerText || el.textContent : '');

  /** Accessible-ish name: aria-label, else visible text. */
  D.nameOf = (el) => U.normText(el.getAttribute('aria-label')) || D.textOf(el);

  /** Visible elements matching selector whose aria-label or text equals `text` (or contains it). */
  D.findByText = (selector, text, { root, contains = false } = {}) => {
    const want = U.normText(text);
    return D.visibleAll(selector, root).filter((el) => {
      const names = [U.normText(el.getAttribute('aria-label')), D.textOf(el)];
      return names.some((n) => (contains ? n.includes(want) : n === want));
    });
  };

  /**
   * Is this checkbox / toggle on? true, false, or null when it can't be told.
   * Looks at aria-checked, native .checked, the checked attribute and
   * aria-pressed, then at a single checkbox-like element inside.
   */
  D.readChecked = (el, depth = 0) => {
    if (!el) return null;
    const aria = el.getAttribute('aria-checked');
    if (aria === 'true') return true;
    if (aria === 'false') return false;
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return el.checked;
    if (el.hasAttribute('checked')) return el.getAttribute('checked') !== 'false';
    const pressed = el.getAttribute('aria-pressed');
    if (pressed === 'true') return true;
    if (pressed === 'false') return false;
    if (depth > 0) return null;
    const inner = D.queryAll('input[type="checkbox"], [role="checkbox"], [role="switch"], [aria-checked]', el).filter((x) => x !== el);
    return inner.length === 1 ? D.readChecked(inner[0], depth + 1) : null;
  };

  // -------------------------------------------------------------------
  // Waiting (MutationObserver + timeout, never a blind sleep)
  // -------------------------------------------------------------------

  /**
   * Resolve with finder()'s first truthy result. Re-checks on DOM mutations
   * (document + every shadow root) and on a slow safety-net poll, because
   * dialog open/close animations change visibility without mutating the DOM.
   */
  D.waitFor = (finder, { timeout = 15000, what = 'the page', signal } = {}) =>
    new Promise((resolve, reject) => {
      let done = false;
      let queued = false;
      let timer = 0;
      let poll = 0;
      const observed = new WeakSet();
      const observers = [];
      const finish = (err, val) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        observers.forEach((o) => o.disconnect());
        if (signal) signal.removeEventListener('abort', onAbort);
        err ? reject(err) : resolve(val);
      };
      const observe = () => {
        const roots = pierce() ? D.allRoots(document) : [document];
        for (const r of roots) {
          if (observed.has(r)) continue;
          observed.add(r);
          const mo = new MutationObserver(schedule);
          mo.observe(r, { subtree: true, childList: true, attributes: true, characterData: true });
          observers.push(mo);
        }
      };
      const check = () => {
        queued = false;
        if (done) return;
        let v;
        try {
          v = finder();
        } catch (e) {
          return finish(e);
        }
        if (v) return finish(null, v);
        observe();
      };
      function schedule() {
        if (!queued) {
          queued = true;
          setTimeout(check, 30); // coalesce bursts of mutations
        }
      }
      const onAbort = () => finish(new U.FlowError('CANCELLED', U.errorText('CANCELLED')));
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort);
      }
      timer = setTimeout(
        () => finish(new U.FlowError('TIMEOUT', `Timed out after ${Math.round(timeout / 1000)} s waiting for ${what}.`)),
        timeout,
      );
      poll = setInterval(check, 250);
      check();
    });

  D.waitForVisible = (selector, opts = {}) => D.waitFor(() => D.visible(selector, opts.root), { what: selector, ...opts });

  D.waitForGone = (finder, opts = {}) => D.waitFor(() => !finder(), { what: 'it to disappear', ...opts });

  /** Resolve once the DOM has been quiet for `quietMs` (or after `maxMs`). For snapshots, not for driving. */
  D.settle = ({ quietMs = 400, maxMs = 3000 } = {}) =>
    new Promise((resolve) => {
      let quiet;
      const mo = new MutationObserver(() => {
        clearTimeout(quiet);
        quiet = setTimeout(end, quietMs);
      });
      const end = () => {
        mo.disconnect();
        clearTimeout(quiet);
        clearTimeout(cap);
        resolve();
      };
      mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      quiet = setTimeout(end, quietMs);
      const cap = setTimeout(end, maxMs);
    });

  D.delay = (ms) => new Promise((r) => setTimeout(r, ms));

  // -------------------------------------------------------------------
  // Acting
  // -------------------------------------------------------------------

  /** Deepest element at a viewport point, looking through shadow roots. */
  D.elementAt = (x, y) => {
    let el = document.elementFromPoint(x, y);
    for (let i = 0; el && i < 20; i++) {
      const sr = D.shadowOf(el);
      const inner = sr && sr.elementFromPoint ? sr.elementFromPoint(x, y) : null;
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  };

  /**
   * Click like a person: scroll into view, check nothing covers the element,
   * then pointer/mouse down, up, click at its centre. Throws UNEXPECTED_UI if
   * something else is on top (an unexpected dialog, overlay, …).
   */
  D.click = (el, label = 'element') => {
    if (!D.isVisible(el)) throw new U.FlowError('UNEXPECTED_UI', `"${label}" is not visible, so it was not clicked.`);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const hit = D.elementAt(x, y);
    if (!hit || !(D.contains(el, hit) || D.contains(hit, el))) {
      const what = hit ? `<${hit.localName}${hit.id ? '#' + hit.id : ''}>` : 'nothing';
      throw new U.FlowError('UNEXPECTED_UI', `Something (${what}) is covering "${label}", so it was not clicked.`);
    }
    const target = D.contains(el, hit) ? hit : el;
    const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, view: window };
    const ptr = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    target.dispatchEvent(new PointerEvent('pointerover', ptr));
    target.dispatchEvent(new MouseEvent('mouseover', base));
    target.dispatchEvent(new PointerEvent('pointerdown', { ...ptr, buttons: 1 }));
    target.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    if (typeof target.focus === 'function') target.focus({ preventScroll: true });
    target.dispatchEvent(new PointerEvent('pointerup', ptr));
    target.dispatchEvent(new MouseEvent('mouseup', base));
    target.dispatchEvent(new MouseEvent('click', base));
    return target;
  };

  /** The real <input>/<textarea>/contenteditable behind a host element. */
  D.editableOf = (el) => {
    if (!el) return null;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable) return el;
    return D.query('input:not([type="hidden"]), textarea, [contenteditable="true"], [contenteditable=""]', el);
  };

  /** Replace the field's text, one character at a time, firing input events. */
  D.typeText = async (el, text, { charDelayMs = 35, signal } = {}) => {
    const field = D.editableOf(el);
    if (!field) throw new U.FlowError('UNEXPECTED_UI', 'The search box could not be typed into.');
    field.focus();
    const isInput = !field.isContentEditable;
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setValue = (v) => {
      if (isInput) Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, v);
      else field.textContent = v;
    };
    const fire = (inputType, data) =>
      field.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType, data }));

    setValue('');
    fire('deleteContentBackward', null);
    let current = '';
    for (const ch of String(text)) {
      if (signal && signal.aborted) throw new U.FlowError('CANCELLED', U.errorText('CANCELLED'));
      current += ch;
      field.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, composed: true }));
      setValue(current);
      fire('insertText', ch);
      field.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true, composed: true }));
      await D.delay(charDelayMs);
    }
    field.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    const now = isInput ? field.value : field.textContent;
    if (now !== String(text)) throw new U.FlowError('UNEXPECTED_UI', 'The search box did not keep the typed text.');
    return field;
  };

  // -------------------------------------------------------------------
  // Dry-run highlighter
  // -------------------------------------------------------------------

  let layer = null;
  const ensureLayer = () => {
    if (layer && layer.host.isConnected) return layer;
    const host = document.createElement('div');
    host.setAttribute('data-ytc-overlay', '');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .box{position:fixed;border:3px solid #ff0033;border-radius:6px;box-shadow:0 0 0 4px rgba(255,0,51,.25);}
      .box.commit{border-color:#ff8800;box-shadow:0 0 0 4px rgba(255,136,0,.3);border-style:dashed;}
      .tag{position:absolute;left:-3px;top:-24px;background:#ff0033;color:#fff;font:600 12px/1.6 system-ui,sans-serif;padding:0 6px;border-radius:4px;white-space:nowrap;}
      .commit .tag{background:#ff8800;}
      .banner{position:fixed;top:10px;left:50%;transform:translateX(-50%);background:#111;color:#fff;font:13px/1.4 system-ui,sans-serif;padding:8px 14px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.35);max-width:80vw;}`;
    root.append(style);
    document.documentElement.append(host);
    layer = { host, root };
    return layer;
  };

  /** Outline an element with a numbered label. `commit` = an action dry run never performs. */
  D.highlight = (el, label, { commit = false, ms = 12000 } = {}) => {
    const { root } = ensureLayer();
    const r = el.getBoundingClientRect();
    const box = document.createElement('div');
    box.className = 'box' + (commit ? ' commit' : '');
    box.style.cssText = `left:${r.left - 4}px;top:${r.top - 4}px;width:${r.width + 8}px;height:${r.height + 8}px;`;
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = label;
    box.append(tag);
    root.append(box);
    setTimeout(() => box.remove(), ms);
    return () => box.remove();
  };

  /** A status banner at the top of the page while a run is going. */
  D.banner = (text) => {
    const { root } = ensureLayer();
    let b = root.querySelector('.banner');
    if (!text) {
      if (b) b.remove();
      return;
    }
    if (!b) {
      b = document.createElement('div');
      b.className = 'banner';
      root.append(b);
    }
    b.textContent = text;
  };

  D.isOwnOverlay = (el) => !!(el && el.closest && el.closest('[data-ytc-overlay]'));
})();
