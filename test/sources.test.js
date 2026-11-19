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
