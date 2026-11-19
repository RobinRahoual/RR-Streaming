package fr.robinrahoual.rrstreaming.sources

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class TitleMatcherTest {
    private val match = MatchSpec(minScore = 0.8, yearTolerance = 1)

    @Test fun `ignore accents, casse et articles`() {
        assertTrue(TitleMatcher.similarity("Le Fabuleux Destin d'Amélie Poulain", "fabuleux destin d amelie poulain") > 0.95)
    }

    @Test fun `choisit le bon titre et la bonne annee`() {
        val results = listOf(
            SearchResult("Dune (1984)", "a", "1984"),
            SearchResult("Dune", "b", "2021"),
            SearchResult("Dune : Deuxième partie", "c", "2024"),
        )
        val best = TitleMatcher.pickBest(results, MediaRequest(1, MediaKind.MOVIE, "Dune", year = 2021), match)
        assertEquals("b", best?.result?.link)
        assertNull(TitleMatcher.pickBest(results, MediaRequest(2, MediaKind.MOVIE, "Inception", year = 2010), match))
    }
}

class SourceScraperTest {
    private lateinit var server: MockWebServer
    private val scraper = SourceScraper(OkHttpClient())

    @Before fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                return when {
                    path.startsWith("/recherche") -> MockResponse().setBody(
                        """<article class="card"><h3>The Office</h3><span class="m">Sortie 2005</span><a href="/serie/the-office">voir</a></article>
                           <article class="card"><h3>The Office (UK)</h3><span class="m">2001</span><a href="/serie/uk">voir</a></article>""",
                    )
                    path == "/serie/the-office" -> MockResponse().setBody(
                        """<li class="ep"><span class="s">Saison 2</span><span class="e">Épisode 3</span><a href="/ep/2-3">x</a></li>""",
                    )
                    path == "/film/1" -> MockResponse().setBody("""<iframe id="player" src="//cdn.exemple.net/embed/1"></iframe>""")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
    }

    @After fun tearDown() = server.shutdown()

    private fun provider(episodes: EpisodeSpec) = SourceProvider(
        id = "test", name = "Test", baseUrl = server.url("/").toString(),
        search = SearchSpec(
            url = "{baseUrl}/recherche?q={query}", item = "article.card",
            title = Selector("h3"), link = Selector("a", "href"), year = Selector(".m", regex = "(\\d{4})"),
        ),
        episodes = episodes,
        player = PlayerSpec(iframe = Selector("iframe#player", "src")),
    )

    @Test fun `recherche puis episode par gabarit`() = runTest {
        val p = provider(EpisodeSpec(urlTemplate = "{link}/saison-{season}/episode-{episode2}"))
        val out = scraper.search(p, MediaRequest(1, MediaKind.TV, "The Office", year = 2005))
        assertEquals(server.url("/serie/the-office").toString(), out.best?.result?.link)
        assertEquals("/recherche?q=The%20Office", server.takeRequest().path)
        assertEquals(
            server.url("/serie/the-office/saison-2/episode-03").toString(),
            scraper.episodeUrl(p, out.best!!.result.link, 2, 3),
        )
    }

    @Test fun `episode par analyse de la page`() = runTest {
        val p = provider(EpisodeSpec(item = "li.ep", season = Selector(".s"), episode = Selector(".e"), link = Selector("a", "href")))
        val url = scraper.episodeUrl(p, server.url("/serie/the-office").toString(), 2, 3)
        assertEquals(server.url("/ep/2-3").toString(), url)
    }

    @Test fun `iframe du lecteur avec referer`() = runTest {
        val p = provider(EpisodeSpec(urlTemplate = "{link}/{season}/{episode}"))
        val page = scraper.playerPage(p, server.url("/film/1").toString())
        assertEquals("https://cdn.exemple.net/embed/1", page.url)
        assertEquals(server.url("/film/1").toString(), page.referer)
    }
}
