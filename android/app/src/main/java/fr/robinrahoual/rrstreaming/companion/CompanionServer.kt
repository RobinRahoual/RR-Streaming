package fr.robinrahoual.rrstreaming.companion

import android.content.Context
import fr.robinrahoual.rrstreaming.sources.*
import fi.iki.elonen.NanoHTTPD
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import java.io.IOException
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicInteger

/**
 * Mini-serveur HTTP du réseau local pour gérer les sources depuis un téléphone ou un PC.
 * - GET /           → page compagnon (assets/companion/index.html)
 * - /api/*          → API JSON, protégée par un code d'appairage à 6 chiffres (header X-Pairing-Code)
 *
 * Le code change à chaque démarrage. Démarrer/arrêter le serveur avec la visibilité de l'onglet Sources.
 */
class CompanionServer private constructor(
    private val context: Context,
    private val repo: SourceRepository,
    private val analyzer: BuilderAnalyzer,
    port: Int,
) : NanoHTTPD(port) {

    val pairingCode: String = (SecureRandom().nextInt(900_000) + 100_000).toString()
    private val failures = AtomicInteger(0)
    @Volatile private var lockedUntil = 0L

    // ------------------------------------------------------------------ DTO

    @Serializable private data class UrlBody(val url: String)
    @Serializable private data class ToggleBody(val enabled: Boolean)
    @Serializable private data class AnalyzeBody(val url: String, val headers: Map<String, String> = emptyMap(), val render: Boolean = false)
    @Serializable private data class TestBody(val provider: SourceProvider, val title: String = "", val year: String? = null, val type: String = "movie")
    @Serializable private data class ErrorBody(val error: String, val details: List<String> = emptyList())

    @Serializable
    private data class SubscriptionDto(
        val id: String, val url: String, val name: String, val enabled: Boolean,
        val lastSyncAt: Long?, val lastError: String?, val providerCount: Int,
    )

    @Serializable
    private data class StateDto(
        val revision: Long,
        val subscriptions: List<SubscriptionDto>,
        val providers: List<ProviderEntry>,
    )

    private class HttpError(val status: Response.Status, message: String, val details: List<String> = emptyList()) :
        Exception(message)

    // ------------------------------------------------------------------ Routage

    override fun serve(session: IHTTPSession): Response = try {
        route(session)
    } catch (e: HttpError) {
        json(e.status, SourcesJson.encodeToString(ErrorBody.serializer(), ErrorBody(e.message ?: "Erreur", e.details)))
    } catch (e: Exception) {
        json(Response.Status.INTERNAL_ERROR, SourcesJson.encodeToString(ErrorBody.serializer(), ErrorBody(e.message ?: "Erreur interne")))
    }

    private fun route(s: IHTTPSession): Response {
        val path = s.uri.trimEnd('/').ifEmpty { "/" }
        val m = s.method

        if (m == Method.GET && (path == "/" || path == "/index.html")) return asset("companion/index.html", "text/html; charset=utf-8")
        if (!path.startsWith("/api/")) throw HttpError(Response.Status.NOT_FOUND, "Introuvable")

        authorize(s)
        val seg = path.removePrefix("/api/").split('/')

        return when {
            m == Method.GET && seg == listOf("state") -> state()
            m == Method.GET && seg == listOf("export") ->
                json(Response.Status.OK, repo.exportLocal())

            m == Method.POST && seg == listOf("sync") -> { runBlocking { repo.syncAll() }; state() }

            m == Method.POST && seg == listOf("subscriptions") -> {
                val body = decode(UrlBody.serializer(), body(s))
                runBlocking { repo.addSubscription(body.url) }.orThrowHttp()
                state()
            }
            m == Method.POST && seg.size == 3 && seg[0] == "subscriptions" && seg[2] == "sync" -> {
                runBlocking { repo.sync(seg[1]) }.orThrowHttp()
                state()
            }
            m == Method.POST && seg.size == 3 && seg[0] == "subscriptions" && seg[2] == "toggle" -> {
                val t = decode(ToggleBody.serializer(), body(s))
                runBlocking { repo.setSubscriptionEnabled(seg[1], t.enabled) }
                state()
            }
            m == Method.DELETE && seg.size == 2 && seg[0] == "subscriptions" -> {
                runBlocking { repo.removeSubscription(seg[1]) }
                state()
            }

            m == Method.POST && seg == listOf("providers") -> {
                val p = decode(SourceProvider.serializer(), body(s))
                runBlocking { repo.upsertLocalProvider(p) }.orThrowHttp()
                state()
            }
            m == Method.POST && seg.size == 3 && seg[0] == "providers" && seg[2] == "toggle" -> {
                val t = decode(ToggleBody.serializer(), body(s))
                runBlocking { repo.setProviderEnabled(seg[1], t.enabled) }
                state()
            }
            m == Method.DELETE && seg.size == 2 && seg[0] == "providers" -> {
                runBlocking { repo.removeLocalProvider(seg[1]) }
                state()
            }

            m == Method.POST && seg == listOf("import") -> {
                runBlocking { repo.importDocument(body(s)) }.orThrowHttp()
                state()
            }

            // Assistant de création de source
            m == Method.GET && seg == listOf("builder") -> json(Response.Status.OK, "{\"version\":1}")
            m == Method.POST && seg == listOf("builder", "analyze") -> {
                val b = decode(AnalyzeBody.serializer(), body(s))
                val r = runBlocking { runCatching { analyzer.analyzeUrl(b.url, b.headers, b.render) } }.orThrowHttp()
                json(Response.Status.OK, SourcesJson.encodeToString(BuilderAnalyzer.AnalyzeResult.serializer(), r))
            }
            m == Method.POST && seg == listOf("builder", "test") -> {
                val b = decode(TestBody.serializer(), body(s))
                val kind = if (b.type == "tv") MediaKind.TV else MediaKind.MOVIE
                val r = runBlocking { runCatching { analyzer.test(b.provider, b.title, b.year, kind) } }.orThrowHttp()
                json(Response.Status.OK, SourcesJson.encodeToString(BuilderAnalyzer.TestResult.serializer(), r))
            }

            else -> throw HttpError(Response.Status.NOT_FOUND, "Route inconnue : ${m.name} $path")
        }
    }

    // ------------------------------------------------------------------ Sécurité

    private fun authorize(s: IHTTPSession) {
        val now = System.currentTimeMillis()
        if (now < lockedUntil) throw HttpError(Response.Status.TOO_MANY_REQUESTS, "Trop de tentatives, réessayez dans une minute")
        val given = s.headers["x-pairing-code"].orEmpty()
        val ok = MessageDigest.isEqual(given.toByteArray(), pairingCode.toByteArray())
        if (!ok) {
            if (failures.incrementAndGet() >= MAX_FAILURES) {
                lockedUntil = now + 60_000
                failures.set(0)
            }
            throw HttpError(Response.Status.UNAUTHORIZED, "Code d'appairage incorrect")
        }
        failures.set(0)
    }

    // ------------------------------------------------------------------ Helpers

    private fun state(): Response {
        val store = repo.store.value
        val dto = StateDto(
            revision = store.revision,
            subscriptions = store.subscriptions.map {
                SubscriptionDto(it.id, it.url, it.name, it.enabled, it.lastSyncAt, it.lastError, it.providers.size)
            },
            providers = store.providerEntries(),
        )
        return json(Response.Status.OK, SourcesJson.encodeToString(StateDto.serializer(), dto))
    }

    private fun body(s: IHTTPSession): String {
        val len = s.headers["content-length"]?.toIntOrNull() ?: 0
        if (len > MAX_BODY) throw HttpError(Response.Status.PAYLOAD_TOO_LARGE, "Corps trop volumineux")
        val buf = ByteArray(len)
        var read = 0
        while (read < len) {
            val n = s.inputStream.read(buf, read, len - read)
            if (n < 0) break
            read += n
        }
        return String(buf, 0, read, Charsets.UTF_8)
    }

    private fun <T> decode(serializer: kotlinx.serialization.KSerializer<T>, raw: String): T =
        runCatching { SourcesJson.decodeFromString(serializer, raw) }
            .getOrElse { throw HttpError(Response.Status.BAD_REQUEST, "JSON invalide", listOfNotNull(it.message?.lineSequence()?.firstOrNull())) }

    private fun <T> Result<T>.orThrowHttp(): T = getOrElse { e ->
        when (e) {
            is SourceValidationException -> throw HttpError(Response.Status.BAD_REQUEST, e.message ?: "Invalide", e.errors)
            else -> throw HttpError(Response.Status.BAD_REQUEST, e.message ?: "Erreur")
        }
    }

    private fun asset(path: String, mime: String): Response =
        newFixedLengthResponse(Response.Status.OK, mime, context.assets.open(path).use { it.readBytes() }.decodeToString())
            .withSecurityHeaders()

    private fun json(status: Response.Status, text: String): Response =
        newFixedLengthResponse(status, "application/json; charset=utf-8", text).withSecurityHeaders()

    private fun Response.withSecurityHeaders() = apply {
        addHeader("Cache-Control", "no-store")
        addHeader("X-Content-Type-Options", "nosniff")
        addHeader("X-Frame-Options", "DENY")
        addHeader("Referrer-Policy", "no-referrer")
    }

    companion object {
        private const val MAX_BODY = 1_048_576
        private const val MAX_FAILURES = 10

        /** Démarre sur le premier port libre de la plage. Bloquant : appeler hors du thread principal. */
        @Throws(IOException::class)
        fun start(context: Context, repo: SourceRepository, scraper: SourceScraper, ports: IntRange = 8080..8090): CompanionServer {
            var last: IOException? = null
            val analyzer = BuilderAnalyzer(scraper)
            for (port in ports) {
                val server = CompanionServer(context.applicationContext, repo, analyzer, port)
                try {
                    server.start(SOCKET_READ_TIMEOUT, true)
                    return server
                } catch (e: IOException) {
                    last = e
                }
            }
            throw IOException("Aucun port libre entre ${ports.first} et ${ports.last}", last)
        }
    }
}
