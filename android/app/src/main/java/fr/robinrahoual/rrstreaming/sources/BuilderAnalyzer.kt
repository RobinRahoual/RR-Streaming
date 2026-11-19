package fr.robinrahoual.rrstreaming.sources

import kotlinx.serialization.Serializable
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element

/**
 * Assistant de création de source : détecte automatiquement la liste de résultats d'une page de recherche
 * (élément répété avec lien + titre + affiche + année) et les iframes de lecteur.
 * Port de src/main/sources/builder.js (version bureau) : mêmes sélecteurs proposés, même API JSON.
 */
class BuilderAnalyzer(private val scraper: SourceScraper) {

    @Serializable
    data class ResultSelectors(
        val item: String,
        val title: Selector,
        val link: Selector,
        val poster: Selector? = null,
        val year: Selector? = null,
    )

    @Serializable data class Sample(val title: String, val link: String, val year: String? = null, val poster: String? = null)
    @Serializable data class Candidate(val selectors: ResultSelectors, val count: Int, val samples: List<Sample>)
    @Serializable data class IframeInfo(val selector: Selector, val src: String, val host: String, val likely: Boolean, val trailer: Boolean)
    @Serializable data class AnalyzeResult(val url: String, val pageTitle: String?, val candidates: List<Candidate>, val iframes: List<IframeInfo>)

    @Serializable data class BestMatch(val title: String, val link: String, val year: String? = null, val score: Double)
    @Serializable data class TestResult(val results: List<Sample>, val best: BestMatch?)

    suspend fun analyzeUrl(raw: String, headers: Map<String, String> = emptyMap()): AnalyzeResult {
        val url = raw.trim().let { if ("://" in it) it else "https://$it" }
        require(url.toHttpUrlOrNull() != null) { "Adresse invalide" }
        val doc = scraper.fetchDocument(url, headers)
        return analyze(doc)
    }

    fun analyze(html: String, pageUrl: String): AnalyzeResult = analyze(Jsoup.parse(html, pageUrl))

    fun analyze(doc: Document): AnalyzeResult {
        val pageUrl = doc.location()
        return AnalyzeResult(
            url = pageUrl,
            pageTitle = doc.title().trim().ifEmpty { null },
            candidates = findResultCandidates(doc, pageUrl),
            iframes = findIframes(doc, pageUrl),
        )
    }

    /** Recherche réelle avec une source en cours de création. */
    suspend fun test(provider: SourceProvider, title: String, year: String?, type: MediaKind): TestResult {
        val errors = SourceValidator.validateProvider(provider)
        if (errors.isNotEmpty()) throw SourceValidationException(errors)
        require(title.isNotBlank()) { "Indiquez un titre à rechercher" }
        val out = scraper.search(provider, MediaRequest(0, type, title.trim(), title.trim(), TitleMatcher.yearOf(year)))
        return TestResult(
            results = out.results.take(8).map { Sample(it.title, it.link, it.year) },
            best = out.best?.let { BestMatch(it.result.title, it.result.link, it.result.year, it.score) },
        )
    }

    // ------------------------------------------------------------------ Résultats

    private data class ItemInfo(
        val titleSel: Selector,
        val linkSel: Selector,
        val posterSel: Selector?,
        val yearSel: Selector?,
        val fromHeading: Boolean,
        val hasImg: Boolean,
    )

    private data class Scored(val candidate: Candidate, val score: Double, val linkKey: String)

    private fun inspectItem(el: Element, pageUrl: String): ItemInfo? {
        val isAnchor = el.tagName() == "a"
        val anchors = if (isAnchor) listOf(el) else el.select("a[href]").toList()
        if (anchors.isEmpty()) return null

        val anchor = anchors.firstOrNull { it.select("h1,h2,h3,h4,h5,h6,img,[class*=title]").isNotEmpty() } ?: anchors.first()
        val link = absolute(anchor.attr("href"), pageUrl) ?: return null
        if (link.substringBefore('#') == pageUrl.substringBefore('#')) return null

        var title: String? = null
        var titleSel: Selector? = null
        val heading = descendants(el, "h1,h2,h3,h4,h5,h6").firstOrNull() ?: descendants(el, "[class*=title]").firstOrNull()
        val img = descendants(el, "img").firstOrNull()
        when {
            heading != null && heading.text().isNotBlank() -> { title = heading.text(); titleSel = Selector(signature(heading)) }
            anchor.attr("title").isNotBlank() -> { title = anchor.attr("title"); titleSel = Selector(if (isAnchor) "" else "a", "title") }
            img != null && img.attr("alt").isNotBlank() -> { title = img.attr("alt"); titleSel = Selector("img", "alt") }
            anchor.text().isNotBlank() -> { title = anchor.text(); titleSel = Selector(if (isAnchor) "" else "a") }
        }
        val clean = title?.replace(WS, " ")?.trim()
        if (clean == null || clean.length < 2 || clean.length > 150 || titleSel == null) return null

        val linkSel = when {
            isAnchor -> Selector("", "href")
            anchor === anchors.first() -> Selector("a", "href")
            goodClasses(anchor).isNotEmpty() -> Selector(signature(anchor), "href")
            else -> Selector("a:has(h1,h2,h3,h4,h5,h6,img)", "href")
        }

        val imgAttr = img?.let { i -> IMG_ATTRS.firstOrNull { a -> i.attr(a).isNotBlank() && !i.attr(a).startsWith("data:") } }
        val posterSel = imgAttr?.let { Selector("img", it) }

        val own = descendants(el, "*").firstOrNull { YEAR_ALONE.matches(it.ownText().replace(WS, " ").trim()) }
        val yearSel = when {
            own != null && goodClasses(own).isNotEmpty() -> Selector(signature(own), "text", YEAR_REGEX)
            YEAR.containsMatchIn(el.text()) -> Selector("", "text", YEAR_REGEX)
            else -> null
        }
        return ItemInfo(titleSel, linkSel, posterSel, yearSel, heading != null, imgAttr != null)
    }

    private fun findResultCandidates(doc: Document, pageUrl: String): List<Candidate> {
        val groups = LinkedHashMap<String, MutableList<Element>>()
        for (el in doc.body().select("*")) {
            if (el === doc.body() || el.tagName() in SKIP_TAGS) continue
            val parent = el.parent() ?: continue
            if (el.tagName() != "a" && el.select("a[href]").isEmpty()) continue
            groups.getOrPut("${signature(parent)} > ${signature(el)}") { mutableListOf() }.add(el)
        }

        val scored = mutableListOf<Scored>()
        for ((key, members) in groups) {
            if (members.size < 2 || members.size > 300) continue
            val sample = members.take(40)
            val valid = sample.mapNotNull { inspectItem(it, pageUrl) }
            if (valid.size.toDouble() / sample.size < 0.6) continue
            val proto = valid.first()

            val ownSig = signature(members.first())
            val itemSel = if (goodClasses(members.first()).isNotEmpty() && doc.select(ownSig).size <= members.size * 1.5) ownSig else key
            val withPoster = proto.posterSel != null && valid.count { it.hasImg }.toDouble() / valid.size >= 0.5
            val withYear = proto.yearSel != null && valid.count { it.yearSel != null }.toDouble() / valid.size >= 0.5
            val selectors = ResultSelectors(
                item = itemSel,
                title = proto.titleSel,
                link = proto.linkSel,
                poster = if (withPoster) proto.posterSel else null,
                year = if (withYear) proto.yearSel else null,
            )

            // Vérification avec le vrai moteur d'extraction.
            val results = runCatching { doc.select(selectors.item) }.getOrNull().orEmpty().mapNotNull { el ->
                val t = SourceScraper.extract(el, selectors.title) ?: return@mapNotNull null
                val l = SourceScraper.extract(el, selectors.link) ?: return@mapNotNull null
                Sample(
                    title = t, link = l,
                    year = selectors.year?.let { SourceScraper.extract(el, it) },
                    poster = selectors.poster?.let { p -> SourceScraper.extract(el, p)?.let { absolute(it, pageUrl) } },
                )
            }
            if (results.size < 2) continue

            val classes = goodClasses(members.first()).joinToString(" ")
            val uniqueLinks = results.map { it.link }.toSet().size.toDouble() / results.size
            val avgTitle = results.sumOf { it.title.length }.toDouble() / results.size
            val inNav = members.first().parents().any { runCatching { it.`is`(NAV_ANCESTORS) }.getOrDefault(false) }
            val score = minOf(results.size, 30) * uniqueLinks *
                (if (withPoster) 1.6 else 1.0) *
                (if (proto.fromHeading) 1.3 else 1.0) *
                (if (withYear) 1.15 else 1.0) *
                (if (classes.isNotEmpty()) 1.1 else 1.0) *
                (if (members.first().tagName() in setOf("article", "li") || SEMANTIC.containsMatchIn(classes)) 1.25 else 1.0) *
                (if (GRID.containsMatchIn(classes)) 0.85 else 1.0) *
                (if (avgTitle < 4) 0.3 else 1.0) *
                (if (inNav) 0.15 else 1.0)
            scored += Scored(Candidate(selectors, results.size, results.take(5)), score, results.take(5).joinToString("|") { it.link })
        }

        scored.sortByDescending { it.score }
        val top = scored.firstOrNull()?.score ?: 0.0
        val seen = HashSet<String>()
        return scored.filter { it.score >= top * 0.2 && seen.add(it.linkKey) }.take(MAX_CANDIDATES).map { it.candidate }
    }

    // ------------------------------------------------------------------ Iframes

    private fun findIframes(doc: Document, pageUrl: String): List<IframeInfo> {
        val pageHost = pageUrl.toHttpUrlOrNull()?.host
        return doc.select("iframe").mapNotNull { el ->
            val srcAttr = el.attr("src")
            val attr = when {
                srcAttr.isNotBlank() && !srcAttr.startsWith("about:") && !srcAttr.startsWith("javascript:") -> "src"
                el.attr("data-src").isNotBlank() -> "data-src"
                else -> return@mapNotNull null
            }
            val rawSrc = el.attr(attr).let { if (it.startsWith("//")) "https:$it" else it }
            val src = absolute(rawSrc, pageUrl) ?: return@mapNotNull null
            val host = src.toHttpUrlOrNull()?.host ?: return@mapNotNull null
            if (AD_HOSTS.containsMatchIn(host)) return@mapNotNull null
            val id = el.id()
            val css = when {
                id.isNotBlank() -> if (SIMPLE_IDENT.matches(id)) "iframe#$id" else "iframe[id=\"${id.replace("\"", "")}\"]"
                goodClasses(el).isNotEmpty() -> signature(el)
                else -> "iframe[$attr*=\"$host\"]"
            }
            val trailer = TRAILER_HOSTS.containsMatchIn(host)
            val likely = !trailer && (PLAYER_HINT.containsMatchIn(src) || host != pageHost)
            IframeInfo(Selector(css, attr), src, host, likely, trailer)
        }.sortedByDescending { it.likely }.take(6)
    }

    // ------------------------------------------------------------------ Utilitaires

    private fun descendants(el: Element, css: String): List<Element> = el.select(css).filter { it !== el }

    private fun goodClasses(el: Element): List<String> =
        el.classNames().filter {
            SIMPLE_IDENT.matches(it) && it.length < 40 && !Regex("\\d{3,}").containsMatchIn(it) && !BAD_CLASS.containsMatchIn(it)
        }.take(2)

    private fun signature(el: Element): String = el.tagName() + goodClasses(el).joinToString("") { ".$it" }

    private fun absolute(url: String?, base: String): String? {
        if (url.isNullOrBlank()) return null
        val resolved = base.toHttpUrlOrNull()?.resolve(url.trim()) ?: return null
        return resolved.toString()
    }

    companion object {
        private const val MAX_CANDIDATES = 3
        const val YEAR_REGEX = "(?:^|\\D)((?:19|20)\\d{2})(?:\\D|$)"
        private val YEAR = Regex(YEAR_REGEX)
        private val YEAR_ALONE = Regex("^\\D{0,12}(19|20)\\d{2}\\D{0,12}$")
        private val WS = Regex("\\s+")
        private val SIMPLE_IDENT = Regex("^[a-zA-Z_-][a-zA-Z0-9_-]*$")
        private val BAD_CLASS = Regex("^(active|selected|current|hover|show|open|is-|js-|swiper-slide-)")
        private val SEMANTIC = Regex("card|item|movie|film|serie|show|result|post|entry|poster", RegexOption.IGNORE_CASE)
        private val GRID = Regex("(^|\\s)(col|row|grid|container|wrapper)", RegexOption.IGNORE_CASE)
        private val TRAILER_HOSTS = Regex("(^|\\.)(youtube\\.com|youtube-nocookie\\.com|youtu\\.be|vimeo\\.com|dailymotion\\.com)$", RegexOption.IGNORE_CASE)
        private val AD_HOSTS = Regex("doubleclick|googlesyndication|ads?\\.|facebook|twitter|disqus|recaptcha", RegexOption.IGNORE_CASE)
        private val PLAYER_HINT = Regex("embed|player|video|stream|watch", RegexOption.IGNORE_CASE)
        private val SKIP_TAGS = setOf("script", "style", "noscript", "svg", "path", "head", "meta", "link", "template", "option", "select", "form", "input", "button")
        private const val NAV_ANCESTORS = "header, nav, footer, aside, [role=navigation], .menu, .navbar, .nav, .pagination, .breadcrumb, .footer, .header"
        private val IMG_ATTRS = listOf("data-src", "data-lazy-src", "data-original", "data-srcset", "src")
    }
}
