package fr.robinrahoual.rrstreaming.sources

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

val SourcesJson = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
    explicitNulls = false
    isLenient = false
}

// ------------------------------------------------------------------ Fichier distant (cf. sources.schema.json)

@Serializable
data class SourcesDocument(
    val schemaVersion: Int = 1,
    val name: String? = null,
    val description: String? = null,
    val providers: List<SourceProvider> = emptyList(),
)

@Serializable
enum class MediaKind { @SerialName("movie") MOVIE, @SerialName("tv") TV }

@Serializable
data class Selector(
    val css: String,
    val attr: String = "text",
    val regex: String? = null,
)

@Serializable
data class SearchSpec(
    val url: String,
    val query: String = "{title}",
    val item: String,
    val title: Selector,
    val link: Selector,
    val year: Selector? = null,
    val poster: Selector? = null,
)

@Serializable
data class MatchSpec(val minScore: Double = 0.8, val yearTolerance: Int = 1)

@Serializable
data class EpisodeSpec(
    val urlTemplate: String? = null,
    /** Paramètres d'adresse posés sur la page de la série (ou sur urlTemplate), ex. { "s": "{season}", "ep": "{episode}" }. */
    val params: Map<String, String>? = null,
    val item: String? = null,
    val season: Selector? = null,
    val episode: Selector? = null,
    val link: Selector? = null,
)

@Serializable
data class PlayerSpec(
    val iframe: Selector? = null,
    val allowedHosts: List<String> = emptyList(),
    val extraHlsPattern: String? = null,
    val timeoutMs: Long? = null,
)

@Serializable
data class SourceProvider(
    val id: String,
    val name: String,
    val enabled: Boolean = true,
    val priority: Int = 50,
    val baseUrl: String,
    val language: String? = null,
    val types: List<MediaKind> = listOf(MediaKind.MOVIE, MediaKind.TV),
    val headers: Map<String, String> = emptyMap(),
    /** Pages construites en JavaScript : rendu dans une WebView invisible avant lecture des sélecteurs. */
    val render: Boolean = false,
    val search: SearchSpec,
    val match: MatchSpec = MatchSpec(),
    val episodes: EpisodeSpec? = null,
    val player: PlayerSpec = PlayerSpec(),
)

// ------------------------------------------------------------------ Stockage local

@Serializable
data class Subscription(
    val id: String,
    val url: String,
    val name: String,
    val enabled: Boolean = true,
    val lastSyncAt: Long? = null,
    val etag: String? = null,
    val lastError: String? = null,
    val providers: List<SourceProvider> = emptyList(),
)

@Serializable
data class SourcesStore(
    val version: Int = 1,
    /** Incrémenté à chaque écriture : permet au compagnon de détecter les changements. */
    val revision: Long = 0,
    val subscriptions: List<Subscription> = emptyList(),
    /** Sources ajoutées à la main (compagnon / import). Prioritaires sur une liste à id égal. */
    val localProviders: List<SourceProvider> = emptyList(),
    /** Désactivations utilisateur qui survivent aux synchronisations. */
    val disabledIds: Set<String> = emptySet(),
)

/** Vue « à plat » d'une source avec son origine et son état effectif. */
@Serializable
data class ProviderEntry(
    val provider: SourceProvider,
    /** null = source locale. */
    val subscriptionId: String?,
    val originName: String,
    val enabled: Boolean,
)

fun SourcesStore.providerEntries(): List<ProviderEntry> {
    val byId = LinkedHashMap<String, ProviderEntry>()
    subscriptions.forEach { sub ->
        sub.providers.forEach { p ->
            byId[p.id] = ProviderEntry(p, sub.id, sub.name, sub.enabled && p.enabled && p.id !in disabledIds)
        }
    }
    localProviders.forEach { p ->
        byId[p.id] = ProviderEntry(p, null, "Local", p.enabled && p.id !in disabledIds)
    }
    return byId.values.sortedByDescending { it.provider.priority }
}

/** Sources à essayer, dans l'ordre, au lancement d'un média. */
fun SourcesStore.activeProviders(kind: MediaKind? = null): List<SourceProvider> =
    providerEntries()
        .filter { it.enabled && (kind == null || kind in it.provider.types) }
        .map { it.provider }

class SourceValidationException(val errors: List<String>) :
    IllegalArgumentException("Fichier de sources invalide (${errors.size} erreur(s))")
