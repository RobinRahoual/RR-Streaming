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

  function row(title, cards, cls = '') {
    if (!cards.length) return null;
    return el('section', { class: `row${cls ? ` ${cls}` : ''}` }, el('h2', { class: 'row-title' }, title), el('div', { class: 'row-scroller' }, cards));
  }

  // ---------------------------------------------------------- Icônes (traits) et boutons ronds
  const ICONS = {
    play: '<path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l11.1-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14Z" fill="currentColor" stroke="none"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.1"/>',
    prev: '<path d="m14.5 5-7 7 7 7"/>',
    next: '<path d="m9.5 5 7 7-7 7"/>',
  };
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'ico');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICONS[name]; // tracés internes, aucune donnée externe
    return svg;
  }
  const roundBtn = (name, label, onclick, extra = {}) => el('button', { class: 'round-btn', 'data-focus': true, 'aria-label': label, title: label, onclick, ...extra }, icon(name));

  // ---------------------------------------------------------- Fond ambiant (image floutée derrière le panneau)
  const ambient = (() => {
    const layers = [...document.querySelectorAll('#ambient .amb')];
    let front = 0;
    let cur = null;
    let gen = 0;
    let touched = -1;
    function set(url) {
      touched = gen;
      if (url === cur || !layers.length) return;
      cur = url;
      const next = layers[1 - front];
      if (url) next.style.backgroundImage = `url("${url}")`;
      next.classList.toggle('on', !!url);
      layers[front].classList.remove('on');
      front = 1 - front;
    }
    return { set, mark: () => ++gen, settle: (t) => { if (touched !== t) set(null); } };
  })();

  // ---------------------------------------------------------- Ma liste
  const MYLIST_KEY = 'rr.mylist';
  const mylist = {
    list() {
      try { const v = JSON.parse(localStorage.getItem(MYLIST_KEY)); return Array.isArray(v) ? v : []; } catch { return []; }
    },
    has: (type, id) => mylist.list().some((x) => x.media_type === type && x.id === id),
    toggle(item, type) {
      const t = item.media_type || type;
      const rest = mylist.list().filter((x) => !(x.media_type === t && x.id === item.id));
      const added = rest.length === mylist.list().length;
      if (added) {
        rest.unshift({
          id: item.id, media_type: t, title: item.title, name: item.name, poster_path: item.poster_path, backdrop_path: item.backdrop_path,
          release_date: item.release_date, first_air_date: item.first_air_date, original_language: item.original_language,
          genre_ids: item.genre_ids || (item.genres || []).map((g) => g.id),
        });
      }
      try { localStorage.setItem(MYLIST_KEY, JSON.stringify(rest.slice(0, 200))); } catch { /* ignore */ }
      window.dispatchEvent(new CustomEvent('rr-mylist'));
      return added;
    },
  };
  /** Bouton rond « + / ✓ » relié à Ma liste. */
  function mylistBtn(item, type) {
    const t = item.media_type || type;
    const b = roundBtn('plus', 'Ajouter à Ma liste', null, { class: 'round-btn mylist-btn' });
    const paint = () => {
      const on = mylist.has(t, item.id);
      b.classList.toggle('on', on);
      b.replaceChildren(icon(on ? 'check' : 'plus'));
      b.setAttribute('aria-label', on ? 'Retirer de Ma liste' : 'Ajouter à Ma liste');
      b.title = b.getAttribute('aria-label');
    };
    b.addEventListener('click', () => { toast(mylist.toggle(item, t) ? 'Ajouté à Ma liste' : 'Retiré de Ma liste'); paint(); });
    paint();
    return b;
  }

  // ---------------------------------------------------------- « À suivre » (titres commencés)
  // Une entrée par film ou par série (dernier épisode regardé), la plus récente en premier.
  const RESUME_KEY = 'rr.continue';
  const resume = {
    list() {
      try { const v = JSON.parse(localStorage.getItem(RESUME_KEY)); return Array.isArray(v) ? v : []; } catch { return []; }
    },
    write(list) { try { localStorage.setItem(RESUME_KEY, JSON.stringify(list.slice(0, 20))); } catch { /* ignore */ } },
    keyOf: (media) => `${media.type}:${media.tmdbId}`,
    save(media, display, t, d) {
      if (!media || !display) return;
      const key = resume.keyOf(media);
      const rest = resume.list().filter((x) => x.key !== key);
      // Même seuils que la reprise du lecteur : plus de 30 s vues, plus d'une minute restante.
      if (t > 30 && d && t < d - 60) rest.unshift({ key, media, display, t, d, at: Date.now() });
      resume.write(rest);
    },
    remove(media) { const key = resume.keyOf(media); resume.write(resume.list().filter((x) => x.key !== key)); },
  };

  const PLAY_PATH = 'M8 5.14v13.72a1 1 0 0 0 1.52.85l11.1-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14Z';
  function playGlyph() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('fill', 'currentColor');
    p.setAttribute('d', PLAY_PATH);
    svg.append(p);
    return el('div', { class: 'play-glyph' }, svg);
  }

  function resumeCard(entry, onClick) {
    const { display, t, d } = entry;
    const left = Math.max(1, Math.round((d - t) / 60));
    const leftText = left >= 60
      ? `${Math.floor(left / 60)} h${left % 60 ? ` ${String(left % 60).padStart(2, '0')}` : ''} restantes`
      : `${left} min restante${left > 1 ? 's' : ''}`;
    const sub = [display.sub, leftText].filter(Boolean).join(' · ');
    const card = el('div', { class: 'card wide resume', 'data-focus': true, tabindex: -1, dataset: { key: `resume-${entry.key}` }, onclick: onClick },
      el('div', { class: 'art' },
        display.backdrop ? el('img', { src: display.backdrop, alt: '', loading: 'lazy', draggable: 'false' }) : el('div', { class: 'fallback' }, display.name || display.title),
        el('div', { class: 'wide-title has-sub' }, display.name || display.title),
        el('div', { class: 'wide-sub' }, sub),
        playGlyph(),
        el('div', { class: 'glare' })),
      el('div', { class: 'progress' }, el('i', { style: { width: `${Math.min(100, (t / d) * 100).toFixed(1)}%` } })));
    tilt(card);
    return card;
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

  const focused = () => current;

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
    // Comme tvOS : entrer dans la barre latérale place le focus sur l'onglet de la page en cours.
    if (best && !current.closest('#nav') && best.closest('#nav')) {
      best = document.querySelector('#nav .tab.active') || best;
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

  return {
    el, call, toast, img, icon, roundBtn, ambient, mylist, mylistBtn, posterCard, wideCard, resumeCard, resume, row, skeletonRow,
    setFocus, clearFocus, focused, focusFirst, initKeyboard, move,
  };
})();
