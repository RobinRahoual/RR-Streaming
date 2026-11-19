package fr.robinrahoual.rrstreaming.sources

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mêmes fixtures et mêmes attentes que test/sources.test.js (version bureau). */
class BuilderAnalyzerTest {
    private val analyzer = BuilderAnalyzer(SourceScraper(OkHttpClient()))
    private fun fixture(name: String) = javaClass.getResource("/fixtures/$name")!!.readText()

    @Test fun `detecte la liste de resultats sans le menu ni le pied de page`() {
        val r = analyzer.analyze(fixture("search-page.html"), "https://cine.exemple.org/recherche?q=dune")
        assertEquals(1, r.candidates.size)
        val c = r.candidates.first()
        assertEquals("article.movie-card", c.selectors.item)
        assertEquals(listOf("2021", "1984", "2024", "2024"), c.samples.map { it.year })
        assertEquals("https://cine.exemple.org/img/dune.jpg", c.samples.first().poster)
        assertEquals("https://cine.exemple.org/film/dune-2021", c.samples.first().link)

        val provider = SourceProvider(
            id = "cine", name = "Ciné", baseUrl = "https://cine.exemple.org", types = listOf(MediaKind.MOVIE),
            search = SearchSpec(url = "{baseUrl}/recherche?q={query}", item = c.selectors.item, title = c.selectors.title,
                link = c.selectors.link, year = c.selectors.year, poster = c.selectors.poster),
        )
        assertTrue(SourceValidator.validateProvider(provider).isEmpty())
    }

    @Test fun `iframe du lecteur avant la bande-annonce`() {
        val r = analyzer.analyze(fixture("movie-page.html"), "https://cine.exemple.org/film/dune-2021")
        assertEquals(listOf("iframe#player", "iframe.trailer"), r.iframes.map { it.selector.css })
        assertEquals("data-src", r.iframes.first().selector.attr)
        assertEquals("https://lecteur.exemple.net/embed/xyz", r.iframes.first().src)
    }

    @Test fun `page construite en JavaScript - rendu puis analyse`() = runTest {
        val server = MockWebServer()
        repeat(3) { server.enqueue(MockResponse().setBody(fixture("js-search-page.html"))) }
        server.start()
        try {
            val url = server.url("/recherche?q=dune").toString()
            assertEquals(false, analyzer.analyzeUrl(url).rendered)

            val stub = object : PageRenderer {
                override suspend fun render(url: String, headers: Map<String, String>) = RenderedPage(fixture("search-page.html"), url)
            }
            val withRenderer = BuilderAnalyzer(SourceScraper(OkHttpClient(), stub))
            val r = withRenderer.analyzeUrl(url)
            assertEquals(true, r.rendered)
            assertEquals("article.movie-card", r.candidates.first().selectors.item)
        } finally {
            server.shutdown()
        }
    }
}
