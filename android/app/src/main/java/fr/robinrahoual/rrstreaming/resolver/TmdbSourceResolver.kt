package fr.robinrahoual.rrstreaming.resolver

import android.util.Log
import fr.robinrahoual.rrstreaming.sources.MediaKind
import fr.robinrahoual.rrstreaming.sources.MediaRequest
import fr.robinrahoual.rrstreaming.sources.SourceProvider
import fr.robinrahoual.rrstreaming.sources.SourceRepository
import fr.robinrahoual.rrstreaming.sources.SourceScraper
import fr.robinrahoual.rrstreaming.sources.SearchResult
import fr.robinrahoual.rrstreaming.sources.activeProviders
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

data class ResolveProgress(val provider: String, val message: String, val failed: Boolean = false)
data class ProviderFailure(val provider: String, val error: String)

sealed class PlaybackResolution {
    data class Ready(
        val stream: StreamCandidate,
        /** Autres flux détectés, à essayer si le premier est illisible. */
        val alternatives: List<StreamCandidate>,
        val providerId: String,
        val providerName: String,
        val matchedTitle: String,
    ) : PlaybackResolution()

    /** Aucune source active pour ce type de contenu : renvoyer l'utilisateur vers l'onglet Sources. */
    data object NoSources : PlaybackResolution()

    data class Failed(val failures: List<ProviderFailure>) : PlaybackResolution()
}

/**
 * Média TMDB → flux lisible.
 *
 * Pour chaque source active (par priorité décroissante) :
 *  1. recherche du titre avec les sélecteurs du JSON, choix du meilleur résultat (titre + année) ;
 *  2. séries : page de l'épisode (urlTemplate ou parsing de la page) ;
 *  3. iframe du lecteur si `player.iframe` est défini ;
 *  4. MediaUrlInterceptor avec les options `player` (hôtes autorisés, motif HLS, timeout).
 * S'arrête à la première source qui fournit un flux.
 *
 * @param interceptorFactory crée l'intercepteur pour une config donnée (permet d'y passer un hostContainer).
 */
class TmdbSourceResolver(
    private val repo: SourceRepository,
    private val scraper: SourceScraper,
    private val interceptorFactory: (InterceptorConfig) -> MediaUrlInterceptor,
    /** Correspondances déjà trouvées (recherche, lectures précédentes) : source essayée en premier, sans nouvelle recherche. */
    private val matches: MatchMemory? = null,
) {

    suspend fun resolve(
        media: MediaRequest,
        onProgress: (ResolveProgress) -> Unit = {},
    ): PlaybackResolution {
        require(media.type == MediaKind.MOVIE || (media.season != null && media.episode != null)) {
            "Une série nécessite season et episode"
        }
        var providers = repo.store.value.activeProviders(media.type)
        if (providers.isEmpty()) return PlaybackResolution.NoSources
        val known = matches?.get(media)
        if (known != null && providers.any { it.id == known.providerId }) {
            providers = providers.sortedBy { if (it.id == known.providerId) 0 else 1 }
        }

        val failures = mutableListOf<ProviderFailure>()
        for (provider in providers) {
            currentCoroutineContext().ensureActive()
            try {
                return resolveWith(provider, media, known?.takeIf { it.providerId == provider.id }) { onProgress(ResolveProgress(provider.name, it)) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                val msg = e.message ?: e.javaClass.simpleName
                Log.w(TAG, "[${provider.id}] $msg")
                if (known?.providerId == provider.id) matches?.forget(media) // correspondance périmée
                failures += ProviderFailure(provider.name, msg)
                onProgress(ResolveProgress(provider.name, "Échec : $msg", failed = true))
            }
        }
        return PlaybackResolution.Failed(failures)
    }

    private suspend fun resolveWith(
        provider: SourceProvider,
        media: MediaRequest,
        known: MatchMemory.Match?,
        step: (String) -> Unit,
    ): PlaybackResolution.Ready {
        val matched: SearchResult = if (known != null) {
            SearchResult(known.title, known.link, null)
        } else {
            step("Recherche du titre…")
            val outcome = scraper.search(provider, media)
            val best = outcome.best ?: throw ResolveStepException(
                if (outcome.results.isEmpty()) "Aucun résultat" else "${outcome.results.size} résultat(s), aucun ne correspond",
            )
            matches?.remember(media, provider.id, best.result.link, best.result.title)
            best.result
        }

        var pageUrl = matched.link
        if (media.type == MediaKind.TV) {
            val s = media.season!!
            val e = media.episode!!
            step("Épisode S${pad(s)}E${pad(e)}…")
            pageUrl = scraper.episodeUrl(provider, pageUrl, s, e)
        }

        val player = scraper.playerPage(provider, pageUrl)
        step("Analyse du lecteur…")

        val baseTimeout = provider.player.timeoutMs ?: 30_000
        fun config(timeout: Long) = InterceptorConfig(
            timeoutMs = timeout,
            userAgent = provider.headers.getIgnoreCase("User-Agent"),
            allowedHosts = provider.player.allowedHosts.toSet(),
            extraHlsPattern = provider.player.extraHlsPattern?.let { Regex(it, RegexOption.IGNORE_CASE) },
        )
        val headers = provider.headers.filterKeys { !it.equals("User-Agent", true) } +
            ("Referer" to (player.referer ?: pageUrl))

        var r = interceptorFactory(config(baseTimeout)).resolve(player.url, headers)
        if (r is ResolveResult.Timeout) {
            // Le lecteur met parfois du temps à démarrer : un second essai, plus long.
            step("Le lecteur tarde, nouvel essai…")
            r = interceptorFactory(config(baseTimeout * 3 / 2)).resolve(player.url, headers)
        }
        return when (r) {
            is ResolveResult.Success -> PlaybackResolution.Ready(
                stream = r.best,
                alternatives = r.all,
                providerId = provider.id,
                providerName = provider.name,
                matchedTitle = matched.title,
            )
            is ResolveResult.Timeout -> throw ResolveStepException("Aucun flux vidéo détecté (délai dépassé)")
            is ResolveResult.Failure -> throw ResolveStepException(r.reason)
        }
    }

    private class ResolveStepException(message: String) : Exception(message)

    companion object {
        private const val TAG = "TmdbSourceResolver"
        private fun pad(n: Int) = n.toString().padStart(2, '0')
    }
}
