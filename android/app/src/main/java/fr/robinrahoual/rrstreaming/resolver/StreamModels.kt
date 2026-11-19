package fr.robinrahoual.rrstreaming.resolver

/** Type de flux détecté. */
enum class StreamType { HLS, DASH, PROGRESSIVE }

/** Un flux vidéo intercepté, avec les headers nécessaires pour le relire hors WebView. */
data class StreamCandidate(
    val url: String,
    val type: StreamType,
    /** Headers à rejouer côté lecteur : User-Agent, Referer, Origin, Cookie. */
    val headers: Map<String, String>,
    /** Page qui a déclenché la requête. */
    val sourcePage: String,
    /** Ordre de détection (0 = premier vu). */
    val order: Int,
)

sealed class ResolveResult {
    data class Success(val best: StreamCandidate, val all: List<StreamCandidate>) : ResolveResult()
    data class Timeout(val pageUrl: String, val elapsedMs: Long) : ResolveResult()
    data class Failure(val pageUrl: String, val reason: String, val cause: Throwable? = null) : ResolveResult()
}

class ResolveException(message: String) : Exception(message)

/** Lecture de headers insensible à la casse. */
internal fun Map<String, String>.getIgnoreCase(key: String): String? =
    entries.firstOrNull { it.key.equals(key, ignoreCase = true) }?.value
