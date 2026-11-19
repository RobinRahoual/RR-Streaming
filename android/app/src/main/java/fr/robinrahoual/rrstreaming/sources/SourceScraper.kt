package fr.robinrahoual.rrstreaming.sources

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import org.jsoup.Jsoup
import org.jsoup.nodes.Element
import java.io.IOException
import java.net.URLEncoder

/**
 * Applique la configuration d'une source (sélecteurs CSS du JSON) : recherche, page d'épisode, iframe du lecteur.
 * Pur Kotlin + OkHttp + Jsoup (aucune dépendance Android) : testable sur la JVM.
 */
class SourceScraper(
    private val http: OkHttpClient,
    /** Rendu JavaScript (WebView) pour les sources `render: true` ; null hors Android (tests JVM). */
    private val renderer: PageRenderer? = null,
) {

    val canRender: Boolean get() = renderer != null

    data class SearchOutcome(val results: List<SearchResult>, val best: ScoredResult?)
    data class PlayerPage(val url: String, val referer: String?)

    /** Cherche le média sur la source et renvoie le meilleur résultat (ou null). */
    suspend fun search(provider: SourceProvider, media: MediaRequest): SearchOutcome {
        val s = provider.search
        val query = fill(
            s.query,
            mapOf(
                "title" to media.title,
                "originalTitle" to (media.originalTitle ?: media.title),
                "year" to (media.year?.toString() ?: ""),
                "type" to if (media.type == MediaKind.TV) "tv" else "movie",
            ),
        ).trim()
        val url = fill(s.url, mapOf("baseUrl" to provider.baseUrl.trimEnd('/'), "query" to encode(query)))
        val doc = fetch(url, provider.headers, provider.render)
        val results = doc.select(s.item).mapNotNull { el ->
            val title = extract(el, s.title) ?: return@mapNotNull null
            val link = extract(el, s.link) ?: return@mapNotNull null
            SearchResult(title, link, extract(el, s.year))
        }
        return SearchOutcome(results, TitleMatcher.pickBest(results, media, provider.match))
    }

    /** URL de la page de l'épisode pour une série. */
    suspend fun episodeUrl(provider: SourceProvider, showUrl: String, season: Int, episode: Int): String {
        val ep = provider.episodes ?: throw IOException("Cette source ne gère pas les séries")
        val pad = { n: Int -> n.toString().padStart(2, '0') }
        val vars = mapOf(
            "link" to showUrl.trimEnd('/'),
            "season" to season.toString(), "episode" to episode.toString(),
            "season2" to pad(season), "episode2" to pad(episode),
        )
        if (ep.urlTemplate != null || !ep.params.isNullOrEmpty()) {
            val base = ep.urlTemplate?.let { fill(it, vars) } ?: showUrl
            val params = ep.params.orEmpty()
            if (params.isEmpty()) return base
            // Saison / épisode passés en paramètres d'adresse : ?s={season}&ep={episode}
            val url = base.toHttpUrlOrNull() ?: throw IOException("Adresse de série invalide : $base")
            return url.newBuilder().apply { params.forEach { (k, v) -> setQueryParameter(k, fill(v, vars)) } }.build().toString()
        }
        val doc = fetch(showUrl, provider.headers, provider.render)
        for (el in doc.select(ep.item!!)) {
            val s = firstInt(extract(el, ep.season!!))
            val e = firstInt(extract(el, ep.episode!!))
            if (s == season && e == episode) extract(el, ep.link!!)?.let { return it }
        }
        throw IOException("Épisode S${pad(season)}E${pad(episode)} introuvable")
    }

    /** Si la source définit player.iframe, renvoie l'URL de l'iframe du lecteur (sinon la page elle-même). */
    suspend fun playerPage(provider: SourceProvider, pageUrl: String): PlayerPage {
        val sel = provider.player.iframe ?: return PlayerPage(pageUrl, null)
        val doc = fetch(pageUrl, provider.headers, provider.render)
        val src = extract(doc, sel) ?: return PlayerPage(pageUrl, null) // iframe injectée en JS : la WebView s'en charge
        return PlayerPage(if (src.startsWith("//")) "https:$src" else src, doc.location())
    }

    /** Télécharge et parse une page (utilisé par l'assistant de création). */
    suspend fun fetchDocument(url: String, headers: Map<String, String> = emptyMap(), render: Boolean = false) = fetch(url, headers, render)

    // ------------------------------------------------------------------ Interne

    private suspend fun fetch(url: String, headers: Map<String, String>, render: Boolean = false): org.jsoup.nodes.Document {
        if (render) {
            val r = renderer ?: throw IOException("Rendu JavaScript indisponible")
            val page = r.render(url, headers)
            return Jsoup.parse(page.html, page.url)
        }
        return fetchStatic(url, headers)
    }

    private suspend fun fetchStatic(url: String, headers: Map<String, String>) = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(url)
            .header("User-Agent", DEFAULT_UA)
            .header("Accept", "text/html,application/xhtml+xml")
            .apply { headers.forEach { (k, v) -> header(k, v) } }
            .build()
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw IOException("HTTP ${resp.code} sur ${resp.request.url.host}")
            val source = resp.body?.source() ?: throw IOException("Réponse vide")
            if (source.request(MAX_HTML_BYTES + 1)) throw IOException("Page trop volumineuse")
            Jsoup.parse(source.readUtf8(), resp.request.url.toString())
        }
    }

    companion object {
        const val DEFAULT_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
        private const val MAX_HTML_BYTES = 5L * 1024 * 1024
        private val URL_ATTRS = setOf("href", "src", "data-src", "data-href", "data-url", "poster")
        private val WS = Regex("\\s+")

        /** Applique un sélecteur { css, attr, regex } à un élément. */
        fun extract(el: Element, sel: Selector?): String? {
            if (sel == null) return null
            val target = if (sel.css.isBlank()) el else el.selectFirst(sel.css) ?: return null
            var value = when (val attr = sel.attr.ifBlank { "text" }) {
                "text" -> target.text()
                "html" -> target.html()
                else -> if (attr.lowercase() in URL_ATTRS) target.absUrl(attr).ifBlank { target.attr(attr) } else target.attr(attr)
            }.replace(WS, " ").trim()
            sel.regex?.let { r ->
                val m = Regex(r).find(value) ?: return null
                value = (m.groups[1]?.value ?: m.value).trim()
            }
            return value.ifEmpty { null }
        }

        fun fill(template: String, vars: Map<String, String>): String =
            Regex("""\{(\w+)\}""").replace(template) { m -> vars[m.groupValues[1]] ?: m.value }

        /** Encodage façon encodeURIComponent (espaces en %20). */
        fun encode(s: String): String = URLEncoder.encode(s, "UTF-8").replace("+", "%20")

        private fun firstInt(s: String?): Int? = s?.let { Regex("\\d+").find(it)?.value?.toIntOrNull() }
    }
}
