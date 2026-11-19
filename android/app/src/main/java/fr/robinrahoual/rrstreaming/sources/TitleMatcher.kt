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

    /** Coefficient de Dice sur bigrammes, entre 0 et 1. */
    fun similarity(a: String?, b: String?): Double {
        val x = normalize(a).replace(" ", "")
        val y = normalize(b).replace(" ", "")
        if (x.isEmpty() || y.isEmpty()) return 0.0
        if (x == y) return 1.0
        if (x.length < 2 || y.length < 2) return 0.0
        val grams = HashMap<String, Int>()
        for (i in 0 until x.length - 1) grams[x.substring(i, i + 2)] = (grams[x.substring(i, i + 2)] ?: 0) + 1
        var hits = 0
        for (i in 0 until y.length - 1) {
            val g = y.substring(i, i + 2)
            val n = grams[g] ?: 0
            if (n > 0) { grams[g] = n - 1; hits++ }
        }
        return 2.0 * hits / (x.length - 1 + y.length - 1)
    }

    fun yearOf(s: String?): Int? = s?.let { Regex("""\b(19|20)\d{2}\b""").find(it)?.value?.toInt() }

    /** Meilleur résultat au-dessus de minScore, en respectant la tolérance sur l'année. */
    fun pickBest(results: List<SearchResult>, media: MediaRequest, match: MatchSpec): ScoredResult? {
        val titles = listOfNotNull(media.title, media.originalTitle).filter { it.isNotBlank() }
        var best: ScoredResult? = null
        for (r in results) {
            var score = titles.maxOfOrNull { similarity(it, r.title) } ?: 0.0
            val ry = yearOf(r.year)
            if (media.year != null && ry != null) {
                val diff = kotlin.math.abs(media.year - ry)
                if (diff > match.yearTolerance) continue
                if (diff == 0) score += 0.05 // départage les remakes
            }
            if (score >= match.minScore && (best == null || score > best.score)) best = ScoredResult(r, score)
        }
        return best
    }
}

/** Ce qu'on cherche : un film ou un épisode issu de TMDB. */
data class MediaRequest(
    val tmdbId: Int,
    val type: MediaKind,
    val title: String,
    val originalTitle: String? = null,
    val year: Int? = null,
    val season: Int? = null,
    val episode: Int? = null,
)

data class SearchResult(val title: String, val link: String, val year: String?)
data class ScoredResult(val result: SearchResult, val score: Double)
