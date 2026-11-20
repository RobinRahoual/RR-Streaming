'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cheerio = require('cheerio');

const { validateDocument, validateProvider } = require('../src/main/sources/validator');
const { SourceRepository } = require('../src/main/sources/repository');
const scraper = require('../src/main/sources/scraper');
const { createClassifier, rank } = require('../src/main/resolver/classifier');
const { CompanionServer } = require('../src/main/companion/server');
const { analyzeHtml } = require('../src/main/sources/builder');

const example = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures-sources.json'), 'utf8'));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rr-'));

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

// ------------------------------------------------------------ Validation

test('le document d\'exemple est valide', () => {
  assert.deepStrictEqual(validateDocument(example), []);
});

test('les erreurs de validation sont précises', () => {
  const bad = structuredClone(example.providers[0]);
  bad.id = 'Mauvais ID';
  bad.search.url = 'https://x.org/search';
  bad.search.item = 'div[';
  delete bad.episodes;
  const errors = validateProvider(bad);
  assert.ok(errors.some((e) => e.includes('.id')));
  assert.ok(errors.some((e) => e.includes('{query}')));
  assert.ok(errors.some((e) => e.includes('search.item') && e.includes('CSS')));
  assert.ok(errors.some((e) => e.includes('episodes')));
});

test('ids en double refusés', () => {
  const doc = { schemaVersion: 1, providers: [example.providers[0], example.providers[0]] };
  assert.ok(validateDocument(doc).some((e) => e.includes('double')));
});

// ------------------------------------------------------------ Extraction & correspondance

test('extract : texte, attribut absolu, regex', () => {
  const $ = cheerio.load('<article><h3> Le  Film </h3><a href="/film/42">x</a><span class="m">Sortie 2021 · 2h</span></article>');
  const el = $('article')[0];
  assert.strictEqual(scraper.extract($, el, { css: 'h3' }, 'https://a.org/'), 'Le Film');
  assert.strictEqual(scraper.extract($, el, { css: 'a', attr: 'href' }, 'https://a.org/search'), 'https://a.org/film/42');
  assert.strictEqual(scraper.extract($, el, { css: '.m', regex: '(\\d{4})' }, 'https://a.org/'), '2021');
});

test('pickBest privilégie le bon titre et la bonne année', () => {
  const results = [
    { title: 'Dune (1984)', year: '1984', link: 'a' },
    { title: 'Dune', year: '2021', link: 'b' },
    { title: 'Dune : Deuxième partie', year: '2024', link: 'c' },
  ];
  const best = scraper.pickBest(results, { title: 'Dune', year: '2021' }, { minScore: 0.8, yearTolerance: 1 });
  assert.strictEqual(best.link, 'b');
  assert.strictEqual(scraper.pickBest(results, { title: 'Inception', year: '2010' }, { minScore: 0.8, yearTolerance: 1 }), null);
});

test('similarity ignore accents, casse et articles', () => {
  assert.ok(scraper.similarity('Le Fabuleux Destin d\'Amélie Poulain', 'fabuleux destin d amelie poulain') > 0.95);
});

test('search + episodeUrl de bout en bout sur un faux site', async () => {
  const { srv, base } = await serve((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/serie/page') {
      return res.end('<li class="ep"><span class="s">Saison 2</span><span class="e">Épisode 3</span><a href="/ep/2-3">x</a></li>');
    }
    if (req.url.startsWith('/recherche')) {
      assert.match(req.url, /q=The%20Office/);
      return res.end(`<article class="card"><h3 class="card-title">The Office</h3><span class="card-meta">2005</span><a href="/serie/the-office">voir</a></article>
                      <article class="card"><h3 class="card-title">The Office (UK)</h3><span class="card-meta">2001</span><a href="/serie/uk">voir</a></article>`);
    }
    res.statusCode = 404; res.end();
  });
  try {
    const p = { ...structuredClone(example.providers[0]), baseUrl: base };
    p.match = { minScore: 0.8, yearTolerance: 1 };
    const { best } = await scraper.search(p, { type: 'tv', title: 'The Office', year: '2005' });
    assert.strictEqual(best.link, `${base}/serie/the-office`);
    const ep = await scraper.episodeUrl(p, best.link, 2, 3);
    assert.strictEqual(ep, `${base}/serie/the-office/saison-2/episode-3`);
    const byParams = { ...p, episodes: { params: { s: '{season}', ep: '{episode}' } } };
    assert.strictEqual(await scraper.episodeUrl(byParams, `${base}/anime/jjk?s=1&ep=&lang=vo&anime_id=42765`, 2, 6), `${base}/anime/jjk?s=2&ep=6&lang=vo&anime_id=42765`);
    assert.deepStrictEqual(validateProvider(byParams), []);
    const parsed = { ...p, episodes: { item: 'li.ep', season: { css: '.s' }, episode: { css: '.e' }, link: { css: 'a', attr: 'href' } } };
    assert.strictEqual(await scraper.episodeUrl(parsed, `${base}/serie/page`, 2, 3), `${base}/ep/2-3`);
  } finally {
    srv.close();
  }
});

// ------------------------------------------------------------ Classifieur du résolveur

test('classifier : détection et blocage', () => {
  const c = createClassifier({ allowedHosts: ['cdn.player.net'] });
  assert.strictEqual(c.detectStream('https://x.net/v/master.m3u8?token=1'), 'hls');
  assert.strictEqual(c.detectStream('https://x.net/v/stream.mpd'), 'dash');
  assert.strictEqual(c.detectStream('https://x.net/v/film.mp4#t=1'), 'mp4');
  assert.strictEqual(c.detectStream('https://x.net/seg/001.ts'), null);
  assert.strictEqual(c.detectStream('https://x.net/ads/preroll.mp4'), null);
  assert.ok(c.shouldBlock('https://securepubads.g.doubleclick.net/x.js', 'script'));
  assert.ok(c.shouldBlock('https://site.org/poster.jpg', 'image'));
  assert.ok(!c.shouldBlock('https://cdn.player.net/poster.jpg', 'image'));
  assert.ok(!c.isNavigationAllowed('https://autre-site.com/', 'www.site.org'));
  assert.ok(c.isNavigationAllowed('https://player.site.org/', 'www.site.org'));
  assert.ok(!c.isNavigationAllowed('intent://x', 'www.site.org'));
});

test('classifier : iframe du lecteur détournée vers une pub après un clic', () => {
  const c = createClassifier({ allowedHosts: ['cdn-ok.net'] });
  const frame = 'https://embed.player.to/e/abc';
  // Premier chargement de l'iframe : toujours permis (hébergeur différent du site)
  assert.equal(c.isFrameNavigationAllowed('https://embed.player.to/e/abc', 'about:blank', { userTriggered: true }), true);
  // Même site : permis
  assert.equal(c.isFrameNavigationAllowed('https://www.player.to/e/abc?srv=2', frame, { userTriggered: true }), true);
  // Autre site juste après un clic : pub
  assert.equal(c.isFrameNavigationAllowed('https://win-prize.xyz/lp', frame, { userTriggered: true }), false);
  // Autre site sans clic (changement de serveur par la page) : permis
  assert.equal(c.isFrameNavigationAllowed('https://other-embed.cc/e/1', frame, { userTriggered: false }), true);
  // Régie connue : toujours bloquée ; hôte autorisé par la source : toujours permis
  assert.equal(c.isFrameNavigationAllowed('https://ads.exoclick.com/x', frame), false);
  assert.equal(c.isFrameNavigationAllowed('https://cdn-ok.net/p', frame, { userTriggered: true }), true);
});

test('classifier : régies reconnues pour ne pas suivre leurs redirections', () => {
  const c = createClassifier({});
  assert.equal(c.detectAd('https://www.popads.net/x'), true);
  assert.equal(c.detectAd('https://nouveau-domaine.example/film/1'), false);
});

test('rank : HLS master > variantes > DASH > MP4', () => {
  const r = rank([
    { url: 'https://a/f.mp4', type: 'mp4', order: 0 },
    { url: 'https://a/720/index-v1.m3u8', type: 'hls', order: 1 },
    { url: 'https://a/v.mpd', type: 'dash', order: 2 },
    { url: 'https://a/master.m3u8', type: 'hls', order: 3 },
  ]);
  assert.deepStrictEqual(r.map((x) => x.url.split('/').pop()), ['master.m3u8', 'index-v1.m3u8', 'v.mpd', 'f.mp4']);
});

// ------------------------------------------------------------ Dépôt de sources

test('repository : abonnement, ETag, erreur conservant les sources, désactivation', async () => {
  let version = 1;
  let broken = false;
  const { srv, base } = await serve((req, res) => {
    const etag = `"v${version}"`;
    if (broken) { res.statusCode = 500; return res.end(); }
    if (req.headers['if-none-match'] === etag) { res.statusCode = 304; return res.end(); }
    res.setHeader('ETag', etag);
    res.setHeader('Content-Type', 'application/json');
    const doc = structuredClone(example);
    doc.name = `Liste v${version}`;
    res.end(JSON.stringify(doc));
  });
  const dir = tmpDir();
  try {
    const repo = new SourceRepository(dir);
    repo.load();
    const sub = await repo.addSubscription(`${base}/sources.json`);
    assert.strictEqual(sub.name, 'Liste v1');
    assert.strictEqual(repo.activeProviders('movie').length, 1);

    await repo.sync(sub.id); // 304
    assert.strictEqual(repo.store.subscriptions[0].lastError, null);

    version = 2;
    await repo.sync(sub.id);
    assert.strictEqual(repo.store.subscriptions[0].name, 'Liste v2');

    broken = true;
    await assert.rejects(repo.sync(sub.id));
    assert.ok(repo.store.subscriptions[0].lastError);
    assert.strictEqual(repo.store.subscriptions[0].providers.length, 1, 'les anciennes sources sont conservées');

    await repo.setProviderEnabled('exemple', false);
    assert.strictEqual(repo.activeProviders('movie').length, 0);

    // Persistance
    const again = new SourceRepository(dir);
    again.load();
    assert.strictEqual(again.store.subscriptions.length, 1);
    assert.deepStrictEqual(again.store.disabledIds, ['exemple']);
  } finally {
    srv.close();
  }
});

test('repository : une source locale remplace celle d\'une liste au même id', async () => {
  const repo = new SourceRepository(tmpDir());
  repo.load();
  await repo.importDocument(JSON.stringify(example));
  const local = { ...structuredClone(example.providers[0]), name: 'Ma version', priority: 90 };
  await repo.upsertLocalProvider(local);
  const entries = repo.entries();
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].provider.name, 'Ma version');
  await assert.rejects(repo.upsertLocalProvider({ id: 'x' }), /invalide/);
});

// ------------------------------------------------------------ Serveur compagnon

test('compagnon : page publique, API protégée par code', async () => {
  const repo = new SourceRepository(tmpDir());
  repo.load();
  const companion = new CompanionServer(repo);
  const info = await companion.start([18080, 18081, 18082, 18083]);
  const base = `http://127.0.0.1:${info.port}`;
  try {
    const page = await fetch(`${base}/`);
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /RR Streaming/);

    assert.strictEqual((await fetch(`${base}/api/state`)).status, 401);

    const h = { 'X-Pairing-Code': info.code, 'Content-Type': 'application/json' };
    const ok = await fetch(`${base}/api/import`, { method: 'POST', headers: h, body: JSON.stringify(example) });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await ok.json()).providers.length, 1);

    const bad = await fetch(`${base}/api/providers`, { method: 'POST', headers: h, body: JSON.stringify({ id: 'x' }) });
    assert.strictEqual(bad.status, 400);
    assert.ok((await bad.json()).details.length > 0);

    const toggled = await fetch(`${base}/api/providers/exemple/toggle`, { method: 'POST', headers: h, body: '{"enabled":false}' });
    assert.strictEqual((await toggled.json()).providers[0].enabled, false);
  } finally {
    companion.stop();
  }
});

// ------------------------------------------------------------ Assistant de création

test('assistant : détecte la liste de résultats sans le menu ni le pied de page', () => {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'search-page.html'), 'utf8');
  const r = analyzeHtml(html, 'https://cine.exemple.org/recherche?q=dune');
  assert.strictEqual(r.candidates.length, 1);
  const c = r.candidates[0];
  assert.strictEqual(c.selectors.item, 'article.movie-card');
  assert.deepStrictEqual(c.samples.map((x) => x.year), ['2021', '1984', '2024', '2024']);
  assert.strictEqual(c.samples[0].poster, 'https://cine.exemple.org/img/dune.jpg');
  assert.strictEqual(c.samples[0].link, 'https://cine.exemple.org/film/dune-2021');
  // Les sélecteurs proposés forment une source valide
  const provider = { id: 'cine', name: 'Ciné', baseUrl: 'https://cine.exemple.org', types: ['movie'], search: { url: '{baseUrl}/recherche?q={query}', ...c.selectors } };
  assert.deepStrictEqual(validateProvider(provider), []);
});

test('assistant : iframe du lecteur avant la bande-annonce, pubs exclues', () => {
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'movie-page.html'), 'utf8');
  const r = analyzeHtml(html, 'https://cine.exemple.org/film/dune-2021');
  assert.deepStrictEqual(r.iframes.map((i) => i.selector.css), ['iframe#player', 'iframe.trailer']);
  assert.strictEqual(r.iframes[0].selector.attr, 'data-src');
  assert.strictEqual(r.iframes[0].src, 'https://lecteur.exemple.net/embed/xyz');
});

test('assistant : analyse et test via l\'API du compagnon', async () => {
  const pages = {
    '/recherche': fs.readFileSync(path.join(__dirname, 'fixtures', 'search-page.html'), 'utf8'),
  };
  const { srv, base } = await serve((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (pages[u.pathname]) return res.end(pages[u.pathname]);
    res.statusCode = 404; res.end();
  });
  const repo = new SourceRepository(tmpDir());
  repo.load();
  const companion = new CompanionServer(repo);
  const info = await companion.start([18090, 18091, 18092]);
  const api = (p, b) => fetch(`http://127.0.0.1:${info.port}${p}`, { method: 'POST', headers: { 'X-Pairing-Code': info.code }, body: JSON.stringify(b) });
  try {
    const a = await (await api('/api/builder/analyze', { url: `${base}/recherche?q=dune` })).json();
    assert.strictEqual(a.candidates[0].selectors.item, 'article.movie-card');
    const provider = { id: 'cine', name: 'Ciné', baseUrl: base, types: ['movie'], search: { url: '{baseUrl}/recherche?q={query}', ...a.candidates[0].selectors } };
    const t = await (await api('/api/builder/test', { provider, title: 'Dune', year: '1984' })).json();
    assert.strictEqual(t.best.link, `${base}/film/dune-1984`);
    const bad = await api('/api/builder/test', { provider: { id: 'x' }, title: 'Dune' });
    assert.strictEqual(bad.status, 400);
  } finally {
    companion.stop();
    srv.close();
  }
});

test('assistant : page construite en JavaScript → rendu puis analyse, et recherche avec render', async () => {
  const rendered = fs.readFileSync(path.join(__dirname, 'fixtures', 'search-page.html'), 'utf8');
  const { srv, base } = await serve((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fs.readFileSync(path.join(__dirname, 'fixtures', 'js-search-page.html')));
  });
  const { analyzeUrl } = require('../src/main/sources/builder');
  try {
    // Sans moteur de rendu : rien de reconnu, pas d'erreur.
    const plain = await analyzeUrl(`${base}/recherche?q=dune`);
    assert.strictEqual(plain.rendered, false);
    assert.strictEqual(plain.candidates.length, 0);

    // Avec moteur de rendu (simulé) : la page affichée est analysée.
    const calls = [];
    scraper.setPageRenderer(async (url) => { calls.push(url); return { html: rendered, url }; });
    const r = await analyzeUrl(`${base}/recherche?q=dune`);
    assert.strictEqual(r.rendered, true);
    assert.strictEqual(r.candidates[0].selectors.item, 'article.movie-card');

    // Une source render:true passe par le moteur de rendu pour la recherche.
    const provider = { id: 'js', name: 'JS', baseUrl: base, types: ['movie'], render: true, match: { minScore: 0.8, yearTolerance: 1 }, headers: {},
      search: { url: '{baseUrl}/recherche?q={query}', ...r.candidates[0].selectors } };
    assert.deepStrictEqual(validateProvider(provider), []);
    const { best } = await scraper.search(provider, { type: 'movie', title: 'Dune', year: '1984' });
    assert.ok(best.link.endsWith('/film/dune-1984'));
    assert.ok(calls.length >= 2);
  } finally {
    scraper.setPageRenderer(null);
    srv.close();
  }
});

test('assistant : liste d\'épisodes à adresses numériques (une saison par page)', async () => {
  const { analyzeEpisodesHtml } = require('../src/main/sources/builder');
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'series-page.html'), 'utf8');
  const base = 'https://anime.exemple.org';
  const r = analyzeEpisodesHtml(html, `${base}/anime/jjk?season=1`, {
    showUrl: `${base}/anime/jjk?season=1`, episodeUrl: `${base}/episode/48206`, season: 1, episode: 6,
  });
  assert.strictEqual(r.spec.item, 'a.ep-card');
  assert.deepStrictEqual(r.spec.link, { css: '', attr: 'href' });
  assert.strictEqual(r.spec.episode.css, 'span.ep-num');
  assert.deepStrictEqual(r.spec.pageParams, { season: '{season}' });
  assert.strictEqual(r.count, 12);
  assert.deepStrictEqual(r.samples.slice(0, 3).map((x) => x.episode), [1, 2, 3]);
  assert.strictEqual(r.spec.season, undefined);

  // À l'usage : la saison 2 est demandée via ?season=2, l'épisode 6 lu dans la liste.
  const requested = [];
  const { srv, base: local } = await serve((req, res) => {
    requested.push(req.url);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  });
  try {
    const provider = { id: 'anime', name: 'Anime', baseUrl: local, types: ['tv'], headers: {},
      search: { url: '{baseUrl}/s?q={query}', item: 'a', title: { css: '' }, link: { css: '', attr: 'href' } }, episodes: r.spec };
    assert.deepStrictEqual(validateProvider(provider), []);
    const url = await scraper.episodeUrl(provider, `${local}/anime/jjk`, 2, 6);
    assert.strictEqual(url, `${local}/episode/48206`);
    assert.strictEqual(requested[0], '/anime/jjk?season=2');
  } finally {
    srv.close();
  }
});

test('assistant : plusieurs saisons sur la même page → numéro de saison lu dans chaque épisode', () => {
  const { analyzeEpisodesHtml } = require('../src/main/sources/builder');
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'series-multi.html'), 'utf8');
  const base = 'https://x.org';
  const r = analyzeEpisodesHtml(html, `${base}/serie/abc`, { showUrl: `${base}/serie/abc`, episodeUrl: `${base}/watch/9203`, season: 2, episode: 3 });
  assert.strictEqual(r.spec.item, 'li.episode');
  assert.ok(r.spec.season, 'sélecteur de saison attendu');
  const $ = cheerio.load(html);
  const found = $(r.spec.item).toArray().find((el) =>
    Number(scraper.extract($, el, r.spec.season, base)) === 2 && Number(scraper.extract($, el, r.spec.episode, base)) === 5);
  assert.strictEqual(scraper.extract($, found, r.spec.link, base), `${base}/watch/9205`);
});

test('assistant : épisode absent de la page → message clair', () => {
  const { analyzeEpisodesHtml } = require('../src/main/sources/builder');
  const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'series-page.html'), 'utf8');
  assert.throws(() => analyzeEpisodesHtml(html, 'https://a.org/anime/jjk', { showUrl: 'https://a.org/anime/jjk', episodeUrl: 'https://a.org/episode/1', season: 1, episode: 6 }),
    /n'apparaît pas sur la page de la série/);
});

// ------------------------------------------------------------ Préchargement des flux

const { StreamCache } = require('../src/main/resolver/stream-cache');
const { Availability } = require('../src/main/resolver/availability');

function fakeResolver() {
  const calls = [];
  const resolve = (_repo, media, { signal, onProgress }) => {
    const call = { media, signal, done: null };
    calls.push(call);
    return new Promise((res, rej) => {
      onProgress({ provider: 'Test', message: 'Recherche du titre…' });
      call.done = () => res({ stream: { url: `https://cdn/${media.tmdbId}.m3u8`, type: 'hls', headers: {} }, alternatives: [], provider: { id: 't', name: 'Test' } });
      signal.addEventListener('abort', () => rej(new Error('Annulé')));
    });
  };
  return { calls, resolve };
}

test('préchargement : la lecture réutilise la résolution lancée à l\'ouverture de la fiche', async () => {
  const f = fakeResolver();
  const events = [];
  const cache = new StreamCache({}, { resolve: f.resolve, emit: (ch, d) => events.push([ch, d]) });
  const dune = { type: 'movie', tmdbId: 1, title: 'Dune' };
  assert.strictEqual(cache.prefetch(dune).status, 'resolving');
  const playing = cache.resolve(dune); // « Lire » pendant la résolution : pas de deuxième recherche
  assert.strictEqual(f.calls.length, 1);
  f.calls[0].done();
  const r = await playing;
  assert.strictEqual(r.stream.url, 'https://cdn/1.m3u8');
  assert.strictEqual(r.cached, false);
  assert.ok(events.some(([ch, d]) => ch === 'stream:status' && d.status === 'ready' && d.provider === 'Test'));

  // Deuxième « Lire » : instantané, depuis le cache
  const again = await cache.resolve(dune);
  assert.strictEqual(again.cached, true);
  assert.strictEqual(f.calls.length, 1);
  // Flux illisible : nouvelle résolution forcée
  const freshP = cache.resolve(dune, { fresh: true });
  assert.strictEqual(f.calls.length, 2);
  f.calls[1].done();
  assert.strictEqual((await freshP).cached, false);
});

test('préchargement : ouvrir une autre fiche annule la recherche précédente, sauf si le lecteur l\'attend', async () => {
  const f = fakeResolver();
  const cache = new StreamCache({}, { resolve: f.resolve });
  cache.prefetch({ type: 'movie', tmdbId: 1 });
  cache.prefetch({ type: 'movie', tmdbId: 2 });
  assert.strictEqual(f.calls[0].signal.aborted, true);
  assert.strictEqual(cache.status({ type: 'movie', tmdbId: 1 }).status, 'idle');

  const waited = cache.resolve({ type: 'movie', tmdbId: 2 });
  cache.prefetch({ type: 'movie', tmdbId: 3 });
  assert.strictEqual(f.calls[1].signal.aborted, false, 'le lecteur attend ce flux');
  f.calls[1].done();
  await waited;
});

test('disponibilité : résultats au fil de l\'eau et cache', async () => {
  const repo = { activeProviders: () => [{ id: 'a', name: 'A', types: ['movie', 'tv'] }], providersFor: () => [{ id: 'a', name: 'A', types: ['movie', 'tv'] }] };
  const results = [];
  let searches = 0;
  const av = new Availability(repo, {
    emit: (ch, d) => { if (ch === 'availability:result') results.push(d); },
    search: async (_p, media) => { searches++; return { best: media.title === 'Dune' ? { link: 'x' } : null }; },
  });
  av.check([{ type: 'movie', tmdbId: 1, title: 'Dune' }, { type: 'movie', tmdbId: 2, title: 'Inconnu' }]);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(results.map((r) => [r.key, r.available]).sort(), [['movie:1', true], ['movie:2', false]]);
  av.check([{ type: 'movie', tmdbId: 1, title: 'Dune' }]);
  assert.strictEqual(searches, 2, 'servi depuis le cache');
  assert.strictEqual(new Availability({ activeProviders: () => [] }).check([{ type: 'movie', tmdbId: 1 }]), 0);
});

test('correspondance : titres de films avec année, langue ou qualité', () => {
  const m = { minScore: 0.8, yearTolerance: 1 };
  const ok = (t, y, r, ry) => !!scraper.pickBest([{ title: r, link: 'x', year: ry }], { title: t, year: y }, m);
  assert.ok(ok('Dune', '2021', 'Dune (2021)'));
  assert.ok(ok('Oppenheimer', '2023', 'Oppenheimer en streaming VF HD', '2023'));
  assert.ok(ok('Les Misérables', '2019', 'Les Misérables (2019) - Film complet'));
  assert.ok(!ok('Dune', '2021', 'Dune (1984)'), 'année du titre prise en compte');
  assert.ok(!ok('Up', '2009', 'Up in the Air', '2009'));
  assert.ok(!ok('Alien', '1979', 'Alien Romulus', '2024'));
});

test('recherche : essaie le titre original si le titre français ne donne rien', async () => {
  const { srv, base } = await serve((req, res) => {
    const q = new URL(req.url, 'http://x').searchParams.get('q');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(q === 'The Matrix' ? '<article class="card"><h3>The Matrix (1999)</h3><a href="/film/matrix">x</a></article>' : '<p>Aucun résultat</p>');
  });
  try {
    const p = { id: 'en', name: 'EN', baseUrl: base, headers: {}, match: { minScore: 0.8, yearTolerance: 1 },
      search: { url: '{baseUrl}/s?q={query}', item: 'article.card', title: { css: 'h3' }, link: { css: 'a', attr: 'href' } } };
    const r = await scraper.search(p, { type: 'movie', title: 'Matrix', originalTitle: 'The Matrix', year: '1999' });
    assert.ok(r.best && r.best.link.endsWith('/film/matrix'));
    assert.strictEqual(r.query, 'The Matrix');
  } finally {
    srv.close();
  }
});

test('mémoire des correspondances : la disponibilité alimente la lecture', async () => {
  const { MatchMemory } = require('../src/main/resolver/match-memory');
  const matches = new MatchMemory();
  const repo = { activeProviders: () => [{ id: 'a', name: 'A', types: ['movie'] }], providersFor: () => [{ id: 'a', name: 'A', types: ['movie'] }] };
  const av = new Availability(repo, { matches, search: async () => ({ best: { link: 'https://a/film/dune', title: 'Dune' } }) });
  av.check([{ type: 'movie', tmdbId: 7, title: 'Dune' }]);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(matches.get({ type: 'movie', tmdbId: 7 }).link, 'https://a/film/dune');

  let received = null;
  const cache = new StreamCache({}, { matches, resolve: (_r, _m, opts) => { received = opts.matches; return new Promise(() => {}); } });
  cache.prefetch({ type: 'movie', tmdbId: 7 });
  assert.strictEqual(received, matches);
});

test('préchargement : ouvrir une fiche arrête la préparation en survol d\'un autre titre', () => {
  const f = fakeResolver();
  const cache = new StreamCache({}, { resolve: f.resolve });
  cache.prefetch({ type: 'movie', tmdbId: 1 }, 'hover');
  cache.prefetch({ type: 'movie', tmdbId: 2 }, 'page');
  assert.strictEqual(f.calls[0].signal.aborted, true);
  cache.prefetch({ type: 'movie', tmdbId: 3 }, 'hover');
  cache.prefetch({ type: 'movie', tmdbId: 3 }, 'page');
  assert.strictEqual(f.calls[2].signal.aborted, false, 'même titre : la préparation continue');
});

test('animes : sources « Animes » en premier pour un anime, ignorées pour les autres titres', () => {
  const { providersFor } = require('../src/main/sources/repository');
  const ep = { urlTemplate: '{link}/{season}/{episode}' };
  const list = [
    { id: 'films', types: ['movie'] },
    { id: 'series', types: ['tv'], episodes: ep },
    { id: 'anime', types: ['anime'], episodes: ep },
    { id: 'anime-films', types: ['anime'] },
    { id: 'tout', types: ['movie', 'tv', 'anime'], episodes: ep },
  ];
  const ids = (m) => providersFor(list, m).map((p) => p.id);
  assert.deepStrictEqual(ids({ type: 'tv', anime: true }), ['anime', 'tout', 'series']);
  assert.deepStrictEqual(ids({ type: 'movie', anime: true }), ['anime', 'anime-films', 'tout', 'films']);
  assert.deepStrictEqual(ids({ type: 'tv' }), ['series', 'tout']);
  assert.deepStrictEqual(ids({ type: 'movie' }), ['films', 'tout']);
  assert.deepStrictEqual(validateProvider({ ...example.providers[0], types: ['anime'] }), []);
  assert.ok(validateProvider({ ...example.providers[0], types: ['manga'] }).length > 0);
});

test('disponibilité : une seule recherche par source pour toute la liste', async () => {
  const providers = [
    { id: 'a', name: 'A', types: ['movie', 'tv'], episodes: {}, match: { minScore: 0.8, yearTolerance: 1 } },
    { id: 'b', name: 'B', types: ['movie'], match: { minScore: 0.8, yearTolerance: 1 } },
  ];
  const repo = { activeProviders: () => providers, providersFor: (m) => providers.filter((p) => p.types.includes(m.type)) };
  const sitePages = {
    a: [{ title: 'Naruto Shippuden', link: 'a/shippuden', year: '2007' }, { title: 'Naruto (2002)', link: 'a/naruto' }],
    b: [{ title: 'Boruto: Naruto the Movie', link: 'b/boruto-film', year: '2015' }],
  };
  let pageCalls = 0, titleCalls = 0;
  const results = [];
  let done = null;
  const av = new Availability(repo, {
    emit: (ch, d) => (ch === 'availability:done' ? (done = d) : results.push(d)),
    searchQuery: async (p) => { pageCalls++; return sitePages[p.id]; },
    search: async () => { titleCalls++; return { best: null }; },
    secondPass: 2,
  });
  const items = [
    { type: 'tv', tmdbId: 1, title: 'Naruto Shippuden', year: '2007' },
    { type: 'tv', tmdbId: 2, title: 'Naruto', year: '2002' },
    { type: 'movie', tmdbId: 3, title: 'Boruto: Naruto the Movie', year: '2015' },
    ...Array.from({ length: 17 }, (_, k) => ({ type: 'movie', tmdbId: 100 + k, title: `Autre ${k}`, year: '2010' })),
  ];
  av.check(items, 'naruto');
  for (let k = 0; k < 50 && !done; k++) await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(pageCalls, 2, 'une page de recherche par source');
  assert.strictEqual(titleCalls, 2 * 2, 'seconde passe limitée aux 2 premiers non trouvés (sur leurs 2 sources)');
  const byKey = Object.fromEntries(results.map((r) => [r.key, r]));
  assert.strictEqual(byKey['tv:1'].available, true);
  assert.strictEqual(byKey['tv:2'].available, true);
  assert.strictEqual(byKey['movie:3'].provider, 'B');
  assert.strictEqual(results.length, 20);
  assert.strictEqual(done.available, 3);
});

test('correspondance : séries avec saison dans le titre, année de saison, titre romaji', () => {
  const m = { minScore: 0.8, yearTolerance: 1 };
  const ok = (media, r, ry) => !!scraper.pickBest([{ title: r, link: 'x', year: ry }], media, m);
  assert.ok(ok({ type: 'tv', title: 'Jujutsu Kaisen', year: '2020' }, 'Jujutsu Kaisen Saison 2', '2023'), 'année de saison tolérée pour une série');
  assert.ok(!ok({ type: 'movie', title: 'Dune', year: '2021' }, 'Dune', '1984'), 'mais pas pour un film');
  assert.ok(ok({ type: 'tv', title: "L'Attaque des Titans", originalTitle: '進撃の巨人', altTitles: ['Shingeki no Kyojin', 'Attack on Titan'], year: '2013' }, 'Shingeki no Kyojin (VOSTFR)'));
  assert.deepStrictEqual(scraper.titlesOf({ title: 'A', originalTitle: '進撃の巨人', altTitles: ['B'] }), ['A', 'B']);
});

test('disponibilité : une source en erreur est signalée et réessayée, pas « introuvable » d\'office', async () => {
  const p = { id: 'a', name: 'Site A', types: ['movie'], match: { minScore: 0.8, yearTolerance: 1 } };
  const repo = { activeProviders: () => [p], providersFor: (m) => (m.type === 'movie' ? [p] : []) };
  const events = [];
  let titleSearches = 0;
  const av = new Availability(repo, {
    emit: (ch, d) => events.push([ch, d]),
    searchQuery: async () => { throw new Error('HTTP 403 sur site-a.org'); },
    search: async (_p, media) => { titleSearches++; return { best: media.title === 'Dune' ? { link: 'x', title: 'Dune' } : null }; },
  });
  av.check([{ type: 'movie', tmdbId: 1, title: 'Dune', year: '2021' }, { type: 'tv', tmdbId: 2, title: 'Dune: Prophecy' }], 'dune');
  for (let k = 0; k < 50 && !events.some(([c]) => c === 'availability:done'); k++) await new Promise((r) => setTimeout(r, 5));
  const res = Object.fromEntries(events.filter(([c]) => c === 'availability:result').map(([, d]) => [d.key, d]));
  assert.strictEqual(titleSearches, 1, 'seconde passe malgré la page en erreur');
  assert.strictEqual(res['movie:1'].available, true);
  assert.strictEqual(res['tv:2'].reason, 'no-source');
  const done = events.find(([c]) => c === 'availability:done')[1];
  assert.deepStrictEqual(done.errors, [{ provider: 'Site A', error: 'HTTP 403 sur site-a.org' }]);
  assert.strictEqual(done.noSource, 1);
});

test('diagnostic : raisons de rejet par source et par titre', async () => {
  const films = { id: 'f', name: 'Films', types: ['movie'], search: { url: '{baseUrl}/s?q={query}' }, baseUrl: 'https://f.org', match: { minScore: 0.8, yearTolerance: 1 } };
  const series = { id: 's', name: 'Séries', types: ['tv'], episodes: {}, search: { url: '{baseUrl}/s?q={query}' }, baseUrl: 'https://s.org', match: { minScore: 0.8, yearTolerance: 1 } };
  const repo = { activeProviders: () => [films, series], providersFor: (m) => [films, series].filter((p) => p.types.includes(m.type)) };
  const av = new Availability(repo, {
    searchQuery: async (p) => (p.id === 'f' ? [{ title: 'Dune (2020)', link: 'f/dune' }, { title: 'Dunkerque', link: 'f/dk', year: '2017' }] : []),
  });
  const d = await av.diagnose([
    { type: 'movie', tmdbId: 1, title: 'Dune', year: '2021' },
    { type: 'movie', tmdbId: 2, title: 'Dune', year: '1984' },
    { type: 'movie', tmdbId: 3, title: 'Inception', year: '2010' },
  ], 'dune');
  const f = d.sources.find((s) => s.id === 'f');
  assert.strictEqual(f.url, 'https://f.org/s?q=dune');
  assert.strictEqual(f.count, 2);
  assert.deepStrictEqual(f.titles.map((t) => t.status), ['ok', 'year', 'title']);
  assert.strictEqual(f.titles[1].best.yearDiff, 36);
  assert.deepStrictEqual(d.sources.find((s) => s.id === 's').titles.map((t) => t.status), ['not-covered', 'not-covered', 'not-covered']);
});
