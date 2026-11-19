package fr.robinrahoual.rrstreaming.resolver

import fr.robinrahoual.rrstreaming.sources.MediaRequest
import java.util.concurrent.ConcurrentHashMap

/**
 * Mémoire des correspondances titre TMDB → page sur une source.
 * Remplie par la vérification de disponibilité (recherche) et par chaque résolution :
 * la résolution suivante du même titre commence par cette source et saute la recherche.
 */
class MatchMemory(private val ttlMs: Long = 6 * 3_600_000L) {
    data class Match(val providerId: String, val link: String, val title: String, val at: Long = System.currentTimeMillis())

    private val map = ConcurrentHashMap<String, Match>()

    private fun keyOf(m: MediaRequest) = "${m.type.name.lowercase()}:${m.tmdbId}"

    fun remember(media: MediaRequest, providerId: String, link: String, title: String) {
        map[keyOf(media)] = Match(providerId, link, title)
    }

    fun get(media: MediaRequest): Match? = map[keyOf(media)]?.takeIf { System.currentTimeMillis() - it.at < ttlMs }

    fun forget(media: MediaRequest) { map.remove(keyOf(media)) }

    fun clear() = map.clear()
}
