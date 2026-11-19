package fr.robinrahoual.rrstreaming.resolver

import android.net.Uri
import android.webkit.WebResourceRequest

/** Logique pure (sans WebView) : détection de manifests et décision de blocage. Testable unitairement. */
internal class RequestClassifier(private val config: InterceptorConfig) {

    private val hlsRegex = Regex("""\.m3u8(\?|#|&|$)""", RegexOption.IGNORE_CASE)
    private val dashRegex = Regex("""\.mpd(\?|#|&|$)""", RegexOption.IGNORE_CASE)
    private val mp4Regex = Regex("""\.mp4(\?|#|&|$)""", RegexOption.IGNORE_CASE)
    private val fontRegex = Regex("""\.(woff2?|ttf|otf|eot)(\?|$)""", RegexOption.IGNORE_CASE)
    private val cssRegex = Regex("""\.css(\?|$)""", RegexOption.IGNORE_CASE)
    private val imageRegex = Regex("""\.(png|jpe?g|gif|webp|svg|ico|avif)(\?|$)""", RegexOption.IGNORE_CASE)
    private val scriptRegex = Regex("""\.js(\?|$)""", RegexOption.IGNORE_CASE)
    private val masterHint = Regex("""(master|playlist|index|manifest)""", RegexOption.IGNORE_CASE)

    fun detectStream(url: String): StreamType? = when {
        isBlockedByPattern(url) -> null // ex: mp4 publicitaire VAST
        hlsRegex.containsMatchIn(url) -> StreamType.HLS
        dashRegex.containsMatchIn(url) -> StreamType.DASH
        mp4Regex.containsMatchIn(url) -> StreamType.PROGRESSIVE
        config.extraHlsPattern?.containsMatchIn(url) == true -> StreamType.HLS
        else -> null
    }

    fun shouldBlock(request: WebResourceRequest, pageHost: String?): Boolean {
        val url = request.url.toString()
        val host = request.url.host ?: return false
        if (isAllowedHost(host)) return false
        if (isBlockedByPattern(url)) return true

        val accept = request.requestHeaders.getIgnoreCase("Accept").orEmpty()
        if (config.blockImages && (imageRegex.containsMatchIn(url) || accept.startsWith("image/"))) return true
        if (config.blockFonts && fontRegex.containsMatchIn(url)) return true
        if (config.blockStylesheets && (cssRegex.containsMatchIn(url) || accept.startsWith("text/css"))) return true
        if (config.blockThirdPartyScripts && scriptRegex.containsMatchIn(url) &&
            pageHost != null && !isSameSite(host, pageHost)
        ) return true
        return false
    }

    fun isNavigationAllowed(target: Uri, pageHost: String?): Boolean {
        val scheme = target.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") return false // intent://, market://, etc.
        val host = target.host ?: return false
        if (isBlockedByPattern(target.toString())) return false
        if (config.allowCrossSiteRedirects || isAllowedHost(host)) return true
        return pageHost == null || isSameSite(host, pageHost)
    }

    /** Tri : HLS (master d'abord) > DASH > MP4, puis ordre de détection. */
    fun rank(candidates: Collection<StreamCandidate>): List<StreamCandidate> =
        candidates.sortedWith(
            compareBy<StreamCandidate> {
                when (it.type) { StreamType.HLS -> 0; StreamType.DASH -> 1; StreamType.PROGRESSIVE -> 2 }
            }
                .thenBy { if (it.type == StreamType.HLS && masterHint.containsMatchIn(Uri.parse(it.url).path.orEmpty())) 0 else 1 }
                .thenBy { it.order }
        )

    private fun isBlockedByPattern(url: String): Boolean {
        val host = Uri.parse(url).host.orEmpty()
        return config.blockedPatterns.any { it.containsMatchIn(host) || it.containsMatchIn(url) }
    }

    private fun isAllowedHost(host: String): Boolean =
        config.allowedHosts.any { host == it || host.endsWith(".$it") }

    /** Approximation eTLD+1 (2 derniers labels). Pour les .co.uk & co, utiliser InternetDomainName (Guava). */
    private fun isSameSite(a: String, b: String): Boolean = baseDomain(a) == baseDomain(b)

    private fun baseDomain(host: String): String = host.lowercase().split('.').takeLast(2).joinToString(".")
}
