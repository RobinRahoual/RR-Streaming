package fr.robinrahoual.rrstreaming.sources

/** Page rendue avec JavaScript exécuté. */
data class RenderedPage(val html: String, val url: String)

/** Affiche une page dans un navigateur invisible et renvoie son HTML final (sites construits en JavaScript). */
fun interface PageRenderer {
    suspend fun render(url: String, headers: Map<String, String>): RenderedPage
}
