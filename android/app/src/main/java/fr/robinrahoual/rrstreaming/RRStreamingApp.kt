package fr.robinrahoual.rrstreaming

import android.app.Application
import fr.robinrahoual.rrstreaming.resolver.AvailabilityChecker
import fr.robinrahoual.rrstreaming.resolver.MatchMemory
import fr.robinrahoual.rrstreaming.resolver.MediaUrlInterceptor
import fr.robinrahoual.rrstreaming.resolver.StreamPrefetcher
import fr.robinrahoual.rrstreaming.resolver.TmdbSourceResolver
import fr.robinrahoual.rrstreaming.resolver.WebViewPageRenderer
import fr.robinrahoual.rrstreaming.sources.SourceRepository
import fr.robinrahoual.rrstreaming.sources.SourceScraper
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.distinctUntilChangedBy
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * Point d'assemblage des modules (remplaçable par Hilt/Koin si le projet en utilise un).
 * Déclarée dans AndroidManifest.xml (android:name=".RRStreamingApp").
 */
class RRStreamingApp : Application() {

    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val http: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .followRedirects(true)
            .followSslRedirects(true)
            .build()
    }

    val sources: SourceRepository by lazy { SourceRepository(this, http, appScope) }

    val scraper: SourceScraper by lazy { SourceScraper(http, WebViewPageRenderer(this)) }

    val resolver: TmdbSourceResolver by lazy {
        TmdbSourceResolver(sources, scraper, { config -> MediaUrlInterceptor(this, config) }, matches)
    }

    /** Titres déjà trouvés sur une source (recherche → lecture sans nouvelle recherche). */
    val matches = MatchMemory()

    /** Recherche du flux lancée dès l'ouverture d'une fiche (voir StreamPrefetcher). */
    val prefetcher: StreamPrefetcher by lazy { StreamPrefetcher(resolver, appScope) }

    /** Badges « Disponible / Introuvable » des résultats de recherche. */
    val availability: AvailabilityChecker by lazy { AvailabilityChecker(sources, scraper, appScope, matches) }

    override fun onCreate() {
        super.onCreate()
        appScope.launch {
            sources.load()
            sources.syncIfStale()
        }
        // Les sources changent : les flux préparés et les disponibilités sont à refaire.
        appScope.launch {
            sources.store.distinctUntilChangedBy { it.revision }.drop(1).collect {
                prefetcher.clear()
                availability.clear()
                matches.clear()
            }
        }
    }
}
