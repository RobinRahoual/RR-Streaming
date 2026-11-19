package fr.robinrahoual.rrstreaming.resolver

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.ViewGroup
import android.webkit.*
import kotlinx.coroutines.*
import java.io.ByteArrayInputStream
import java.util.concurrent.atomic.AtomicInteger

/**
 * Charge une page dans une WebView sans affichage, intercepte les requêtes réseau,
 * capture les manifests vidéo (.m3u8 / .mpd / .mp4) et leurs headers, bloque le superflu.
 *
 * Usage :
 *   val result = MediaUrlInterceptor(context).resolve(pageUrl)
 *
 * @param hostContainer optionnel : certains players ne démarrent que si la WebView est attachée
 *        à une fenêtre. Passer un ViewGroup de l'écran courant ; la WebView y sera ajoutée en 1x1 invisible.
 */
class MediaUrlInterceptor(
    context: Context,
    private val config: InterceptorConfig = InterceptorConfig(),
    private val hostContainer: ViewGroup? = null,
) {
    private val appContext = context.applicationContext
    private val classifier = RequestClassifier(config)

    suspend fun resolve(
        pageUrl: String,
        extraHeaders: Map<String, String> = emptyMap(),
    ): ResolveResult = withContext(Dispatchers.Main.immediate) {
        val start = SystemClock.elapsedRealtime()
        val session = Session(pageUrl)
        try {
            session.start(extraHeaders)
            val gotOne = withTimeoutOrNull(config.timeoutMs) { session.firstHit.await(); true }
            if (gotOne == null) {
                return@withContext ResolveResult.Timeout(pageUrl, SystemClock.elapsedRealtime() - start)
            }
            delay(config.settleMs) // laisse arriver master / variantes / fallback
            val ranked = classifier.rank(session.snapshot())
            ResolveResult.Success(ranked.first(), ranked)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            ResolveResult.Failure(pageUrl, e.message ?: e.javaClass.simpleName, e)
        } finally {
            session.dispose()
        }
    }

    // ------------------------------------------------------------------------------------------

    private inner class Session(private val pageUrl: String) {
        val firstHit = CompletableDeferred<Unit>()
        private val candidates = LinkedHashMap<String, StreamCandidate>()
        private val counter = AtomicInteger(0)
        private val mainHandler = Handler(Looper.getMainLooper())

        @Volatile private var currentPageUrl: String = pageUrl
        @Volatile private var pageHost: String? = Uri.parse(pageUrl).host
        @Volatile private var disposed = false

        private lateinit var webView: WebView
        private lateinit var userAgent: String

        fun snapshot(): List<StreamCandidate> = synchronized(candidates) { candidates.values.toList() }

        @SuppressLint("SetJavaScriptEnabled")
        fun start(extraHeaders: Map<String, String>) {
            webView = WebView(appContext).apply {
                settings.apply {
                    javaScriptEnabled = true
                    domStorageEnabled = true
                    mediaPlaybackRequiresUserGesture = false
                    setSupportMultipleWindows(false)
                    javaScriptCanOpenWindowsAutomatically = false
                    allowFileAccess = false
                    allowContentAccess = false
                    blockNetworkImage = config.blockImages
                    loadsImagesAutomatically = !config.blockImages
                    mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                    config.userAgent?.let { userAgentString = it }
                }
                webViewClient = Client()
                webChromeClient = Chrome()
                // Taille non nulle : certains players refusent de s'initialiser à 0x0.
                layout(0, 0, 1280, 720)
            }
            userAgent = webView.settings.userAgentString // lu ici : WebSettings n'est pas thread-safe

            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

            hostContainer?.addView(webView, ViewGroup.LayoutParams(1, 1))
            webView.alpha = 0f
            webView.onResume()
            webView.resumeTimers()

            webView.loadUrl(pageUrl, extraHeaders)
        }

        fun dispose() {
            if (disposed) return
            disposed = true
            mainHandler.removeCallbacksAndMessages(null)
            if (!::webView.isInitialized) return
            webView.runCatching {
                stopLoading()
                loadUrl("about:blank")
                onPause()
                (parent as? ViewGroup)?.removeView(this)
                removeAllViews()
                destroy()
            }.onFailure { Log.w(TAG, "dispose", it) }
        }

        // ---- Appelé depuis le thread réseau de la WebView ----
        private fun onStreamDetected(request: WebResourceRequest, type: StreamType) {
            val url = request.url.toString()
            val reqHeaders = request.requestHeaders.orEmpty()

            val headers = buildMap {
                put("User-Agent", reqHeaders.getIgnoreCase("User-Agent") ?: userAgent)
                put("Referer", reqHeaders.getIgnoreCase("Referer") ?: currentPageUrl)
                reqHeaders.getIgnoreCase("Origin")?.let { put("Origin", it) }
                // Les cookies ne figurent pas dans requestHeaders : on les récupère du CookieManager.
                CookieManager.getInstance().getCookie(url)?.takeIf { it.isNotBlank() }?.let { put("Cookie", it) }
            }

            val isNew = synchronized(candidates) {
                if (candidates.containsKey(url)) false
                else {
                    candidates[url] = StreamCandidate(url, type, headers, currentPageUrl, counter.getAndIncrement())
                    true
                }
            }
            if (isNew) {
                Log.d(TAG, "Flux détecté [$type] $url")
                firstHit.complete(Unit)
            }
        }

        private fun fail(reason: String) {
            if (!firstHit.isCompleted) firstHit.completeExceptionally(ResolveException(reason))
        }

        private fun injectAutoplay(attempt: Int = 0) {
            val js = config.autoplayScript ?: return
            if (disposed || firstHit.isCompleted || attempt >= config.autoplayRetries) return
            webView.evaluateJavascript(js, null)
            mainHandler.postDelayed({ injectAutoplay(attempt + 1) }, config.autoplayIntervalMs)
        }

        // ---------------------------------------------------------------------------------------

        private inner class Client : WebViewClient() {

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (disposed) return EMPTY()
                val type = classifier.detectStream(request.url.toString())
                if (type != null) {
                    onStreamDetected(request, type)
                    return if (config.consumeDetectedStreams) EMPTY() else null
                }
                if (classifier.shouldBlock(request, pageHost)) return EMPTY()
                return null // laisser la WebView charger normalement
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame) return false
                val allowed = classifier.isNavigationAllowed(request.url, pageHost)
                if (!allowed) Log.d(TAG, "Navigation bloquée → ${request.url}")
                return !allowed
            }

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                currentPageUrl = url
                pageHost = Uri.parse(url).host ?: pageHost
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (url != "about:blank") injectAutoplay()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame && !disposed) fail("Erreur de chargement : ${error.description}")
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (request.isForMainFrame && response.statusCode >= 400 && !disposed) {
                    fail("HTTP ${response.statusCode} sur la page")
                }
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // Évite le crash de l'app si le renderer meurt (fréquent sur appareils à faible RAM).
                fail("Processus de rendu WebView terminé")
                disposed = true
                (view.parent as? ViewGroup)?.removeView(view)
                view.destroy()
                return true
            }
        }

        private inner class Chrome : WebChromeClient() {
            override fun onCreateWindow(v: WebView, dialog: Boolean, gesture: Boolean, msg: android.os.Message) = false
            override fun onJsAlert(v: WebView, u: String, m: String, r: JsResult): Boolean { r.cancel(); return true }
            override fun onJsConfirm(v: WebView, u: String, m: String, r: JsResult): Boolean { r.cancel(); return true }
            override fun onJsPrompt(v: WebView, u: String, m: String, d: String?, r: JsPromptResult): Boolean { r.cancel(); return true }
            override fun onJsBeforeUnload(v: WebView, u: String, m: String, r: JsResult): Boolean { r.confirm(); return true }
            override fun onPermissionRequest(request: PermissionRequest) = request.deny()
        }
    }

    companion object {
        private const val TAG = "MediaUrlInterceptor"
        private fun EMPTY() = WebResourceResponse("text/plain", "utf-8", 204, "No Content", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    }
}
