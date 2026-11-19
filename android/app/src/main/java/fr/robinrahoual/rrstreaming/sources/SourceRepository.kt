package fr.robinrahoual.rrstreaming.sources

import android.content.Context
import android.util.AtomicFile
import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.SerializationException
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.util.UUID

/**
 * Source de vérité des sources : import, persistance locale, synchronisation.
 * Thread-safe. À instancier une seule fois (singleton / DI).
 */
class SourceRepository(
    context: Context,
    private val http: OkHttpClient,
    scope: CoroutineScope,
) {
    private val file = AtomicFile(File(context.filesDir, "sources_store.json"))
    private val mutex = Mutex()
    private val _store = MutableStateFlow(SourcesStore())

    val store: StateFlow<SourcesStore> = _store.asStateFlow()
    val entries: StateFlow<List<ProviderEntry>> =
        _store.map { it.providerEntries() }.stateIn(scope, SharingStarted.Eagerly, emptyList())

    // ------------------------------------------------------------------ Chargement

    suspend fun load() = mutex.withLock {
        _store.value = withContext(Dispatchers.IO) {
            runCatching {
                if (!file.baseFile.exists()) SourcesStore()
                else SourcesJson.decodeFromString<SourcesStore>(file.readFully().decodeToString())
            }.getOrElse {
                Log.e(TAG, "Store illisible, réinitialisation", it)
                SourcesStore()
            }
        }
    }

    // ------------------------------------------------------------------ Abonnements (JSON distant)

    suspend fun addSubscription(rawUrl: String): Result<Subscription> = runCatching {
        val url = normalizeUrl(rawUrl) ?: throw IllegalArgumentException("URL invalide")
        if (_store.value.subscriptions.any { it.url == url }) throw IllegalStateException("Cette liste est déjà ajoutée")

        val fetched = fetch(url, etag = null) as FetchResult.Updated
        val sub = Subscription(
            id = UUID.randomUUID().toString(),
            url = url,
            name = fetched.doc.name?.takeIf { it.isNotBlank() } ?: url.toHttpUrlOrNull()?.host ?: url,
            lastSyncAt = System.currentTimeMillis(),
            etag = fetched.etag,
            providers = fetched.doc.providers,
        )
        update { it.copy(subscriptions = it.subscriptions + sub) }
        sub
    }

    suspend fun sync(subscriptionId: String): Result<Unit> {
        val sub = _store.value.subscriptions.firstOrNull { it.id == subscriptionId }
            ?: return Result.failure(NoSuchElementException("Liste introuvable"))
        return runCatching { fetch(sub.url, sub.etag) }
            .onSuccess { res ->
                val now = System.currentTimeMillis()
                updateSubscription(subscriptionId) { s ->
                    when (res) {
                        FetchResult.NotModified -> s.copy(lastSyncAt = now, lastError = null)
                        is FetchResult.Updated -> s.copy(
                            name = res.doc.name?.takeIf { it.isNotBlank() } ?: s.name,
                            providers = res.doc.providers,
                            etag = res.etag,
                            lastSyncAt = now,
                            lastError = null,
                        )
                    }
                }
            }
            .onFailure { err ->
                // On garde les anciennes sources : une liste cassée ne vide pas l'app.
                updateSubscription(subscriptionId) { it.copy(lastError = err.userMessage()) }
            }
            .map { }
    }

    data class SyncSummary(val ok: Int, val failed: Int)

    suspend fun syncAll(): SyncSummary = coroutineScope {
        val results = _store.value.subscriptions.filter { it.enabled }
            .map { async { sync(it.id) } }
            .awaitAll()
        SyncSummary(ok = results.count { it.isSuccess }, failed = results.count { it.isFailure })
    }

    /** À appeler au démarrage de l'app. */
    suspend fun syncIfStale(maxAgeMs: Long = 24 * 3_600_000L) {
        val now = System.currentTimeMillis()
        _store.value.subscriptions
            .filter { it.enabled && (it.lastSyncAt ?: 0) < now - maxAgeMs }
            .forEach { sync(it.id) }
    }

    suspend fun removeSubscription(id: String) =
        update { s -> s.copy(subscriptions = s.subscriptions.filterNot { it.id == id }) }

    suspend fun setSubscriptionEnabled(id: String, enabled: Boolean) =
        updateSubscription(id) { it.copy(enabled = enabled) }

    // ------------------------------------------------------------------ Sources locales

    suspend fun upsertLocalProvider(provider: SourceProvider): Result<Unit> = runCatching {
        val errors = SourceValidator.validateProvider(provider)
        if (errors.isNotEmpty()) throw SourceValidationException(errors)
        update { s ->
            val list = s.localProviders.filterNot { it.id == provider.id } + provider
            s.copy(localProviders = list, disabledIds = s.disabledIds - provider.id)
        }
    }

    suspend fun removeLocalProvider(id: String) =
        update { s -> s.copy(localProviders = s.localProviders.filterNot { it.id == id }) }

    /** Désactivation persistante, y compris pour une source issue d'une liste. */
    suspend fun setProviderEnabled(id: String, enabled: Boolean) =
        update { s -> s.copy(disabledIds = if (enabled) s.disabledIds - id else s.disabledIds + id) }

    /** Importe un document complet collé à la main : ses sources deviennent locales. */
    suspend fun importDocument(raw: String): Result<Int> = runCatching {
        val doc = parseAndValidate(raw)
        val ids = doc.providers.map { it.id }.toSet()
        update { s ->
            s.copy(
                localProviders = s.localProviders.filterNot { it.id in ids } + doc.providers,
                disabledIds = s.disabledIds - ids,
            )
        }
        doc.providers.size
    }

    /** Exporte les sources locales au format du schéma (sauvegarde / partage). */
    fun exportLocal(): String = SourcesJson.encodeToString(
        SourcesDocument.serializer(),
        SourcesDocument(name = "Sources locales", providers = _store.value.localProviders),
    )

    // ------------------------------------------------------------------ Interne

    private sealed interface FetchResult {
        data object NotModified : FetchResult
        data class Updated(val doc: SourcesDocument, val etag: String?) : FetchResult
    }

    private suspend fun fetch(url: String, etag: String?): FetchResult = withContext(Dispatchers.IO) {
        val req = Request.Builder().url(url)
            .header("Accept", "application/json")
            .apply { etag?.let { header("If-None-Match", it) } }
            .build()
        http.newCall(req).execute().use { resp ->
            if (resp.code == 304) return@use FetchResult.NotModified
            if (!resp.isSuccessful) throw IOException("HTTP ${resp.code}")
            val source = resp.body?.source() ?: throw IOException("Réponse vide")
            if (source.request(MAX_BYTES + 1)) throw IOException("Fichier trop volumineux (> 1 Mo)")
            val doc = parseAndValidate(source.readUtf8())
            FetchResult.Updated(doc, resp.header("ETag"))
        }
    }

    private fun parseAndValidate(raw: String): SourcesDocument {
        val doc = try {
            SourcesJson.decodeFromString<SourcesDocument>(raw)
        } catch (e: SerializationException) {
            throw SourceValidationException(listOf("JSON invalide : ${e.message?.lineSequence()?.firstOrNull()}"))
        } catch (e: IllegalArgumentException) {
            throw SourceValidationException(listOf("JSON invalide : ${e.message?.lineSequence()?.firstOrNull()}"))
        }
        val errors = SourceValidator.validate(doc)
        if (errors.isNotEmpty()) throw SourceValidationException(errors)
        return doc
    }

    private suspend fun updateSubscription(id: String, transform: (Subscription) -> Subscription) =
        update { s -> s.copy(subscriptions = s.subscriptions.map { if (it.id == id) transform(it) else it }) }

    private suspend fun update(transform: (SourcesStore) -> SourcesStore): SourcesStore = mutex.withLock {
        val next = transform(_store.value).let { it.copy(revision = it.revision + 1) }
        withContext(Dispatchers.IO) { persist(next) }
        _store.value = next
        next
    }

    private fun persist(store: SourcesStore) {
        val out = file.startWrite()
        try {
            out.write(SourcesJson.encodeToString(SourcesStore.serializer(), store).encodeToByteArray())
            file.finishWrite(out)
        } catch (e: Exception) {
            file.failWrite(out)
            throw e
        }
    }

    private fun normalizeUrl(raw: String): String? {
        val t = raw.trim()
        if (t.isEmpty()) return null
        val withScheme = if ("://" in t) t else "http://$t"
        return withScheme.toHttpUrlOrNull()?.toString()
    }

    private fun Throwable.userMessage(): String = when (this) {
        is SourceValidationException -> errors.take(3).joinToString(" · ")
        is IOException -> "Réseau : ${message ?: "inaccessible"}"
        else -> message ?: javaClass.simpleName
    }

    companion object {
        private const val TAG = "SourceRepository"
        private const val MAX_BYTES = 1_048_576L
    }
}
