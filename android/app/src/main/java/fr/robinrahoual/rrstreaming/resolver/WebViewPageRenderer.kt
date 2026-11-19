package fr.robinrahoual.rrstreaming.resolver

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.*
import fr.robinrahoual.rrstreaming.sources.PageRenderer
import fr.robinrahoual.rrstreaming.sources.RenderedPage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import java.io.ByteArrayInputStream
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Rendu JavaScript avec une WebView invisible (équivalent de src/main/resolver/page-renderer.js).
 * Images, polices, CSS, médias et publicités sont bloqués ; redirections hors site refusées.
 * Attend que le nombre de liens se stabilise avant de lire le DOM.
 */
class WebViewPageRenderer(
    context: Context,
    private val timeoutMs: Long = 20_000,
) : PageRenderer {

    private val appContext = context.applicationContext
    private val classifier = RequestClassifier(InterceptorConfig())

    override suspend fun render(url: String, headers: Map<String, String>): RenderedPage =
        withContext(Dispatchers.Main) {
            withTimeout(timeoutMs + 2_000) { renderOnMain(url, headers) }
        }

    @SuppressLint("SetJavaScriptEnabled")
    private suspend fun renderOnMain(url: String, headers: Map<String, String>): RenderedPage =
        suspendCancellableCoroutine { cont ->
            val handler = Handler(Looper.getMainLooper())
            val pageHost = Uri.parse(url).host
            val deadline = System.currentTimeMillis() + timeoutMs
            var done = false
            var polling = false
            lateinit var webView: WebView

            fun finish(result: Result<RenderedPage>) {
                if (done) return
                done = true
                handler.removeCallbacksAndMessages(null)
                runCatching {
                    webView.stopLoading()
                    webView.loadUrl("about:blank")
                    webView.destroy()
                }
                result.fold({ cont.resume(it) }, { cont.resumeWithException(it) })
            }

            fun readDom() {
                webView.evaluateJavascript("document.documentElement.outerHTML") { raw ->
                    val html = runCatching { Json.decodeFromString(String.serializer(), raw) }.getOrNull()
                    if (html.isNullOrEmpty()) finish(Result.failure(IllegalStateException("Page vide")))
                    else finish(Result.success(RenderedPage(html, webView.url ?: url)))
                }
            }

            fun poll(last: Int, stable: Int) {
                if (done) return
                if (stable >= 3 || System.currentTimeMillis() > deadline) { readDom(); return }
                handler.postDelayed({
                    webView.evaluateJavascript("document.querySelectorAll('a[href]').length") { v ->
                        val n = v?.toIntOrNull() ?: -1
                        poll(n, if (n == last && n > 0) stable + 1 else 0)
                    }
                }, 500)
            }

            webView = WebView(appContext).apply {
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.blockNetworkImage = true
                settings.loadsImagesAutomatically = false
                settings.mediaPlaybackRequiresUserGesture = true
                settings.setSupportMultipleWindows(false)
                settings.javaScriptCanOpenWindowsAutomatically = false
                settings.allowFileAccess = false
                layout(0, 0, 1366, 2000)
                webChromeClient = object : WebChromeClient() {
                    override fun onJsAlert(v: WebView, u: String, m: String, r: JsResult): Boolean { r.cancel(); return true }
                    override fun onJsConfirm(v: WebView, u: String, m: String, r: JsResult): Boolean { r.cancel(); return true }
                }
                webViewClient = object : WebViewClient() {
                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                        val accept = request.requestHeaders["Accept"].orEmpty()
                        val media = accept.startsWith("video/") || accept.startsWith("audio/")
                        return if (media || classifier.shouldBlock(request, pageHost)) {
                            WebResourceResponse("text/plain", "utf-8", 204, "No Content", emptyMap(), ByteArrayInputStream(ByteArray(0)))
                        } else null
                    }

                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                        request.isForMainFrame && !classifier.isNavigationAllowed(request.url, pageHost)

                    override fun onPageFinished(view: WebView, finishedUrl: String) {
                        if (!polling && finishedUrl != "about:blank") { polling = true; poll(-1, 0) }
                    }

                    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                        if (request.isForMainFrame) finish(Result.failure(IllegalStateException("Chargement impossible : ${error.description}")))
                    }

                    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                        finish(Result.failure(IllegalStateException("Moteur de rendu arrêté")))
                        return true
                    }
                }
            }
            cont.invokeOnCancellation { handler.post { finish(Result.failure(it ?: IllegalStateException("Annulé"))) } }
            // Filet de sécurité : lire le DOM même si onPageFinished n'arrive jamais.
            handler.postDelayed({ if (!polling) { polling = true; poll(-1, 0) } }, timeoutMs / 2)
            webView.loadUrl(url, headers)
        }
}
