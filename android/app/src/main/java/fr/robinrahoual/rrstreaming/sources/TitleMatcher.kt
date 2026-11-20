package fr.robinrahoual.rrstreaming.sources

import java.text.Normalizer

/**
 * Correspondance entre un titre TMDB et les résultats d'une source.
 * Même algorithme que la version bureau (src/main/sources/scraper.js) : Dice sur bigrammes + année.
 */
object TitleMatcher {

    private val ARTICLES = Regex("""\b(the|le|la|les|l|a|an)\b""")
    private val NON_ALNUM = Regex("[^a-z0-9]+")
    private val MARKS = Regex("\\p{Mn}+")
    private val SPACES = Regex("\\s+")

    fun normalize(s: String?): String =
        Normalizer.normalize(s.orEmpty(), Normalizer.Form.NFD)
            .replace(MARKS, "")
            .lowercase()
            .replace("&", " et ")
            .replace(NON_ALNUM, " ")
            .replace(ARTICLES, " ")
            .replace(SPACES, " ")
            .trim()

    private fun dice(x: String, y: String): Double {
        if (x.isEmpty() || y.isEmpty()) return 0.0
        if (x == y) return 1.0
        if (x.length < 2 || y.length < 2) return 0.0
        val grams = HashMap<String, Int>()
        for (i in 0 until x.length - 1) { val g = x.substring(i, i + 2); grams[g] = (grams[g] ?: 0) + 1 }
        var hits = 0
        for (i in 0 until y.length - 1) {
            val g = y.substring(i, i + 2)
            val n = grams[g] ?: 0
            if (n > 0) { grams[g] = n - 1; hits++ }
        }
        return 2.0 * hits / (x.length - 1 + y.length - 1)
    }

    // Mots ajoutés par les sites autour du titre (« Dune (2021) VF HD en streaming »).
    private val NOISE = Regex("""\b(vf|vff|vfq|vo|vost|vostfr|subfrench|truefrench|french|multi|hd|fhd|uhd|4k|hdr|1080p?|720p?|480p?|bluray|webrip|web|dl|streaming|en streaming|film complet|complet|gratuit|regarder|voir)\b""")
    private val YEAR_IN_TITLE = Regex("""\b(19|20)\d{2}\b""")

    /** Titre d'un résultat sans année ni mentions de langue/qualité, et l'année trouvée dans le titre. */
    // « Saison 2 », « Season 3 », « S2 », « Partie 1 » : le titre de la série suffit pour la correspondance.
    private val SEASON_NOISE = Regex("""\b(saison|season|s)\s*\d{1,2}\b|\b(partie|part|cour)\s*\d\b|\b\d{1,2}(e|eme|ème|nd|rd|th)?\s*saison\b""", RegexOption.IGNORE_CASE)
    private val LATIN = Regex("""^[\p{IsLatin}\p{N}\p{P}\p{S}\s]+$""")

    /** Titres à comparer : titre, titre original (alphabet latin), titres alternatifs. */
    fun titlesOf(media: MediaRequest): List<String> =
        (listOf(media.title, media.originalTitle) + media.altTitles).filterNotNull().filter { it.isNotBlank() && LATIN.matches(it) }.distinct()

    fun cleanResultTitle(raw: String?): Pair<String, Int?> {
        val text = raw.orEmpty().replace(SEASON_NOISE, " ")
        val year = YEAR_IN_TITLE.find(text)?.value?.toInt()
        val cleaned = normalize(text.replace(YEAR_IN_TITLE, " ")).replace(NOISE, " ").replace(SPACES, " ").trim()
        return cleaned to year
    }

    /** Similarité titre TMDB / titre d'un résultat (0..1), en ignorant année, langue et qualité ajoutées par le site. */
    fun similarity(tmdbTitle: String?, resultTitle: String?): Double {
        val a = normalize(tmdbTitle)
        val b = cleanResultTitle(resultTitle).first
        if (a.isEmpty() || b.isEmpty()) return 0.0
        var score = maxOf(dice(a.replace(" ", ""), b.replace(" ", "")), dice(a.replace(" ", ""), normalize(resultTitle).replace(" ", "")))
        val ta = a.split(" ")
        val tb = b.split(" ").toSet()
        val extra = tb.size - ta.toSet().size
        // Tous les mots du titre présents, avec un mot en plus (deux si le titre en a plusieurs).
        if (ta.all { it in tb } && extra <= (if (ta.size > 1) 2 else 1)) score = maxOf(score, if (ta.size > 1) 0.92 else 0.86)
        return minOf(1.0, score)
    }

    fun yearOf(s: String?): Int? = s?.let { Regex("""\b(19|20)\d{2}\b""").find(it)?.value?.toInt() }

    /**
     * Meilleur résultat au-dessus de minScore. Films : l'année doit correspondre (± tolérance).
     * Séries : l'année ne sert qu'à départager (les sites affichent souvent l'année de la saison).
     */
    fun pickBest(results: List<SearchResult>, media: MediaRequest, match: MatchSpec): ScoredResult? {
        val titles = titlesOf(media).ifEmpty { listOf(media.title) }
        var best: ScoredResult? = null
        for (r in results) {
            var score = titles.maxOf { similarity(it, r.title) }
            val ry = yearOf(r.year) ?: cleanResultTitle(r.title).second
            if (media.year != null && ry != null) {
                val diff = kotlin.math.abs(media.year - ry)
                if (diff == 0) score += 0.05 // départage les remakes
                else if (diff > match.yearTolerance) {
                    if (media.type != MediaKind.TV) continue
                    score -= 0.04
                }
            }
            if (score >= match.minScore && (best == null || score > best.score)) best = ScoredResult(r, score)
        }
        return best
    }
}

/** Ce qu'on cherche : un film ou un épisode issu de TMDB. */
data class MediaRequest(
    val tmdbId: Int,
    /** MOVIE ou TV (TMDB). */
    val type: MediaKind,
    val title: String,
    val originalTitle: String? = null,
    val year: Int? = null,
    val season: Int? = null,
    val episode: Int? = null,
    /** Anime selon TMDB : genre Animation (16) et langue d'origine japonaise. */
    val anime: Boolean = false,
    /** Titres alternatifs TMDB (/alternative_titles), ex. nom romaji d'un anime. */
    val altTitles: List<String> = emptyList(),
)

data class SearchResult(val title: String, val link: String, val year: String?)
data class ScoredResult(val result: SearchResult, val score: Double)
