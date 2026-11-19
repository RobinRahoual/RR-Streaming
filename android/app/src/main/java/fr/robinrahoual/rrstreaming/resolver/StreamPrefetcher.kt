package fr.robinrahoual.rrstreaming.resolver

import fr.robinrahoual.rrstreaming.sources.MediaKind
import fr.robinrahoual.rrstreaming.sources.MediaRequest
import fr.robinrahoual.rrstreaming.sources.SourceRepository
import fr.robinrahoual.rrstreaming.sources.SourceScraper
import fr.robinrahoual.rrstreaming.sources.activeProviders
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import java.util.concurrent.ConcurrentHashMap

/** État du flux d'un média, affiché sous le bouton « Lire ». */
sealed interface StreamState {
    data object Idle : StreamState
    data class Resolving(val provider: String? = null, val message: String? = null) : StreamState
    data class Ready(val resolution: PlaybackResolution.Ready) : StreamState
    data object NoSources : StreamState
    data class Failed(val failures: List<ProviderFailure>) : StreamState
}

fun MediaRequest.streamKey() = "${type.name.lowercase()}:$tmdbId:${season ?: 0}:${episode ?: 0}"

/**
 * Préchargement des flux (même principe que src/main/resolver/stream-cache.js) :
 * la résolution démarre à l'ouverture d'une fiche ; « Lire » réutilise le résultat ou attend la résolution en cours.
 * Ouvrir une autre fiche annule la précédente si le lecteur ne l'attend pas. Flux valables 8 min.
 *
 * Fiche :   prefetcher.prefetch(media)  puis  prefetcher.state(media).collectAsState()
 * Lecture : prefetcher.resolve(media)   (PlaybackViewModel)
 */
class StreamPrefetcher(
    private val resolver: TmdbSourceResolver,
    private val scope: CoroutineScope,
    private val ttlMs: Long = 8 * 60_000,
    private val failTtlMs: Long = 60_000,
) {
    private class Entry(val key: String) {
        val state = MutableStateFlow<StreamState>(StreamState.Resolving())
        lateinit var deferred: Deferred<PlaybackResolution>
        var doneAt = 0L
        @Volatile var waiters = 0
    }

    private val entries = ConcurrentHashMap<String, Entry>()
    private val slots = ConcurrentHashMap<String, String>()
    private val idle = MutableStateFlow<StreamState>(StreamState.Idle)

    fun state(media: MediaRequest): StateFlow<StreamState> = entries[media.streamKey()]?.state?.asStateFlow() ?: idle.asStateFlow()

    @Synchronized
    fun prefetch(media: MediaRequest, slot: String = "page"): StateFlow<StreamState> {
        val key = media.streamKey()
        slots.put(slot, key)?.takeIf { it != key && it !in slots.values }?.let { prev ->
            entries[prev]?.takeIf { it.state.value is StreamState.Resolving && it.waiters == 0 }?.let { cancel(it) }
        }
        val e = entries[key]?.takeIf { usable(it) } ?: start(media)
        return e.state.asStateFlow()
    }

    /** Pour la lecture : résultat en cache, résolution en cours, ou nouvelle résolution (fresh = flux expiré). */
    suspend fun resolve(media: MediaRequest, fresh: Boolean = false): Pair<PlaybackResolution, Boolean> {
        val e = synchronized(this) {
            val cur = entries[media.streamKey()]
            if (fresh || cur == null || !usable(cur) || cur.state.value is StreamState.Failed) start(media) else cur
        }
        val wasReady = e.state.value is StreamState.Ready
        e.waiters++
        try {
            return e.deferred.await() to wasReady
        } finally {
            e.waiters--
        }
    }

    @Synchronized
    fun clear() {
        entries.values.filter { it.waiters == 0 }.forEach { it.deferred.cancel() }
        entries.clear()
    }

    private fun usable(e: Entry): Boolean {
        val age = System.currentTimeMillis() - e.doneAt
        return when (e.state.value) {
            is StreamState.Resolving -> true
            is StreamState.Ready -> age < ttlMs
            is StreamState.Failed, StreamState.NoSources -> age < failTtlMs
            StreamState.Idle -> false
        }
    }

    private fun cancel(e: Entry) {
        e.deferred.cancel()
        e.state.value = StreamState.Idle
        entries.remove(e.key, e)
    }

    private fun start(media: MediaRequest): Entry {
        val key = media.streamKey()
        entries[key]?.takeIf { it.state.value is StreamState.Resolving && it.waiters == 0 }?.let { cancel(it) }
        val e = Entry(key)
        e.deferred = scope.async {
            val r = resolver.resolve(media) { p -> e.state.update { StreamState.Resolving(p.provider, p.message) } }
            e.doneAt = System.currentTimeMillis()
            e.state.value = when (r) {
                is PlaybackResolution.Ready -> StreamState.Ready(r)
                PlaybackResolution.NoSources -> StreamState.NoSources
                is PlaybackResolution.Failed -> StreamState.Failed(r.failures)
            }
            r
        }
        entries[key] = e
        return e
    }
}

/**
 * Disponibilité légère pour les résultats de recherche : le titre est-il trouvé sur au moins une source ?
 * (recherche seulement, sans extraction du flux). Une nouvelle liste annule les vérifications en attente.
 */
class AvailabilityChecker(
    private val repo: SourceRepository,
    private val scraper: SourceScraper,
    private val scope: CoroutineScope,
    private val ttlMs: Long = 30 * 60_000,
    concurrency: Int = 2,
) {
    data class Result(val available: Boolean, val provider: String?)

    private val cache = ConcurrentHashMap<String, Pair<Long, Result>>()
    private val semaphore = Semaphore(concurrency)
    private var job: Job? = null

    /** Résultats par clé "type:tmdbId", mis à jour au fil des réponses. */
    val results = MutableStateFlow<Map<String, Result>>(emptyMap())

    fun keyOf(m: MediaRequest) = "${m.type.name.lowercase()}:${m.tmdbId}"

    fun check(list: List<MediaRequest>) {
        job?.cancel()
        if (repo.store.value.activeProviders().isEmpty()) return
        job = scope.launch {
            list.take(20).forEach { media ->
                launch {
                    val key = keyOf(media)
                    cache[key]?.takeIf { System.currentTimeMillis() - it.first < ttlMs }?.let { (_, r) ->
                        results.update { it + (key to r) }
                        return@launch
                    }
                    val r = semaphore.withPermit { lookup(media) }
                    cache[key] = System.currentTimeMillis() to r
                    results.update { it + (key to r) }
                }
            }
        }
    }

    fun clear() { cache.clear(); results.value = emptyMap() }

    private suspend fun lookup(media: MediaRequest): Result {
        for (p in repo.store.value.activeProviders(media.type)) {
            try {
                if (scraper.search(p, media).best != null) return Result(true, p.name)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) { /* source injoignable : suivante */ }
        }
        return Result(false, null)
    }
}
