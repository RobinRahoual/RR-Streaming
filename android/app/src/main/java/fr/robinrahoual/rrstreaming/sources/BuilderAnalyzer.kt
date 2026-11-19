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
    @Serializable data class AnalyzeResult(
        val url: String,
        val pageTitle: String?,
        val candidates: List<Candidate>,
        val iframes: List<IframeInfo>,
        /** true : la page a dû être rendue avec JavaScript ; la source devra utiliser `render: true`. */
        val rendered: Boolean = false,
    )

    @Serializable data class EpisodeSample(val episode: Int, val season: Int? = null, val link: String)
    @Serializable data class EpisodesResult(
        val spec: EpisodeSpec,
        val count: Int,
        val samples: List<EpisodeSample>,
        val warning: String? = null,
        val rendered: Boolean = false,
    )

    @Serializable data class BestMatch(val title: String, val link: String, val year: String? = null, val score: Double)
    @Serializable data class TestResult(val results: List<Sample>, val best: BestMatch?)

    /**
     * Analyse une page. Si le HTML brut ne donne rien (site construit en JavaScript, ou visite
     * automatique refusée), la page est rendue dans une WebView invisible puis réanalysée.
     */
    suspend fun analyzeUrl(raw: String, headers: Map<String, String> = emptyMap(), render: Boolean = false): AnalyzeResult {
        val url = raw.trim().let { if ("://" in it) it else "https://$it" }
        require(url.toHttpUrlOrNull() != null) { "Adresse invalide" }
        if (!render) {
            val static = runCatching { analyze(scraper.fetchDocument(url, headers)) }
            val useful = static.getOrNull()?.let { it.candidates.isNotEmpty() || it.iframes.isNotEmpty() } == true
            if (useful || !scraper.canRender) return static.getOrThrow()
        }
        return analyze(scraper.fetchDocument(url, headers, render = true)).copy(rendered = true)
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


    // ------------------------------------------------------------------ Liste d'épisodes (adresses non prévisibles)

    /**
     * Étape « séries » quand l'adresse d'un épisode n'est pas déductible de celle de la série (ex. /episode/48213) :
     * repère l'épisode d'exemple sur la page de la série et en déduit la liste et ses sélecteurs.
     */
    suspend fun analyzeEpisodes(
        showUrl: String, episodeUrl: String, season: Int, episode: Int,
        headers: Map<String, String> = emptyMap(), render: Boolean = false,
    ): EpisodesResult {
        require(showUrl.toHttpUrlOrNull() != null && episodeUrl.toHttpUrlOrNull() != null) { "Adresse invalide" }
        if (!render) {
            val static = runCatching { analyzeEpisodes(scraper.fetchDocument(showUrl, headers), showUrl, episodeUrl, season, episode) }
            if (static.isSuccess || !scraper.canRender) return static.getOrThrow()
        }
        val doc = scraper.fetchDocument(showUrl, headers, render = true)
        return analyzeEpisodes(doc, showUrl, episodeUrl, season, episode).copy(rendered = true)
    }

    fun analyzeEpisodes(doc: Document, showUrl: String, episodeUrl: String, season: Int, episode: Int): EpisodesResult {
        val pageUrl = doc.location()
        val anchor = doc.select("a[href]").firstOrNull { a -> absolute(a.attr("href"), pageUrl)?.let { sameUrl(it, episodeUrl) } == true }
            ?: throw IllegalArgumentException("L'épisode d'exemple n'apparaît pas sur la page de la série. Vérifiez les deux adresses, ou ouvrez la page de la série qui liste ses épisodes.")

        var item: Element? = null
        var node: Element? = anchor
        while (node != null && node.tagName() != "body") {
            val parent = node.parent() ?: break
            val sig = signature(node)
            val siblings = parent.children().filter { c -> signature(c) == sig && (c.tagName() == "a" || c.select("a[href]").isNotEmpty()) }
            if (siblings.size >= 2) { item = node; break }
            node = parent
        }
        val it0 = item ?: throw IllegalArgumentException("La page de la série ne présente pas de liste d'épisodes reconnaissable. Utilisez le mode avancé (JSON).")

        val own = signature(it0)
        val key = "${signature(it0.parent()!!)} > $own"
        val itemSel = if (goodClasses(it0).isNotEmpty() && doc.select(own).size <= doc.select(key).size * 1.5) own else key
        val firstA = if (it0.tagName() == "a") it0 else descendants(it0, "a[href]").firstOrNull()
        val link = when {
            it0.tagName() == "a" -> Selector("", "href")
            firstA === anchor -> Selector("a", "href")
            else -> Selector(if (goodClasses(anchor).isNotEmpty()) signature(anchor) else "a", "href")
        }

        val epOpt = numberSelector(it0, episode, null)
            ?: throw IllegalArgumentException("Le numéro $episode n'apparaît pas dans l'épisode d'exemple sur la page de la série. Vérifiez le numéro de l'épisode.")
        var spec = EpisodeSpec(item = itemSel, episode = epOpt.selector, link = link)

        data class Row(val episode: Int, val link: String, val el: Element)
        val rows = doc.select(itemSel).mapNotNull { el ->
            val e = SourceScraper.extract(el, epOpt.selector)?.let { Regex("\\d+").find(it)?.value?.toIntOrNull() } ?: return@mapNotNull null
            val l = SourceScraper.extract(el, link) ?: return@mapNotNull null
            Row(e, l, el)
        }
        if (rows.none { sameUrl(it.link, episodeUrl) }) {
            throw IllegalArgumentException("La liste détectée ne permet pas de retrouver l'épisode d'exemple. Utilisez le mode avancé (JSON).")
        }

        var warning: String? = null
        if (rows.count { it.episode == episode } > 1) {
            val seOpt = numberSelector(it0, season, epOpt)
                ?: throw IllegalArgumentException("La page liste plusieurs saisons mais le numéro de saison $season n'apparaît pas dans l'épisode d'exemple. Utilisez le mode avancé (JSON).")
            spec = spec.copy(season = seOpt.selector)
        } else {
            val params = seasonParamsFrom(showUrl, season)
            when {
                params != null -> spec = spec.copy(pageParams = params)
                season != 1 -> warning = "La page de la série semble n'afficher qu'une saison. RR Streaming trouvera les épisodes affichés par défaut sur cette page."
                else -> warning = "Pour les autres saisons, RR Streaming utilisera les épisodes affichés sur la page de la série. Si le site a une page par saison, refaites ce test avec un épisode de la saison 2."
            }
        }

        val samples = rows.take(8).map { r ->
            EpisodeSample(
                episode = r.episode,
                season = spec.season?.let { s -> SourceScraper.extract(r.el, s)?.let { Regex("\\d+").find(it)?.value?.toIntOrNull() } },
                link = r.link,
            )
        }
        return EpisodesResult(spec, rows.size, samples, warning)
    }

    private data class NumberOption(val selector: Selector, val text: String?, val index: Int, val attr: String?, val len: Int, val classed: Boolean)

    /** Sélecteur qui extrait `value` de l'élément (texte + k-ième nombre, ou attribut data-*). `avoid` : option déjà prise. */
    private fun numberSelector(item: Element, value: Int, avoid: NumberOption?): NumberOption? {
        val nodes = listOf(item) + descendants(item, "*")
        val options = mutableListOf<NumberOption>()
        for (n in nodes) {
            if (n.tagName() in SKIP_TAGS) continue
            val text = n.text().replace(WS, " ").trim()
            if (text.isEmpty() || (n !== item && text.length > 80)) continue
            Regex("\\d+").findAll(text).map { it.value }.forEachIndexed { k, x ->
                if (x.toIntOrNull() != value) return@forEachIndexed
                if (avoid != null && avoid.attr == null && avoid.text == text && avoid.index == k) return@forEachIndexed
                var css = ""
                if (n !== item) {
                    css = signature(n)
                    if (descendants(item, css).firstOrNull() !== n) css = n.tagName()
                    if (descendants(item, css).firstOrNull() !== n) return@forEachIndexed
                }
                val regex = if (k == 0) "(\\d+)" else "^(?:\\D*\\d+){$k}\\D*?(\\d+)"
                options += NumberOption(Selector(css, "text", regex), text, k, null, text.length, n !== item && goodClasses(n).isNotEmpty())
            }
        }
        for (n in nodes) {
            for (a in n.attributes()) {
                if (!a.key.startsWith("data-") || a.value.trim() != value.toString() || avoid?.attr == a.key) continue
                val css = if (n === item) "" else signature(n)
                if (n === item || descendants(item, css).firstOrNull() === n) options += NumberOption(Selector(css, a.key), null, 0, a.key, 0, true)
            }
        }
        return options.sortedWith(compareByDescending<NumberOption> { it.classed }.thenBy { it.len }).firstOrNull()
    }

    private fun seasonParamsFrom(showUrl: String, season: Int): Map<String, String>? {
        val u = showUrl.toHttpUrlOrNull() ?: return null
        for (name in u.queryParameterNames) {
            val v = u.queryParameter(name) ?: continue
            if (Regex("^(s|sa|saison|season|sea|ss)$", RegexOption.IGNORE_CASE).matches(name) && v.toIntOrNull() == season) return mapOf(name to "{season}")
        }
        return null
    }

    private fun sameUrl(a: String, b: String): Boolean {
        fun norm(u: String): String {
            val x = u.toHttpUrlOrNull() ?: return u.lowercase()
            val path = x.encodedPath.trimEnd('/')
            val query = x.encodedQuery?.let { "?$it" } ?: ""
            return (x.host.removePrefix("www.") + path + query).lowercase()
        }
        return norm(a) == norm(b)
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
            // Les résultats ne sont jamais dans l'en-tête, le menu ou le pied de page.
            if (members.first().parents().any { runCatching { it.`is`(NAV_ANCESTORS) }.getOrDefault(false) }) continue
            val score = minOf(results.size, 30) * uniqueLinks *
                (if (withPoster) 1.6 else 1.0) *
                (if (proto.fromHeading) 1.3 else 1.0) *
                (if (withYear) 1.15 else 1.0) *
                (if (classes.isNotEmpty()) 1.1 else 1.0) *
                (if (members.first().tagName() in setOf("article", "li") || SEMANTIC.containsMatchIn(classes)) 1.25 else 1.0) *
                (if (GRID.containsMatchIn(classes)) 0.85 else 1.0) *
                (if (avgTitle < 4) 0.3 else 1.0)
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
