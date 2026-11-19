/* Lecteur plein écran : résolution du flux via les sources, lecture HLS (hls.js), DASH (dash.js) ou MP4. */
'use strict';

const Player = (() => {
  const root = document.getElementById('player');
  const video = document.getElementById('video');
  const $ = (s) => root.querySelector(s);
  const loading = $('.player-loading');

  let hls = null;
  let dash = null;
  let session = 0;
  let alternatives = [];
  let altIndex = 0;
  let mediaKey = null;
  let idleTimer = null;
  let saveTimer = null;
  let unsubscribe = null;
  let lastMedia = null;
  let lastDisplay = null;
  let lastResult = null;
  let refreshed = false;
  const keyOf = (m) => `${m.type}:${m.tmdbId}:${m.season || 0}:${m.episode || 0}`;

  // ---------------------------------------------------------- Ouverture / fermeture

  async function open(media, display) {
    const my = ++session;
    lastMedia = media;
    lastDisplay = display;
    mediaKey = `rr.progress.${media.tmdbId}.${media.season || 0}.${media.episode || 0}`;
    root.classList.remove('hidden', 'playing', 'is-playing', 'idle');
    root.setAttribute('aria-hidden', 'false');
    $('.player-backdrop').style.backgroundImage = display.backdrop ? `url("${display.backdrop}")` : '';
    $('.pc-title').textContent = display.title;
    $('.pc-source').textContent = '';
    setLoading(display.title, 'Recherche d\'une source…');
    UI.focusFirst('#player [data-act="back"]');

    const key = keyOf(media);
    refreshed = false;
    unsubscribe = window.rr.player.onProgress((p) => {
      if (my !== session || (p.key && p.key !== key)) return;
      $('.pl-status').textContent = `${p.provider} — ${p.message}`;
      if (p.failed) addLog(`${p.provider} : ${p.message.replace(/^Échec : /, '')}`, true);
    });

    try {
      const res = await UI.call(window.rr.player.resolve(media));
      if (my !== session) return;
      start(res);
    } catch (err) {
      if (my !== session) return;
      showError(err);
    }
  }

  function start(res) {
    lastResult = res;
    alternatives = res.alternatives && res.alternatives.length ? res.alternatives : [res.stream];
    altIndex = 0;
    $('.pc-source').textContent = res.provider.name;
    $('.pl-status').textContent = `${res.provider.name} — Démarrage de la lecture…`;
    attach(alternatives[0]);
  }

  /** Flux préchargé expiré (jeton) : une nouvelle recherche, une seule fois. */
  async function refresh(reason) {
    refreshed = true;
    const my = session;
    root.classList.remove('playing', 'is-playing');
    destroyEngines();
    loading.classList.remove('error');
    $('.pl-status').textContent = 'Le flux préparé a expiré, nouvelle recherche…';
    console.warn('[player] rafraîchissement :', reason);
    try {
      const res = await UI.call(window.rr.player.resolve(lastMedia, { fresh: true }));
      if (my === session) start(res);
    } catch (err) {
      if (my === session) showError(err);
    }
  }

  function close() {
    session++;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    saveProgress();
    clearInterval(saveTimer);
    destroyEngines();
    video.removeAttribute('src');
    video.load();
    window.rr.player.cancel();
    window.rr.player.stop();
    window.rr.window.setFullscreen(false);
    root.classList.add('hidden');
    root.setAttribute('aria-hidden', 'true');
    UI.clearFocus();
    if (typeof App !== 'undefined') App.restoreFocus();
  }

  const isOpen = () => !root.classList.contains('hidden');

  // ---------------------------------------------------------- Moteurs

  function destroyEngines() {
    if (hls) { hls.destroy(); hls = null; }
    if (dash) { try { dash.reset(); } catch { /* ignore */ } dash = null; }
  }

  function attach(stream) {
    destroyEngines();
    const my = session;
    const fail = (msg) => { if (my === session) nextAlternative(msg); };

    if (stream.type === 'hls' && window.Hls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, backBufferLength: 90, maxBufferLength: 60 });
      let recoveries = 0;
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR && recoveries++ < 2) hls.startLoad();
        else if (d.type === Hls.ErrorTypes.MEDIA_ERROR && recoveries++ < 2) hls.recoverMediaError();
        else fail(`HLS : ${d.details}`);
      });
      hls.loadSource(stream.url);
      hls.attachMedia(video);
    } else if (stream.type === 'dash' && window.dashjs) {
      dash = dashjs.MediaPlayer().create();
      dash.on(dashjs.MediaPlayer.events.ERROR, (e) => fail(`DASH : ${(e.error && e.error.message) || 'erreur'}`));
      dash.initialize(video, stream.url, true);
    } else {
      video.src = stream.url;
    }
    video.play().catch(() => { /* démarrage attendu après chargement */ });
  }

  function nextAlternative(reason) {
    console.warn('[player]', reason);
    altIndex++;
    if (altIndex < alternatives.length) {
      addLog(`Flux ${altIndex} illisible, essai du suivant…`, true);
      attach(alternatives[altIndex]);
    } else if (lastResult && lastResult.cached && !refreshed) {
      refresh(reason);
    } else {
      root.classList.remove('playing');
      showError(new Error(`Le flux trouvé n'a pas pu être lu.\n${reason}`));
    }
  }

  // ---------------------------------------------------------- États

  function setLoading(title, status) {
    loading.classList.remove('error');
    $('.pl-title').textContent = title;
    $('.pl-status').textContent = status;
    $('.pl-log').replaceChildren();
    $('.pl-actions').replaceChildren();
  }

  function addLog(text, failed) {
    $('.pl-log').append(UI.el('li', { class: failed ? 'fail' : '' }, text));
  }

  function showError(err) {
    loading.classList.add('error');
    let msg = err.message;
    if (err.code === 'ALL_FAILED' && Array.isArray(err.details)) {
      $('.pl-log').replaceChildren(...err.details.map((f) => UI.el('li', { class: 'fail' }, `${f.provider} : ${f.error}`)));
    }
    $('.pl-status').textContent = msg;
    const actions = [UI.el('button', { class: 'pill white small', 'data-focus': true, onclick: () => open(lastMedia, lastDisplay) }, 'Réessayer')];
    if (err.code === 'NO_SOURCES') {
      actions.unshift(UI.el('button', { class: 'pill white small', 'data-focus': true, onclick: () => { close(); location.hash = '#/sources'; } }, 'Ouvrir Sources'));
      actions.pop();
    }
    actions.push(UI.el('button', { class: 'pill small', 'data-focus': true, onclick: close }, 'Fermer'));
    $('.pl-actions').replaceChildren(...actions);
    UI.focusFirst('#player .pl-actions [data-focus]');
  }

  // ---------------------------------------------------------- Événements vidéo

  video.addEventListener('playing', () => {
    root.classList.add('playing', 'is-playing');
    bumpIdle();
    clearInterval(saveTimer);
    saveTimer = setInterval(saveProgress, 5000);
  });
  video.addEventListener('pause', () => { root.classList.remove('is-playing'); showChrome(); });
  video.addEventListener('loadedmetadata', () => {
    try {
      const saved = Number(localStorage.getItem(mediaKey) || 0);
      if (saved > 30 && video.duration && saved < video.duration - 60) video.currentTime = saved;
    } catch { /* stockage indisponible */ }
  });
  video.addEventListener('ended', () => { try { localStorage.removeItem(mediaKey); } catch { /* ignore */ } });
  video.addEventListener('error', () => {
    if (!hls && !dash && isOpen() && video.getAttribute('src')) nextAlternative('MP4 : lecture impossible');
  });
  video.addEventListener('timeupdate', renderTime);
  video.addEventListener('progress', renderTime);

  function saveProgress() {
    if (!mediaKey || !video.duration || !isFinite(video.duration)) return;
    try { localStorage.setItem(mediaKey, String(Math.floor(video.currentTime))); } catch { /* ignore */ }
  }

  const fmt = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
  };

  function renderTime() {
    const d = video.duration;
    const t = video.currentTime;
    const pct = d && isFinite(d) ? (t / d) * 100 : 0;
    $('.pc-progress').style.width = `${pct}%`;
    $('.pc-knob').style.left = `${pct}%`;
    if (video.buffered.length && d && isFinite(d)) $('.pc-buffer').style.width = `${(video.buffered.end(video.buffered.length - 1) / d) * 100}%`;
    $('.pc-time.cur').textContent = fmt(t);
    $('.pc-time.dur').textContent = d && isFinite(d) ? `-${fmt(d - t)}` : 'DIRECT';
  }

  $('.pc-track').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (video.duration && isFinite(video.duration)) video.currentTime = ((e.clientX - r.left) / r.width) * video.duration;
  });

  // ---------------------------------------------------------- Contrôles

  const actions = {
    back: close,
    play: () => (video.paused ? video.play() : video.pause()),
    back10: () => { video.currentTime = Math.max(0, video.currentTime - 10); },
    fwd10: () => { video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10); },
    fullscreen: () => window.rr.window.toggleFullscreen(),
  };
  root.querySelectorAll('[data-act]').forEach((b) => {
    b.setAttribute('data-focus', '');
    b.addEventListener('click', () => { actions[b.dataset.act](); bumpIdle(); });
  });
  video.addEventListener('click', actions.play);
  video.addEventListener('dblclick', actions.fullscreen);

  function showChrome() { root.classList.remove('idle'); clearTimeout(idleTimer); }
  function bumpIdle() {
    showChrome();
    if (!video.paused) idleTimer = setTimeout(() => root.classList.add('idle'), 3000);
  }
  root.addEventListener('mousemove', bumpIdle);

  // Raccourcis prioritaires quand le lecteur est ouvert et lit une vidéo.
  document.addEventListener('keydown', (e) => {
    if (!isOpen()) return;
    const playing = root.classList.contains('playing');
    const wasIdle = root.classList.contains('idle');
    bumpIdle();
    if (e.key === 'Escape' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (!playing) return;
    if (e.key === ' ' || e.key === 'MediaPlayPause' || (e.key === 'Enter' && wasIdle)) { e.preventDefault(); e.stopPropagation(); actions.play(); }
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && wasIdle) { e.preventDefault(); e.stopPropagation(); actions[e.key === 'ArrowLeft' ? 'back10' : 'fwd10'](); }
    else if (e.key === 'MediaFastForward') actions.fwd10();
    else if (e.key === 'MediaRewind') actions.back10();
    else if (e.key === 'f' || e.key === 'F') actions.fullscreen();
    else if (wasIdle && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); e.stopPropagation(); UI.focusFirst('#player [data-act="play"]'); }
  }, true);

  return { open, close, isOpen };
})();
