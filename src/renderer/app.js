/* Routeur, barre de navigation, bannière de mise à jour. */
'use strict';

const App = (() => {
  const view = document.getElementById('view');
  const topbar = document.getElementById('topbar');
  const shell = document.getElementById('shell');
  let cleanup = null;
  let routeToken = 0;
  let lastFocusSelector = null;

  const routes = [
    [/^#\/home$/, () => Views.home(view), 'home'],
    [/^#\/movies$/, () => Views.movies(view), 'movies'],
    [/^#\/tv$/, () => Views.tv(view), 'tv'],
    [/^#\/anime$/, () => Views.anime(view), 'anime'],
    [/^#\/search$/, () => Views.search(view), 'search'],
    [/^#\/mylist$/, () => Views.mylist(view), 'mylist'],
    [/^#\/sources$/, () => Views.sources(view), 'sources'],
    [/^#\/settings$/, () => Views.settings(view), 'settings'],
    [/^#\/movie\/(\d+)$/, (m) => Views.movieDetail(view, m[1]), null],
    [/^#\/tv\/(\d+)$/, (m) => Views.tvDetail(view, m[1]), null],
  ];

  async function route() {
    if (Player.isOpen()) Player.close();
    if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
    cleanup = null;
    UI.clearFocus();
    view.scrollTop = 0;
    topbar.classList.remove('solid');

    const hash = location.hash || '#/home';
    const match = routes.find(([re]) => re.test(hash));
    if (!match) { location.replace('#/home'); return; }
    const [re, render, tab] = match;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.route === tab));
    shell.dataset.route = tab || 'detail';
    const my = ++routeToken;
    const amb = UI.ambient.mark();
    const result = await render(hash.match(re));
    if (my !== routeToken) { if (typeof result === 'function') result(); return; } // page déjà quittée
    UI.ambient.settle(amb); // pages sans image : le fond ambiant s'éteint
    cleanup = result;
  }

  view.addEventListener('scroll', () => topbar.classList.toggle('solid', view.scrollTop > 40), { passive: true });
  topbar.querySelector('.tb-back').addEventListener('click', () => back());

  function back() {
    if (Player.isOpen()) { Player.close(); return; }
    const hash = location.hash || '#/home';
    if (/^#\/(movie|tv)\/\d+$/.test(hash)) { history.back(); return; }
    // Page principale : « Retour » ouvre d'abord la barre latérale (comme tvOS), puis ramène à l'accueil.
    const inNav = UI.focused() && UI.focused().closest('#nav');
    const tab = document.querySelector('#nav .tab.active');
    if (!inNav && tab) UI.setFocus(tab, { scroll: false });
    else if (hash !== '#/home') location.hash = '#/home';
  }

  function restoreFocus() {
    const n = (lastFocusSelector && document.querySelector(lastFocusSelector)) || document.querySelector('#view .hero-actions [data-focus]');
    if (n) UI.setFocus(n, { scroll: false }); else UI.focusFirst();
  }

  // Bannière « mise à jour prête »
  const banner = document.getElementById('update-banner');
  window.rr.updater.onState((s) => {
    if (s.status === 'ready') {
      banner.querySelector('.ub-text').textContent = `RR Streaming ${s.available} est prêt`;
      banner.classList.remove('hidden');
    }
  });
  document.getElementById('ub-install').addEventListener('click', () => window.rr.updater.install());

  UI.initKeyboard({ onBack: back });
  window.addEventListener('hashchange', route);
  if (!location.hash) location.replace('#/home'); // déclenche hashchange → route()
  else route();

  return { reload: route, restoreFocus };
})();
