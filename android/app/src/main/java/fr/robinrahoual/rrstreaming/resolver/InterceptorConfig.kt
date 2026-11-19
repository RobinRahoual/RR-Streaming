package fr.robinrahoual.rrstreaming.resolver

data class InterceptorConfig(
    /** Durée max pour obtenir un premier flux. */
    val timeoutMs: Long = 30_000,
    /** Après le premier flux détecté, délai pendant lequel on continue à collecter (master vs variantes). */
    val settleMs: Long = 1_500,
    /** UA forcé. null = UA par défaut de la WebView. */
    val userAgent: String? = null,
    /** Bloque le chargement du manifest dans la WebView une fois détecté (évite son et bande passante inutiles). */
    val consumeDetectedStreams: Boolean = true,

    // ---- Filtrage réseau ----
    val blockImages: Boolean = true,
    val blockFonts: Boolean = true,
    val blockStylesheets: Boolean = true,
    /** Bloque les scripts dont l'hôte n'est pas du même site que la page (sauf allowedHosts). */
    val blockThirdPartyScripts: Boolean = false,
    /** Hôtes toujours autorisés (CDN du player, hébergeur d'iframe…). Correspondance par suffixe. */
    val allowedHosts: Set<String> = emptySet(),
    /** Hôtes/URLs toujours bloqués (pubs, trackers). */
    val blockedPatterns: List<Regex> = DEFAULT_BLOCKED_PATTERNS,
    /** Autorise la navigation de la frame principale vers un autre site (redirections). */
    val allowCrossSiteRedirects: Boolean = false,

    /** Motif supplémentaire pour détecter des manifests sans extension (ex: /playlist/abc123). */
    val extraHlsPattern: Regex? = null,
    /** JS injecté après chargement pour déclencher la lecture. null = désactivé. */
    val autoplayScript: String? = DEFAULT_AUTOPLAY_JS,
    val autoplayRetries: Int = 3,
    val autoplayIntervalMs: Long = 1_000,
) {
    companion object {
        val DEFAULT_BLOCKED_PATTERNS = listOf(
            Regex("""(^|\.)doubleclick\.net"""),
            Regex("""(^|\.)googlesyndication\.com"""),
            Regex("""(^|\.)google-analytics\.com"""),
            Regex("""(^|\.)googletagmanager\.com"""),
            Regex("""(^|\.)adservice\.google\."""),
            Regex("""(^|\.)popads\.net"""),
            Regex("""(^|\.)popcash\.net"""),
            Regex("""(^|\.)propellerads\.com"""),
            Regex("""(^|\.)adsterra\.com"""),
            Regex("""(^|\.)exoclick\.com"""),
            Regex("""(^|\.)hotjar\.com"""),
            Regex("""(^|\.)facebook\.net"""),
            Regex("""/(vast|vmap|preroll|ads?)/""", RegexOption.IGNORE_CASE),
        )

        /** Coupe le son, clique les boutons play usuels, lance les <video>. Ne touche que la frame principale. */
        const val DEFAULT_AUTOPLAY_JS = """
            (function() {
              try {
                document.querySelectorAll('video,audio').forEach(function(v){
                  v.muted = true; var p = v.play(); if (p && p.catch) p.catch(function(){});
                });
                var sel = ['.vjs-big-play-button','.jw-icon-display','.plyr__control--overlaid',
                           '[aria-label="Play"]','.play-button','#play','button.play'];
                sel.forEach(function(s){ var b = document.querySelector(s); if (b) b.click(); });
              } catch(e) {}
            })();
        """
    }
}
