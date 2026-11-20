/* Écrans : Accueil, Films, Séries, Recherche, fiches, Sources, Réglages. Chaque vue renvoie une fonction de nettoyage. */
'use strict';

const Views = (() => {
  const { el, call, img, posterCard, wideCard, row, skeletonRow, toast } = UI;
  const tmdb = (path, params) => call(window.rr.tmdb(path, params));
  const go = (hash) => { location.hash = hash; };
  const yearOf = (it) => (it.release_date || it.first_air_date || '').slice(0, 4);
  const typeOf = (it, fallback) => it.media_type || fallback;
  const openItem = (it, fallback) => () => go(`#/${typeOf(it, fallback)}/${it.id}`);
  const store = {
    get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  const ICON_PLAY = () => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('fill', 'currentColor');
    p.setAttribute('d', 'M8 5.14v13.72a1 1 0 0 0 1.52.85l11.1-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14Z');
    s.append(p);
    return s;
  };

  // ---------------------------------------------------------- Lecture

  // Anime selon TMDB : animation (genre 16) d'origine japonaise.
  const isAnime = (it) => it.original_language === 'ja'
    && ((it.genre_ids || []).includes(16) || (it.genres || []).some((g) => g.id === 16));
  const movieMedia = (m) => ({ tmdbId: m.id, type: 'movie', anime: isAnime(m), title: m.title, originalTitle: m.original_title, year: yearOf(m) });
  const episodeMedia = (s, season, episode) => ({ tmdbId: s.id, type: 'tv', anime: isAnime(s), title: s.name, originalTitle: s.original_name, year: yearOf(s), season, episode });
  const itemMedia = (it) => ({ tmdbId: it.id, type: it.media_type, anime: isAnime(it), title: it.title || it.name, originalTitle: it.original_title || it.original_name, year: yearOf(it) });
  const typeLabel = (t) => ({ movie: 'Films', tv: 'Séries', anime: 'Animes' }[t] || t);
  const streamKey = (m) => `${m.type}:${m.tmdbId}:${m.season || 0}:${m.episode || 0}`;

  function playMovie(m) {
    Player.open(movieMedia(m), { title: m.title, backdrop: img(m.backdrop_path, 'w1280') });
  }

  function playEpisode(show, season, episode, epName) {
    store.set(`rr.lastEp.${show.id}`, { season, episode });
    Player.open(
      episodeMedia(show, season, episode),
      { title: `${show.name} · S${season} É${episode}${epName ? ` · ${epName}` : ''}`, backdrop: img(show.backdrop_path, 'w1280') },
    );
  }

  /**
   * Lance la recherche du flux dès l'ouverture de la fiche et affiche son état sous « Lire ».
   * « Lire » réutilise ensuite ce résultat (ou attend la recherche en cours).
   */
  function streamStatus(media) {
    const node = el('div', { class: 'stream-status' });
    const key = streamKey(media);
    const render = (st) => {
      node.className = `stream-status ${st.status}`;
      if (st.status === 'resolving') node.replaceChildren(el('span', { class: 'mini-spinner' }), 'Recherche d\'une source…');
      else if (st.status === 'ready') node.replaceChildren(el('span', { class: 'dot' }), 'Prêt à lire', el('span', { class: 'via' }, st.provider));
      else if (st.status === 'failed') {
        node.replaceChildren(el('span', { class: 'dot' }), st.code === 'NO_SOURCES' ? 'Aucune source active' : 'Aucune source n\'a trouvé ce titre');
      } else node.replaceChildren();
    };
    const off = window.rr.stream.onStatus((st) => { if (st.key === key) render(st); });
    call(window.rr.stream.prefetch(media, 'page')).then(render).catch(() => {});
    return { node, stop: off };
  }

  // ---------------------------------------------------------- États communs

  function onboarding(err) {
    const bad = err && err.code === 'BAD_KEY';
    return el('div', { class: 'page' },
      el('div', { style: { maxWidth: '640px', margin: '12vh auto 0', textAlign: 'center' } },
        el('div', { class: 'logo', style: { width: '84px', height: '84px', fontSize: '34px', borderRadius: '22px', margin: '0 auto 28px' } }, 'RR'),
        el('h1', { class: 'page-title' }, bad ? 'Clé TMDB refusée' : 'Bienvenue sur RR Streaming'),
        el('p', { class: 'page-sub', style: { lineHeight: '1.6' } },
          'Le catalogue (affiches, synopsis, saisons) vient de TMDB. Ajoutez votre clé API TMDB gratuite dans Réglages pour l\'afficher.'),
        el('div', { style: { display: 'flex', gap: '14px', justifyContent: 'center' } },
          el('button', { class: 'pill white', 'data-focus': true, onclick: () => go('#/settings') }, 'Ouvrir Réglages'),
          el('a', { class: 'pill', 'data-focus': true, href: 'https://www.themoviedb.org/settings/api', target: '_blank' }, 'Obtenir une clé'))));
  }

  function errorPage(err) {
    if (err.code === 'NO_KEY' || err.code === 'BAD_KEY') return onboarding(err);
    return el('div', { class: 'page' },
      el('h1', { class: 'page-title' }, 'Impossible de charger'),
      el('p', { class: 'page-sub' }, err.message),
      el('button', { class: 'pill white', 'data-focus': true, onclick: () => App.reload() }, 'Réessayer'));
  }

  // ---------------------------------------------------------- Top shelf

  function hero(items, fallbackType) {
    const list = items.filter((x) => x.backdrop_path).slice(0, 6);
    if (!list.length) return { node: el('div', { style: { height: '104px' } }), stop() {} };
    const bgA = el('div', { class: 'hero-bg' });
    const bgB = el('div', { class: 'hero-bg', style: { opacity: 0 } });
    const content = el('div', { class: 'hero-content' });
    const dots = el('div', { class: 'hero-dots' }, list.map(() => el('span')));
    const node = el('section', { class: 'hero' }, bgA, bgB, content, dots);
    let i = 0;
    let front = bgA;
    let timer = null;

    const show = (idx, first) => {
      const it = list[idx];
      const type = typeOf(it, fallbackType);
      const back = front === bgA ? bgB : bgA;
      const url = img(it.backdrop_path, 'original');
      if (first) { front.style.backgroundImage = `url("${url}")`; }
      else {
        back.style.backgroundImage = `url("${url}")`;
        back.style.opacity = 1;
        front.style.opacity = 0;
        front = back;
      }
      [...dots.children].forEach((d, k) => d.classList.toggle('on', k === idx));
      const hadFocus = content.querySelector('.focused');
      const focusIdx = hadFocus ? [...content.querySelectorAll('[data-focus]')].indexOf(hadFocus) : -1;
      content.replaceChildren(
        el('div', { class: 'hero-kicker' }, isAnime(it) ? 'Anime · Tendance' : type === 'tv' ? 'Série · Tendance' : 'Film · Tendance'),
        el('h1', { class: 'hero-title' }, it.title || it.name),
        el('div', { class: 'hero-meta' },
          yearOf(it) || null,
          it.vote_average ? el('span', { class: 'rating' }, `★ ${it.vote_average.toFixed(1)}`) : null,
          el('span', { class: 'badge' }, 'HD')),
        el('p', { class: 'hero-overview' }, it.overview || ''),
        el('div', { class: 'hero-actions' },
          el('button', { class: 'pill white', 'data-focus': true, onclick: () => (type === 'movie' ? playMovie(it) : go(`#/tv/${it.id}`)) }, ICON_PLAY(), type === 'movie' ? 'Lire' : 'Épisodes'),
          el('button', { class: 'pill', 'data-focus': true, onclick: () => go(`#/${type}/${it.id}`) }, 'Plus d\'infos')));
      content.style.animation = 'none';
      void content.offsetWidth;
      content.style.animation = '';
      if (focusIdx >= 0) UI.setFocus(content.querySelectorAll('[data-focus]')[focusIdx], { scroll: false });
    };
    show(0, true);
    const start = () => {
      clearInterval(timer);
      timer = setInterval(() => {
        if (document.hidden || Player.isOpen() || node.matches(':hover')) return;
        i = (i + 1) % list.length;
        show(i);
      }, 9000);
    };
    start();
    return { node, stop: () => clearInterval(timer) };
  }

  // ---------------------------------------------------------- Pages catalogue

  async function catalog(view, { heroPath, heroParams, heroType, rows }) {
    const page = el('div', { class: 'page flush' }, el('div', { class: 'hero skeleton' }), el('div', { class: 'rows' }, skeletonRow(7, true), skeletonRow()));
    view.replaceChildren(page);
    let h = null;
    try {
      const [heroData, ...rowData] = await Promise.all([tmdb(heroPath, heroParams), ...rows.map((r) => tmdb(r.path, r.params))]);
      h = hero(heroData.results || [], heroType);
      const rowsNode = el('div', { class: 'rows' }, rows.map((r, k) => {
        const items = (rowData[k].results || []).filter((x) => (x.media_type ? x.media_type !== 'person' : true));
        return row(r.title, items.map((it) => (r.wide ? wideCard(it, openItem(it, r.type)) : posterCard(it, openItem(it, r.type)))));
      }));
      page.replaceChildren(h.node, rowsNode);
      UI.focusFirst('.hero-actions [data-focus]');
    } catch (err) {
      view.replaceChildren(errorPage(err));
      UI.focusFirst();
    }
    return () => h && h.stop();
  }

  const home = (view) => catalog(view, {
    heroPath: '/trending/all/day',
    rows: [
      { title: 'À la une cette semaine', path: '/trending/all/week', wide: true },
      { title: 'Films populaires', path: '/movie/popular', type: 'movie' },
      { title: 'Séries populaires', path: '/tv/popular', type: 'tv' },
      { title: 'Actuellement au cinéma', path: '/movie/now_playing', type: 'movie' },
      { title: 'Films les mieux notés', path: '/movie/top_rated', type: 'movie' },
      { title: 'Séries les mieux notées', path: '/tv/top_rated', type: 'tv' },
    ],
  });

  const MOVIE_GENRES = [[28, 'Action'], [35, 'Comédie'], [18, 'Drame'], [878, 'Science-fiction'], [53, 'Thriller'], [16, 'Animation'], [27, 'Horreur'], [99, 'Documentaires']];
  const TV_GENRES = [[10759, 'Action & aventure'], [35, 'Comédie'], [18, 'Drame'], [10765, 'Science-fiction & fantastique'], [80, 'Crime'], [16, 'Animation'], [99, 'Documentaires']];

  const movies = (view) => catalog(view, {
    heroPath: '/trending/movie/week', heroType: 'movie',
    rows: [
      { title: 'Populaires', path: '/movie/popular', type: 'movie', wide: true },
      ...MOVIE_GENRES.map(([id, name]) => ({ title: name, path: '/discover/movie', params: { with_genres: id, sort_by: 'popularity.desc' }, type: 'movie' })),
    ],
  });

  const tv = (view) => catalog(view, {
    heroPath: '/trending/tv/week', heroType: 'tv',
    rows: [
      { title: 'Populaires', path: '/tv/popular', type: 'tv', wide: true },
      { title: 'En cours de diffusion', path: '/tv/on_the_air', type: 'tv' },
      ...TV_GENRES.map(([id, name]) => ({ title: name, path: '/discover/tv', params: { with_genres: id, sort_by: 'popularity.desc' }, type: 'tv' })),
    ],
  });

  const ANIME = { with_genres: 16, with_original_language: 'ja' };
  const anime = (view) => catalog(view, {
    heroPath: '/discover/tv', heroParams: { ...ANIME, sort_by: 'popularity.desc' }, heroType: 'tv',
    rows: [
      { title: 'Séries animes populaires', path: '/discover/tv', params: { ...ANIME, sort_by: 'popularity.desc' }, type: 'tv', wide: true },
      { title: 'En cours de diffusion', path: '/discover/tv', params: { ...ANIME, with_status: 0, sort_by: 'popularity.desc' }, type: 'tv' },
      { title: 'Films d\'animation japonais', path: '/discover/movie', params: { ...ANIME, sort_by: 'popularity.desc' }, type: 'movie' },
      { title: 'Les mieux notés', path: '/discover/tv', params: { ...ANIME, sort_by: 'vote_average.desc', 'vote_count.gte': 300 }, type: 'tv' },
      { title: 'Studio Ghibli', path: '/discover/movie', params: { with_companies: 10342, sort_by: 'popularity.desc' }, type: 'movie' },
      { title: 'Action & aventure', path: '/discover/tv', params: { ...ANIME, with_genres: '16,10759', sort_by: 'popularity.desc' }, type: 'tv' },
    ],
  });

  // ---------------------------------------------------------- Recherche

  let lastQuery = '';
  function search(view) {
    const input = el('input', { class: 'input', type: 'search', placeholder: 'Films, séries…', value: lastQuery, 'data-focus': true, spellcheck: 'false' });
    const results = el('div', { class: 'grid' });
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('width', '22'); icon.setAttribute('height', '22');
    icon.innerHTML = '<path fill="currentColor" d="M10.5 3a7.5 7.5 0 0 1 5.96 12.06l4.24 4.24a1 1 0 0 1-1.41 1.41l-4.24-4.24A7.5 7.5 0 1 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z"/>';
    const availLine = el('div', { class: 'avail-line' });
    view.replaceChildren(el('div', { class: 'page' },
      el('h1', { class: 'page-title' }, 'Recherche'),
      el('div', { class: 'search-box' }, icon, input),
      availLine,
      results));

    let timer = null;
    let token = 0;
    let cardsByKey = new Map();
    // Disponibilité sur les sources, affichée sur chaque affiche au fil des réponses.
    const setBadge = (card, text) => {
      const art = card.querySelector('.art');
      art.querySelectorAll('.avail-badge').forEach((b) => b.remove());
      art.append(el('div', { class: 'avail-badge' }, text));
    };
    const offDone = window.rr.sources.onAvailabilityDone((d) => {
      if (d.query !== lastQuery) return;
      const n = d.available != null ? d.available : [...cardsByKey.values()].filter((c) => c.classList.contains('available')).length;
      availLine.className = 'avail-line done';
      availLine.replaceChildren(el('span', { class: 'dot' }), `${n} titre${n > 1 ? 's' : ''} disponible${n > 1 ? 's' : ''} sur vos sources`,
        d.ms ? el('span', { class: 'muted' }, ` · ${(d.ms / 1000).toFixed(1).replace('.', ',')} s`) : null);
    });
    const offAvail = window.rr.sources.onAvailability((r) => {
      const card = cardsByKey.get(r.key);
      if (!card) return;
      card.classList.remove('checking');
      card.classList.add(r.available ? 'available' : 'unavailable');
      if (!card.classList.contains('ready')) setBadge(card, r.available ? 'Disponible' : 'Introuvable');
      if (r.available) card.title = `Disponible sur ${r.provider}`;
    });
    // Flux préparé (survol / focus d'un résultat disponible) : badge « Prêt à lire ».
    const applyStream = (st) => {
      const card = cardsByKey.get(st.key.split(':').slice(0, 2).join(':'));
      if (!card || !st.key.endsWith(':0:0')) return;
      card.classList.toggle('ready', st.status === 'ready');
      if (st.status === 'ready') setBadge(card, 'Prêt à lire');
      else if (st.status === 'resolving' && card.classList.contains('available')) setBadge(card, 'Préparation…');
      else if (card.classList.contains('available')) setBadge(card, 'Disponible');
    };
    const offStream = window.rr.stream.onStatus(applyStream);
    let hoverTimer = null;
    const prepare = (it) => {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        const card = cardsByKey.get(`${it.media_type}:${it.id}`);
        // Films : on prépare directement le flux ; séries : la fiche choisira l'épisode.
        if (card && card.classList.contains('available') && it.media_type === 'movie') {
          call(window.rr.stream.prefetch(itemMedia(it), 'hover')).then(applyStream).catch(() => {});
        }
      }, 500);
    };
    const run = async () => {
      const q = input.value.trim();
      lastQuery = q;
      const my = ++token;
      if (q.length < 2) { results.replaceChildren(); availLine.replaceChildren(); return; }
      try {
        const data = await tmdb('/search/multi', { query: q, include_adult: 'false' });
        if (my !== token) return;
        const items = (data.results || []).filter((x) => x.media_type === 'movie' || x.media_type === 'tv');
        cardsByKey = new Map();
        const cards = items.map((it) => {
          const card = posterCard(it, openItem(it));
          card.classList.add('checking');
          card.addEventListener('mouseenter', () => prepare(it));
          card.addEventListener('rr-focus', () => prepare(it));
          cardsByKey.set(`${it.media_type}:${it.id}`, card);
          return card;
        });
        results.replaceChildren(...(items.length ? cards : [el('p', { class: 'page-sub' }, 'Aucun résultat.')]));
        if (items.length) {
          availLine.className = 'avail-line';
          availLine.replaceChildren(el('span', { class: 'mini-spinner' }), 'Vérification sur vos sources…');
          call(window.rr.sources.availability(items.slice(0, 20).map(itemMedia), q)).then((n) => {
            if (!n) {
              cards.forEach((c) => c.classList.remove('checking'));
              availLine.className = 'avail-line done';
              availLine.replaceChildren('Aucune source active : ajoutez-en dans l\'onglet Sources pour voir ce qui est disponible.');
            }
          }).catch(() => cards.forEach((c) => c.classList.remove('checking')));
          cards.slice(20).forEach((c) => c.classList.remove('checking'));
        }
      } catch (err) {
        if (my === token) results.replaceChildren(errorPage(err));
      }
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 320); });
    if (lastQuery) run();
    UI.setFocus(input, { scroll: false });
    return () => { clearTimeout(timer); clearTimeout(hoverTimer); offAvail(); offDone(); offStream(); window.rr.sources.cancelAvailability(); };
  }

  // ---------------------------------------------------------- Fiches

  function detailShell(item, { kicker, metaParts, buttons, status = null }) {
    const genres = (item.genres || []).map((g) => g.name).join(' · ');
    return el('section', { class: 'hero' },
      el('div', { class: 'hero-bg', style: { backgroundImage: item.backdrop_path ? `url("${img(item.backdrop_path, 'original')}")` : '' } }),
      el('div', { class: 'hero-content' },
        el('div', { class: 'hero-kicker' }, kicker),
        el('h1', { class: 'hero-title' }, item.title || item.name),
        el('div', { class: 'hero-meta' }, metaParts.filter(Boolean).flatMap((p, k) => (k ? [el('span', {}, '·'), p] : [p]))),
        genres ? el('div', { class: 'genres' }, genres) : null,
        el('p', { class: 'hero-overview', style: { WebkitLineClamp: 5 } }, item.overview || 'Aucun synopsis disponible.'),
        el('div', { class: 'hero-actions' }, buttons),
        status));
  }

  function castRow(credits) {
    const cast = ((credits && credits.cast) || []).slice(0, 18);
    return row('Distribution', cast.map((p) => el('div', { class: 'card person', 'data-focus': true, tabindex: -1 },
      el('div', { class: 'art' }, p.profile_path ? el('img', { src: img(p.profile_path, 'w185'), alt: '', loading: 'lazy' }) : el('div', { class: 'fallback' }, (p.name || '?')[0])),
      el('div', { class: 'label' }, p.name),
      el('div', { class: 'sublabel' }, p.character || ''))));
  }

  async function movieDetail(view, id) {
    view.replaceChildren(el('div', { class: 'page flush detail' }, el('div', { class: 'hero skeleton' })));
    try {
      const m = await tmdb(`/movie/${id}`, { append_to_response: 'credits,recommendations' });
      const runtime = m.runtime ? `${Math.floor(m.runtime / 60)} h ${String(m.runtime % 60).padStart(2, '0')}` : null;
      const resume = store.get(`rr.progress.${m.id}.0.0`);
      const status = streamStatus(movieMedia(m));
      view.replaceChildren(el('div', { class: 'page flush detail' },
        detailShell(m, {
          kicker: isAnime(m) ? 'Film · Anime' : 'Film',
          status: status.node,
          metaParts: [yearOf(m), runtime, m.vote_average ? el('span', { class: 'rating' }, `★ ${m.vote_average.toFixed(1)}`) : null],
          buttons: [
            el('button', { class: 'pill white', 'data-focus': true, onclick: () => playMovie(m) }, ICON_PLAY(), resume > 30 ? 'Reprendre' : 'Lire'),
            el('button', { class: 'pill', 'data-focus': true, onclick: () => history.back() }, 'Retour'),
          ],
        }),
        el('div', { class: 'detail-below' },
          castRow(m.credits),
          row('Vous aimerez aussi', ((m.recommendations && m.recommendations.results) || []).map((it) => posterCard(it, openItem(it, 'movie')))))));
      UI.focusFirst('.hero-actions [data-focus]');
      return () => status.stop();
    } catch (err) {
      view.replaceChildren(errorPage(err));
      UI.focusFirst();
    }
    return null;
  }

  async function tvDetail(view, id) {
    view.replaceChildren(el('div', { class: 'page flush detail' }, el('div', { class: 'hero skeleton' })));
    try {
      const s = await tmdb(`/tv/${id}`, { append_to_response: 'credits,recommendations' });
      const seasons = (s.seasons || []).filter((x) => x.season_number > 0 && x.episode_count > 0);
      if (!seasons.length && s.seasons && s.seasons.length) seasons.push(...s.seasons);
      const last = store.get(`rr.lastEp.${s.id}`);
      const start = last || { season: seasons[0] ? seasons[0].season_number : 1, episode: 1 };

      const seasonBar = el('div', { class: 'seasons' });
      const episodesWrap = el('div');
      const status = streamStatus(episodeMedia(s, start.season, start.episode));
      // Survol / focus d'un épisode : on prépare aussi son flux.
      let hoverTimer = null;
      const prepare = (num, epNum) => {
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => window.rr.stream.prefetch(episodeMedia(s, num, epNum), 'hover'), 700);
      };

      const loadSeason = async (num) => {
        [...seasonBar.children].forEach((b) => b.classList.toggle('active', Number(b.dataset.season) === num));
        episodesWrap.replaceChildren(skeletonRow(5, true));
        try {
          const data = await tmdb(`/tv/${s.id}/season/${num}`);
          const cards = (data.episodes || []).map((ep) => {
            const card = el('div', {
              class: 'card episode', 'data-focus': true, tabindex: -1,
              onclick: () => playEpisode(s, num, ep.episode_number, ep.name),
              onmouseenter: () => prepare(num, ep.episode_number),
              'onrr-focus': () => prepare(num, ep.episode_number),
            },
              el('div', { class: 'art' },
                ep.still_path ? el('img', { src: img(ep.still_path, 'w500'), alt: '', loading: 'lazy' }) : el('div', { class: 'fallback' }, `Épisode ${ep.episode_number}`),
                el('div', { class: 'glare' })),
              el('div', { class: 'label' }, `${ep.episode_number}. ${ep.name || ''}`),
              el('div', { class: 'ep-overview' }, ep.overview || ''));
            return card;
          });
          episodesWrap.replaceChildren(row(`Saison ${num}`, cards) || el('p', { class: 'page-sub', style: { padding: '0 var(--pad)' } }, 'Aucun épisode.'));
        } catch (err) {
          episodesWrap.replaceChildren(el('p', { class: 'page-sub', style: { padding: '0 var(--pad)' } }, err.message));
        }
      };

      seasons.forEach((se) => seasonBar.append(el('button', {
        class: 'season-pill', 'data-focus': true, dataset: { season: se.season_number }, onclick: () => loadSeason(se.season_number),
      }, se.name || `Saison ${se.season_number}`)));

      view.replaceChildren(el('div', { class: 'page flush detail' },
        detailShell(s, {
          kicker: isAnime(s) ? 'Série · Anime' : 'Série',
          status: status.node,
          metaParts: [
            yearOf(s),
            s.number_of_seasons ? `${s.number_of_seasons} saison${s.number_of_seasons > 1 ? 's' : ''}` : null,
            s.vote_average ? el('span', { class: 'rating' }, `★ ${s.vote_average.toFixed(1)}`) : null,
          ],
          buttons: [
            el('button', { class: 'pill white', 'data-focus': true, onclick: () => playEpisode(s, start.season, start.episode) },
              ICON_PLAY(), `${last ? 'Reprendre' : 'Lire'} S${start.season} É${start.episode}`),
            el('button', { class: 'pill', 'data-focus': true, onclick: () => history.back() }, 'Retour'),
          ],
        }),
        el('div', { class: 'detail-below' },
          seasonBar, episodesWrap,
          castRow(s.credits),
          row('Vous aimerez aussi', ((s.recommendations && s.recommendations.results) || []).map((it) => posterCard(it, openItem(it, 'tv')))))));
      if (seasons.length) loadSeason(seasons.some((x) => x.season_number === start.season) ? start.season : seasons[0].season_number);
      UI.focusFirst('.hero-actions [data-focus]');
      return () => { status.stop(); clearTimeout(hoverTimer); };
    } catch (err) {
      view.replaceChildren(errorPage(err));
      UI.focusFirst();
    }
    return null;
  }

  // ---------------------------------------------------------- Sources

  /**
   * Assistant d'ajout intégré à l'application : la page compagnon s'affiche par-dessus l'interface
   * (mode « embedded ») et appelle l'app directement — pas de serveur, pas de code, pas de navigateur.
   */
  function openBuilder(hash = '#add') {
    const frame = el('iframe', { class: 'builder-frame', src: `../companion/index.html?embedded=1${hash}`, title: 'Assistant d\'ajout de source' });
    const sheet = el('div', { class: 'builder-sheet' }, frame);
    const onMessage = async (e) => {
      if (e.source !== frame.contentWindow) return;
      const m = e.data || {};
      if (m.type === 'rr-close') { close(); return; }
      if (m.type !== 'rr-api') return;
      let reply;
      try { reply = await call(window.rr.companion.api(m.method, m.path, m.body)); }
      catch (err) { reply = { status: 500, body: { error: err.message } }; }
      if (frame.contentWindow) frame.contentWindow.postMessage({ type: 'rr-api-reply', id: m.id, status: reply.status, data: reply.body }, '*');
    };
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      window.removeEventListener('message', onMessage);
      sheet.classList.remove('open');
      setTimeout(() => sheet.remove(), 400);
      UI.focusFirst('#view [data-focus]');
    }
    window.addEventListener('message', onMessage);
    document.body.append(sheet);
    requestAnimationFrame(() => sheet.classList.add('open'));
    frame.addEventListener('load', () => frame.focus());
    return close;
  }

  function sources(view) {
    const S = window.rr.sources;
    const lists = el('div');
    let closeBuilder = null;
    const builder = (hash) => { if (closeBuilder) closeBuilder(); closeBuilder = openBuilder(hash); };
    const wizardBtn = el('button', { class: 'pill white', 'data-focus': true, onclick: () => builder('#add') }, '+ Ajouter une source');

    // Téléphone : serveur local et QR code seulement à la demande.
    let serverOn = false;
    const panel = el('aside', { class: 'panel' });
    const phoneOff = () => panel.replaceChildren(
      el('div', { class: 'phone-icon' }, '📱'),
      el('h3', {}, 'Gérer depuis votre téléphone'),
      el('p', {}, 'Facultatif. Affiche un QR code pour ajouter ou modifier les sources depuis un téléphone sur le même réseau Wi-Fi.'),
      el('button', { class: 'pill', 'data-focus': true, onclick: phoneOn }, 'Afficher le QR code'));
    async function phoneOn() {
      panel.replaceChildren(el('h3', {}, 'Démarrage…'));
      try {
        const info = await call(window.rr.companion.start());
        serverOn = true;
        const stop = el('button', { class: 'pill small', 'data-focus': true, style: { marginTop: '20px' }, onclick: () => { window.rr.companion.stop(); serverOn = false; phoneOff(); } }, 'Arrêter');
        if (!info.url) {
          panel.replaceChildren(
            el('h3', {}, 'Réseau local indisponible'),
            el('p', {}, 'Connectez cet ordinateur à un réseau Wi-Fi ou Ethernet pour gérer les sources depuis un téléphone.'),
            stop);
          return;
        }
        panel.replaceChildren(
          el('h3', {}, 'Gérer depuis votre téléphone'),
          el('p', {}, 'Scannez le code, ou ouvrez l\'adresse dans un navigateur sur le même réseau.'),
          el('div', { class: 'qr' }, el('img', { src: info.qr, alt: 'QR code' })),
          el('div', { class: 'url' }, info.url.replace('http://', '')),
          el('div', { class: 'code-label' }, 'CODE'),
          el('div', { class: 'code' }, info.code.replace(/(\d{3})(\d{3})/, '$1 $2')),
          stop);
      } catch (err) {
        panel.replaceChildren(el('h3', {}, 'Serveur indisponible'), el('p', {}, err.message));
      }
    }
    phoneOff();
    const urlInput = el('input', { class: 'input', type: 'url', placeholder: 'URL d\'un fichier de sources (.json)', 'data-focus': true, spellcheck: 'false' });
    const fileInput = el('input', { type: 'file', accept: 'application/json,.json', class: 'hidden' });

    const addBtn = el('button', { class: 'pill white', 'data-focus': true }, 'Ajouter');
    const add = async () => {
      const url = urlInput.value.trim();
      if (!url) return;
      addBtn.disabled = true; addBtn.textContent = 'Téléchargement…';
      try { render(await call(S.addSubscription(url))); urlInput.value = ''; toast('Liste ajoutée'); }
      catch (err) { toast(errText(err), true); }
      addBtn.disabled = false; addBtn.textContent = 'Ajouter';
    };
    addBtn.addEventListener('click', add);
    urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.stopPropagation(); add(); } });
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0]; if (!f) return;
      try { const n = await call(S.importDocument(await f.text())); toast(`${n} source(s) importée(s)`); }
      catch (err) { toast(errText(err), true); }
      fileInput.value = '';
    });

    const errText = (err) => [err.message, ...(Array.isArray(err.details) ? err.details.slice(0, 4).map((d) => (typeof d === 'string' ? d : d.error)) : [])].join('\n');
    const ago = (ts) => {
      if (!ts) return 'jamais synchronisée';
      const s = Math.round((Date.now() - ts) / 1000);
      const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
      if (s < 60) return 'à l\'instant';
      if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
      if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
      return rtf.format(-Math.round(s / 86400), 'day');
    };
    const sw = (on, fn) => el('button', { class: `switch${on ? ' on' : ''}`, 'data-focus': true, 'aria-pressed': String(on), onclick: (e) => { e.stopPropagation(); fn(!on); } });
    const act = (p, msg) => call(p).then((st) => { if (st && st.revision !== undefined) render(st); if (msg) toast(msg); }).catch((err) => toast(errText(err), true));

    const withKey = (node, k) => { node.dataset.key = k; return node; };
    const syncAll = async () => {
      try {
        const r = await call(S.syncAll());
        toast(r.ok + r.failed === 0 ? 'Aucune liste à synchroniser' : r.failed ? `${r.ok} à jour · ${r.failed} en erreur` : 'Sources à jour', !!r.failed);
      } catch (err) { toast(errText(err), true); }
    };

    function render(st) {
      const focusedKey = document.querySelector('#view .focused')?.dataset.key;
      const subRows = st.subscriptions.map((sub) => el('div', { class: `list-row${sub.enabled ? '' : ' dim'}` },
        el('span', { class: `dot ${sub.lastError ? 'err' : sub.enabled ? 'on' : ''}` }),
        el('div', { class: 'lr-main' },
          el('div', { class: 'lr-title' }, sub.name),
          el('div', { class: 'lr-sub' }, sub.url),
          el('div', { class: `lr-sub${sub.lastError ? ' err' : ''}` }, sub.lastError ? `⚠︎ ${sub.lastError}` : `${sub.providerCount} source${sub.providerCount > 1 ? 's' : ''} · ${ago(sub.lastSyncAt)}`)),
        el('div', { class: 'lr-actions' },
          el('button', { class: 'icon-btn', 'data-focus': true, dataset: { key: `sync-${sub.id}` }, onclick: () => act(S.sync(sub.id), 'Liste synchronisée') }, 'Synchroniser'),
          el('button', { class: 'icon-btn danger', 'data-focus': true, onclick: () => confirm(`Supprimer « ${sub.name} » ?`) && act(S.removeSubscription(sub.id), 'Liste supprimée') }, 'Supprimer')),
        withKey(sw(sub.enabled, (v) => act(S.toggleSubscription(sub.id, v))), `sw-${sub.id}`)));

      const provRows = st.providers.map((e) => {
        const p = e.provider;
        const types = p.types.map(typeLabel).join(' · ');
        const s = sw(e.enabled, (v) => act(S.toggleProvider(p.id, v)));
        s.dataset.key = `p-${p.id}`;
        const local = e.subscriptionId == null;
        return el('div', { class: `list-row${e.enabled ? '' : ' dim'}` },
          el('span', { class: `dot ${e.enabled ? 'on' : ''}` }),
          el('div', { class: 'lr-main' },
            el('div', { class: 'lr-title' }, p.name),
            el('div', { class: 'lr-sub' }, `${e.originName} · ${types}${p.language ? ` · ${p.language.toUpperCase()}` : ''} · priorité ${p.priority}`)),
          local ? el('div', { class: 'lr-actions' },
            el('button', { class: 'icon-btn', 'data-focus': true, onclick: () => builder(`#edit=${encodeURIComponent(p.id)}`) }, 'Modifier'),
            el('button', { class: 'icon-btn danger', 'data-focus': true, onclick: () => confirm(`Supprimer « ${p.name} » ?`) && act(window.rr.companion.api('DELETE', `/api/providers/${encodeURIComponent(p.id)}`).then((r) => (r.ok && r.data.status < 400 ? { ok: true, data: r.data.body } : { ok: false, error: (r.data && r.data.body && r.data.body.error) || r.error })), 'Source supprimée') }, 'Supprimer')) : null,
          s);
      });

      lists.replaceChildren(
        el('div', { class: 'section-title' }, 'Listes', el('small', {}, String(st.subscriptions.length)), el('span', { class: 'grow' }),
          el('button', { class: 'icon-btn', 'data-focus': true, dataset: { key: 'sync-all' }, onclick: syncAll }, 'Tout synchroniser')),
        el('div', { class: 'list' }, subRows.length ? subRows : el('div', { class: 'empty' }, 'Aucune liste. Une liste est l\'URL d\'un fichier JSON qui regroupe plusieurs sources : collez-la ci-dessus.')),
        el('div', { class: 'section-title' }, 'Sources', el('small', {}, (() => { const n = st.providers.filter((x) => x.enabled).length; return `${n} active${n > 1 ? 's' : ''} sur ${st.providers.length}`; })())),
        el('div', { class: 'list' }, provRows.length ? provRows : el('div', { class: 'empty' }, 'Aucune source. Touchez « + Ajouter une source » : l\'assistant vous guide pas à pas.')));

      if (focusedKey) {
        const n = lists.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`);
        if (n) UI.setFocus(n, { scroll: false });
      }
    }

    view.replaceChildren(el('div', { class: 'page' },
      el('div', { class: 'split' },
        el('div', {},
          el('h1', { class: 'page-title' }, 'Sources'),
          el('p', { class: 'page-sub' }, 'Les sources servent uniquement à trouver la lecture d\'un titre du catalogue.'),
          el('div', { style: { display: 'flex', gap: '14px', alignItems: 'center', margin: '0 0 22px' } }, wizardBtn,
            el('span', { style: { color: 'var(--fg2)', fontSize: '15px' } }, 'Assistant pas à pas, sans JSON')),
          el('div', { class: 'field' }, urlInput, addBtn,
            el('button', { class: 'pill', 'data-focus': true, onclick: () => fileInput.click() }, 'Importer…'), fileInput),
          lists),
        panel)));

    call(S.state()).then(render).catch((err) => toast(err.message, true));
    const off = S.onChange(render);

    UI.setFocus(wizardBtn, { scroll: false });
    return () => { off(); if (closeBuilder) closeBuilder(); if (serverOn) window.rr.companion.stop(); };
  }

  // ---------------------------------------------------------- Réglages

  async function settings(view) {
    const cur = await call(window.rr.settings.get());
    const version = await call(window.rr.version());
    const key = el('input', { class: 'input', type: 'password', value: cur.tmdbKey, placeholder: 'Clé API (v3) ou jeton de lecture (v4)', 'data-focus': true, spellcheck: 'false' });
    const lang = el('select', { class: 'input', 'data-focus': true },
      [['fr-FR', 'Français'], ['en-US', 'English'], ['es-ES', 'Español'], ['de-DE', 'Deutsch'], ['it-IT', 'Italiano'], ['pt-BR', 'Português (BR)']]
        .map(([v, n]) => el('option', { value: v, selected: v === cur.language }, n)));
    let auto = cur.autoUpdate;
    const autoSw = el('button', { class: `switch${auto ? ' on' : ''}`, 'data-focus': true, onclick: async () => {
      auto = !auto; autoSw.classList.toggle('on', auto); await call(window.rr.settings.set({ autoUpdate: auto }));
    } });
    const updStatus = el('div', { class: 'desc', style: { margin: 0 } });
    const updBtn = el('button', { class: 'pill small', 'data-focus': true, onclick: async () => renderUpd(await call(window.rr.updater.check())) }, 'Rechercher');

    const renderUpd = (s) => {
      const map = {
        idle: 'Aucune vérification pour l\'instant.',
        checking: 'Recherche de mises à jour…',
        'up-to-date': 'RR Streaming est à jour.',
        downloading: `Téléchargement de la version ${s.available || ''}… ${s.percent || 0} %`,
        ready: `Version ${s.available} prête. Elle s'installera à la fermeture.`,
        error: `Erreur : ${s.error}`,
        dev: s.error,
      };
      updStatus.textContent = map[s.status] || '';
      if (s.status === 'ready') {
        updBtn.textContent = 'Redémarrer et installer';
        updBtn.onclick = () => window.rr.updater.install();
      }
    };
    const off = window.rr.updater.onState(renderUpd);
    call(window.rr.updater.state()).then(renderUpd);

    const save = async () => {
      await call(window.rr.settings.set({ tmdbKey: key.value, language: lang.value }));
      try { await call(window.rr.tmdb('/configuration')); toast('Clé TMDB valide, catalogue disponible'); }
      catch (err) { toast(err.message, true); }
    };
    key.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.stopPropagation(); save(); } });
    lang.addEventListener('change', save);

    view.replaceChildren(el('div', { class: 'page settings' },
      el('h1', { class: 'page-title' }, 'Réglages'),
      el('p', { class: 'page-sub' }, `RR Streaming ${version}`),
      el('div', { class: 'setting' },
        el('label', {}, 'Clé TMDB'),
        el('div', { class: 'desc' }, 'Nécessaire pour afficher le catalogue. Créez un compte gratuit sur themoviedb.org, puis Paramètres → API.'),
        el('div', { class: 'field' }, key,
          el('button', { class: 'pill', 'data-focus': true, onclick: () => { key.type = key.type === 'password' ? 'text' : 'password'; } }, 'Afficher'),
          el('button', { class: 'pill white', 'data-focus': true, onclick: save }, 'Enregistrer'))),
      el('div', { class: 'setting' },
        el('label', {}, 'Langue du catalogue'),
        el('div', { class: 'desc' }, 'Titres et synopsis TMDB. La recherche sur les sources utilise aussi le titre original.'),
        lang),
      el('div', { class: 'setting' },
        el('div', { class: 'row-inline' },
          el('div', {}, el('label', {}, 'Mises à jour automatiques'), el('div', { class: 'desc', style: { margin: 0 } }, 'Télécharge les nouvelles versions publiées sur GitHub.')),
          autoSw)),
      el('div', { class: 'setting' },
        el('div', { class: 'row-inline' }, el('div', {}, el('label', {}, 'Version'), updStatus), updBtn)),
      el('div', { class: 'legal' },
        'Ce produit utilise l\'API TMDB mais n\'est ni approuvé ni certifié par TMDB. ',
        'RR Streaming ne contient et ne fournit aucun contenu vidéo : la lecture dépend uniquement des sources que vous ajoutez.')));
    UI.setFocus(key, { scroll: false });
    return () => off();
  }

  return { home, movies, tv, anime, search, movieDetail, tvDetail, sources, settings };
})();
