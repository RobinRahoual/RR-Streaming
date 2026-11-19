package fr.robinrahoual.rrstreaming.sources

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.jsoup.select.QueryParser

object SourceValidator {
    const val SUPPORTED_SCHEMA = 1
    private val ID = Regex("^[a-z0-9][a-z0-9_-]{1,47}$")

    fun validate(doc: SourcesDocument): List<String> {
        val e = mutableListOf<String>()
        if (doc.schemaVersion !in 1..SUPPORTED_SCHEMA) {
            e += "schemaVersion ${doc.schemaVersion} non supportée (max $SUPPORTED_SCHEMA)"
        }
        if (doc.providers.isEmpty()) e += "providers : la liste est vide"
        doc.providers.groupBy { it.id }.filterValues { it.size > 1 }.keys.forEach {
            e += "providers : id en double « $it »"
        }
        doc.providers.forEachIndexed { i, p -> e += validateProvider(p, "providers[$i]") }
        return e
    }

    fun validateProvider(p: SourceProvider, path: String = "provider"): List<String> {
        val e = mutableListOf<String>()
        if (!ID.matches(p.id)) e += "$path.id : « ${p.id} » invalide (a-z, 0-9, - et _ ; 2 à 48 caractères)"
        if (p.name.isBlank()) e += "$path.name : requis"
        if (p.priority !in 0..100) e += "$path.priority : doit être entre 0 et 100"
        val base = p.baseUrl.toHttpUrlOrNull()
        if (base == null) e += "$path.baseUrl : URL http(s) invalide"
        if (p.types.isEmpty()) e += "$path.types : au moins un type"

        with(p.search) {
            if ("{query}" !in url) e += "$path.search.url : doit contenir {query}"
            if (url.replace("{baseUrl}", p.baseUrl).replace("{query}", "x").toHttpUrlOrNull() == null) {
                e += "$path.search.url : URL invalide après substitution"
            }
            e.css(item, "$path.search.item")
            e.selector(title, "$path.search.title")
            e.selector(link, "$path.search.link")
            year?.let { e.selector(it, "$path.search.year") }
            poster?.let { e.selector(it, "$path.search.poster") }
        }

        if (p.match.minScore !in 0.0..1.0) e += "$path.match.minScore : entre 0 et 1"

        if (MediaKind.TV in p.types) {
            val ep = p.episodes
            when {
                ep == null -> e += "$path.episodes : requis pour les séries (types contient \"tv\")"
                ep.urlTemplate != null || !ep.params.isNullOrEmpty() -> {
                    // {season} et {episode} peuvent être dans l'adresse ou dans les paramètres
                    val all = listOfNotNull(ep.urlTemplate).plus(ep.params.orEmpty().values).joinToString(" ")
                    if ("{season" !in all || "{episode" !in all) {
                        e += "$path.episodes : {season} et {episode} doivent apparaître dans urlTemplate ou params"
                    }
                }
                ep.item == null || ep.episode == null || ep.link == null ->
                    e += "$path.episodes : urlTemplate, params ou (item + episode + link) requis"
                else -> {
                    e.css(ep.item, "$path.episodes.item")
                    ep.season?.let { e.selector(it, "$path.episodes.season") }
                    e.selector(ep.episode, "$path.episodes.episode")
                    e.selector(ep.link, "$path.episodes.link")
                    if (ep.pageTemplate != null && "{season" !in ep.pageTemplate) e += "$path.episodes.pageTemplate : doit contenir {season}"
                }
            }
        }

        p.player.iframe?.let { e.selector(it, "$path.player.iframe") }
        p.player.extraHlsPattern?.let { e.regex(it, "$path.player.extraHlsPattern") }
        p.player.timeoutMs?.let { if (it !in 3_000..60_000) e += "$path.player.timeoutMs : entre 3000 et 60000" }
        return e
    }

    private fun MutableList<String>.selector(s: Selector, path: String) {
        if (s.css.isNotBlank()) css(s.css, "$path.css")
        if (s.attr.isBlank()) add("$path.attr : vide")
        s.regex?.let { regex(it, "$path.regex") }
    }

    private fun MutableList<String>.css(query: String, path: String) {
        if (query.isBlank()) { add("$path : sélecteur vide"); return }
        runCatching { QueryParser.parse(query) }.onFailure { add("$path : sélecteur CSS invalide (${it.message})") }
    }

    private fun MutableList<String>.regex(pattern: String, path: String) {
        runCatching { Regex(pattern) }.onFailure { add("$path : regex invalide (${it.message})") }
    }
}
