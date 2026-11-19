/* Utilitaires d'interface : DOM, appels IPC, navigation au clavier / télécommande, effets tvOS. */
'use strict';

const UI = (() => {
  // ---------------------------------------------------------- DOM (aucun innerHTML pour les données externes)
  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (k === 'class') n.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return n;
  }

  // ---------------------------------------------------------- IPC
  async function call(promise) {
    const r = await promise;
    if (!r || !r.ok) {
      const e = new Error((r && r.error) || 'Erreur');
      e.code = r && r.code;
      e.details = r && r.details;
      throw e;
    }
    return r.data;
  }

  // ---------------------------------------------------------- Toast
  let toastTimer;
  function toast(msg, isErr = false) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.toggle('err', isErr);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), isErr ? 6000 : 2600);
  }

  // ---------------------------------------------------------- Images TMDB
  const img = (path, size = 'w500') => (path ? `https://image.tmdb.org/t/p/${size}${path}` : null);

  // ---------------------------------------------------------- Effet parallaxe tvOS sur les cartes
  function tilt(card) {
    const art = card.querySelector('.art');
    if (!art) return;
    card.addEventListener('mousemove', (e) => {
      const r = art.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      art.style.setProperty('--ry', `${(x - 0.5) * 10}deg`);
      art.style.setProperty('--rx', `${(0.5 - y) * 10}deg`);
      art.style.setProperty('--gx', `${x * 100}%`);
      art.style.setProperty('--gy', `${y * 100}%`);
    });
    card.addEventListener('mouseleave', () => {
      art.style.setProperty('--rx', '0deg');
      art.style.setProperty('--ry', '0deg');
    });
  }

  // ---------------------------------------------------------- Cartes
  function posterCard(item, onClick) {
    const title = item.title || item.name;
    const year = (item.release_date || item.first_air_date || '').slice(0, 4);
    const src = img(item.poster_path, 'w342');
    const card = el('div', { class: 'card poster', 'data-focus': true, tabindex: -1, onclick: onClick },
      el('div', { class: 'art' },
        src ? el('img', { src, alt: '', loading: 'lazy', draggable: 'false' }) : el('div', { class: 'fallback' }, title),
        el('div', { class: 'glare' })),
      el('div', { class: 'label' }, title),
      year ? el('div', { class: 'sublabel' }, year) : null);
    tilt(card);
    return card;
  }

  function wideCard(item, onClick) {
    const title = item.title || item.name;
    const src = img(item.backdrop_path, 'w780');
    const card = el('div', { class: 'card wide', 'data-focus': true, tabindex: -1, onclick: onClick },
      el('div', { class: 'art' },
        src ? el('img', { src, alt: '', loading: 'lazy', draggable: 'false' }) : el('div', { class: 'fallback' }, title),
        el('div', { class: 'wide-title' }, title),
        el('div', { class: 'glare' })));
    tilt(card);
    return card;
  }

  function row(title, cards) {
    if (!cards.length) return null;
    return el('section', { class: 'row' }, el('h2', { class: 'row-title' }, title), el('div', { class: 'row-scroller' }, cards));
  }

  function skeletonRow(n = 7, wide = false) {
    return el('section', { class: 'row' },
      el('div', { class: 'row-title skeleton', style: { width: '200px', height: '22px', borderRadius: '6px' } }),
      el('div', { class: 'row-scroller' }, Array.from({ length: n }, () =>
        el('div', { class: `card ${wide ? 'wide' : 'poster'}` }, el('div', { class: 'art skeleton' })))));
  }

  // ---------------------------------------------------------- Navigation spatiale (flèches / télécommande)
  let current = null;

  function focusables() {
    const root = document.getElementById('player').classList.contains('hidden') ? document : document.getElementById('player');
    return [...root.querySelectorAll('[data-focus]')].filter((n) => {
      if (n.closest('.hidden')) return false;
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }

  function setFocus(node, { scroll = true } = {}) {
    if (!node) return;
    if (current && current !== node) current.classList.remove('focused');
    current = node;
    node.classList.add('focused');
    node.dispatchEvent(new CustomEvent('rr-focus'));
    if (node.matches('input, select, textarea')) node.focus();
    else if (document.activeElement && document.activeElement.matches('input, select, textarea')) document.activeElement.blur();
    if (scroll) {
      const scroller = node.closest('.row-scroller');
      if (scroller) {
        const r = node.getBoundingClientRect();
        const s = scroller.getBoundingClientRect();
        const pad = parseFloat(getComputedStyle(scroller).paddingLeft) || 0;
        if (r.left < s.left + pad) scroller.scrollBy({ left: r.left - s.left - pad, behavior: 'smooth' });
        else if (r.right > s.right - pad) scroller.scrollBy({ left: r.right - s.right + pad, behavior: 'smooth' });
      }
      node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
  }

  function clearFocus() {
    if (current) current.classList.remove('focused');
    current = null;
  }

  function move(dir) {
    const list = focusables();
    if (!list.length) return;
    if (!current || !document.contains(current) || !list.includes(current)) { setFocus(list[0]); return; }
    const a = current.getBoundingClientRect();
    const ac = { x: a.left + a.width / 2, y: a.top + a.height / 2 };
    let best = null;
    let bestScore = Infinity;
    for (const n of list) {
      if (n === current) continue;
      const b = n.getBoundingClientRect();
      const bc = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      const dx = bc.x - ac.x;
      const dy = bc.y - ac.y;
      let primary, secondary;
      if (dir === 'right') { if (b.left < a.right - 4 && dx <= 4) continue; primary = Math.max(0, b.left - a.right); secondary = Math.abs(dy); }
      if (dir === 'left') { if (b.right > a.left + 4 && dx >= -4) continue; primary = Math.max(0, a.left - b.right); secondary = Math.abs(dy); }
      if (dir === 'down') { if (b.top < a.bottom - 4 && dy <= 4) continue; primary = Math.max(0, b.top - a.bottom); secondary = Math.abs(dx); }
      if (dir === 'up') { if (b.bottom > a.top + 4 && dy >= -4) continue; primary = Math.max(0, a.top - b.bottom); secondary = Math.abs(dx); }
      const score = primary + secondary * (dir === 'up' || dir === 'down' ? 0.6 : 2.2);
      if (score < bestScore) { bestScore = score; best = n; }
    }
    if (best) setFocus(best);
  }

  function initKeyboard({ onBack }) {
    document.addEventListener('keydown', (e) => {
      const typing = e.target.matches && e.target.matches('input, textarea, select');
      const map = { ArrowRight: 'right', ArrowLeft: 'left', ArrowDown: 'down', ArrowUp: 'up' };
      if (map[e.key]) {
        if (typing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
        e.preventDefault();
        move(map[e.key]);
      } else if (e.key === 'Enter' && current && !typing) {
        e.preventDefault();
        current.click();
      } else if ((e.key === 'Escape' || (e.key === 'Backspace' && !typing))) {
        if (typing) { e.target.blur(); return; }
        e.preventDefault();
        onBack();
      }
    });
    document.addEventListener('mouseover', (e) => {
      const n = e.target.closest && e.target.closest('[data-focus]');
      if (n && n !== current) setFocus(n, { scroll: false });
    });
  }

  function focusFirst(selector) {
    const n = selector ? document.querySelector(selector) : focusables()[0];
    if (n) setFocus(n, { scroll: false });
  }

  return { el, call, toast, img, posterCard, wideCard, row, skeletonRow, setFocus, clearFocus, focusFirst, initKeyboard, move };
})();
