package fr.robinrahoual.rrstreaming.resolver

import fr.robinrahoual.rrstreaming.sources.MediaKind
import fr.robinrahoual.rrstreaming.sources.MediaRequest
import fr.robinrahoual.rrstreaming.sources.SourceRepository
import fr.robinrahoual.rrstreaming.sources.SourceScraper
import fr.robinrahoual.rrstreaming.sources.SourceProvider
import fr.robinrahoual.rrstreaming.sources.SearchResult
import fr.robinrahoual.rrstreaming.sources.TitleMatcher
import fr.robinrahoual.rrstreaming.sources.activeProviders
import fr.robinrahoual.rrstreaming.sources.providersFor
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
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
        if (slot == "page") {
            // Ouverture d'une fiche : les préparations en survol d'autres titres n'ont plus d'intérêt.
            slots.entries.filter { it.key != "page" && it.value != key }.forEach { (other, k) ->
                entries[k]?.takeIf { it.state.value is StreamState.Resolving && it.waiters == 0 }?.let { cancel(it) }
                slots.remove(other)
            }
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
 * Disponibilité des résultats de recherche (badges « Disponible / Introuvable »), même algorithme que la version bureau :
 * 1. une seule recherche par source avec le texte tapé, à laquelle tous les résultats TMDB sont comparés ;
 * 2. seconde passe (titre, titres alternatifs) pour les premiers résultats non trouvés seulement.
 * Une nouvelle recherche annule la précédente.
 */
class AvailabilityChecker(
    private val repo: SourceRepository,
    private val scraper: SourceScraper,
    private val scope: CoroutineScope,
    /** Les titres trouvés ici sont réutilisés par la lecture (pas de nouvelle recherche). */
    private val matches: MatchMemory? = null,
    private val ttlMs: Long = 30 * 60_000,
    private val missTtlMs: Long = 5 * 60_000,
    private val concurrency: Int = 3,
    private val secondPass: Int = 6,
    private val fullPage: Int = 15,
) {
    /** reason : "no-source" quand aucune source active ne couvre ce type de contenu. */
    data class Result(val available: Boolean, val provider: String?, val reason: String? = null)

    private val cache = ConcurrentHashMap<String, Pair<Long, Result>>()
    private var job: Job? = null

    /** Sources en erreur lors de la dernière vérification (nom → message). */
    val errors = MutableStateFlow<Map<String, String>>(emptyMap())

    /** Résultats par clé "type:tmdbId", mis à jour au fil des réponses. */
    val results = MutableStateFlow<Map<String, Result>>(emptyMap())
    /** true pendant la vérification. */
    val running = MutableStateFlow(false)

    fun keyOf(m: MediaRequest) = "${m.type.name.lowercase()}:${m.tmdbId}"

    fun check(list: List<MediaRequest>, query: String) {
        job?.cancel()
        results.value = emptyMap()
        if (repo.store.value.activeProviders().isEmpty()) return
        val now = System.currentTimeMillis()
        val pending = list.take(20).filter { m ->
            val hit = cache[keyOf(m)]
            val fresh = hit != null && now - hit.first < (if (hit.second.available) ttlMs else missTtlMs)
            if (fresh) results.update { it + (keyOf(m) to hit!!.second) }
            !fresh
        }
        if (pending.isEmpty()) return
        job = scope.launch {
            running.value = true
            try { run(query.trim(), pending) } finally { running.value = false }
        }
    }

    fun cancel() { job?.cancel() }

    fun clear() { cache.clear(); results.value = emptyMap() }

    private fun report(media: MediaRequest, r: Result) {
        cache[keyOf(media)] = System.currentTimeMillis() to r
        results.update { it + (keyOf(media) to r) }
    }

    private suspend fun run(query: String, items: List<MediaRequest>) = coroutineScope {
        val store = repo.store.value
        val providers = items.flatMap { store.providersFor(it) }.distinctBy { it.id }
        val gate = Semaphore(concurrency)

        // 1. Une recherche par source avec le texte tapé. Une source en erreur n'est pas une page vide :
        //    elle est signalée et la seconde passe la réessaie.
        errors.value = emptyMap()
        val pages: Map<String, List<SearchResult>> = if (query.isEmpty()) emptyMap() else providers.map { p ->
            async {
                gate.withPermit {
                    try {
                        p.id to scraper.searchQuery(p, query)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Throwable) {
                        errors.update { it + (p.name to (e.message ?: e.javaClass.simpleName)) }
                        null
                    }
                }
            }
        }.awaitAll().filterNotNull().toMap()

        val missing = mutableListOf<MediaRequest>()
        for (media in items) {
            if (store.providersFor(media).isEmpty()) { report(media, Result(false, null, "no-source")); continue }
            val found = store.providersFor(media).firstNotNullOfOrNull { p ->
                pages[p.id]?.let { TitleMatcher.pickBest(it, media, p.match) }?.let { p to it }
            }
            if (found != null) {
                matches?.remember(media, found.first.id, found.second.result.link, found.second.result.title)
                report(media, Result(true, found.first.name))
            } else missing += media
        }

        // 2. Seconde passe limitée. Inutile si la page n'était pas pleine et que le titre contient déjà les mots tapés.
        val words = TitleMatcher.normalize(query).split(" ").filter { it.isNotEmpty() }
        fun covered(media: MediaRequest, p: SourceProvider): Boolean {
            val page = pages[p.id] ?: return false
            if (page.size >= fullPage || words.isEmpty()) return false
            val t = TitleMatcher.normalize(media.title).split(" ")
            return words.all { it in t }
        }
        missing.drop(secondPass).forEach { report(it, Result(false, null)) }
        val retryGate = Semaphore(maxOf(1, concurrency - 1))
        missing.take(secondPass).map { media ->
            async {
                retryGate.withPermit {
                    for (p in store.providersFor(media)) {
                        if (covered(media, p)) continue
                        val best = try {
                            scraper.search(p, media, maxQueries = 2, skipQueries = listOfNotNull(query.ifEmpty { null })).best
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Throwable) {
                            errors.update { it + (p.name to (e.message ?: e.javaClass.simpleName)) }
                            null
                        }
                        if (best != null) {
                            matches?.remember(media, p.id, best.result.link, best.result.title)
                            report(media, Result(true, p.name))
                            return@withPermit
                        }
                    }
                    report(media, Result(false, null))
                }
            }
        }.awaitAll()
    }
}
