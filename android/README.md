# RR Streaming — version Fire TV

Modules Kotlin à intégrer dans le projet Android TV existant (interface Compose).

## Intégration

1. Copier `app/src/main/java/fr/robinrahoual/rrstreaming/**`, `app/src/main/assets/companion/index.html`,
   `app/src/main/res/**` et `app/src/test/**` dans le module `app`.
2. Reprendre les `dependencies`, les plugins (`kotlin.plugin.serialization`, `kotlin.plugin.compose`) et
   `minSdk = 25` de `app/build.gradle.kts`.
3. Fusionner `AndroidManifest.xml` : permissions réseau, `android:name=".RRStreamingApp"`,
   `android:networkSecurityConfig`, bannière TV et `LEANBACK_LAUNCHER` sur l'activité principale.

## Lancer une lecture depuis une fiche TMDB

```kotlin
val vm: PlaybackViewModel = viewModel(factory = PlaybackViewModel.Factory)

// Film
vm.play(MediaRequest(tmdbId = movie.id, type = MediaKind.MOVIE, title = movie.title,
                     originalTitle = movie.originalTitle, year = movie.releaseYear), movie.title)

// Épisode
vm.play(MediaRequest(tmdbId = show.id, type = MediaKind.TV, title = show.name, originalTitle = show.originalName,
                     year = show.firstAirYear, season = 2, episode = 5), "${show.name} · S2 É5")

// Affichage : PlayerView(vm.player) quand vm.state == Playing ;
// Resolving(status, log) pendant la recherche ; NoSources → ouvrir l'onglet Sources.
```

## Préparer le flux dès l'ouverture d'une fiche

La recherche du flux démarre quand la fiche s'ouvre ; « Lire » réutilise le résultat (ou attend la recherche en cours).

```kotlin
val rr = LocalContext.current.applicationContext as RRStreamingApp
val media = remember(movie.id) { MediaRequest(movie.id, MediaKind.MOVIE, movie.title, movie.originalTitle, movie.releaseYear) }
val stream by remember(media) { rr.prefetcher.prefetch(media) }.collectAsState()

when (val st = stream) {
    is StreamState.Resolving -> Text("Recherche d'une source…")
    is StreamState.Ready -> Text("Prêt à lire · ${st.resolution.providerName}")
    StreamState.NoSources -> Text("Aucune source active")
    is StreamState.Failed -> Text("Aucune source n'a trouvé ce titre")
    StreamState.Idle -> Unit
}
// Bouton Lire : vm.play(media, movie.title) → démarrage quasi immédiat si le flux est prêt.
// Épisode survolé : rr.prefetcher.prefetch(episodeMedia, slot = "hover")
```

Résultats de recherche : `rr.availability.check(medias)` puis `rr.availability.results.collectAsState()`
(clé `"movie:<tmdbId>"` / `"tv:<tmdbId>"` → `available`, `provider`).

## Chaîne de résolution

`TmdbSourceResolver` essaie chaque source active par priorité :
recherche du titre (`SourceScraper` + sélecteurs du JSON) → meilleur résultat (`TitleMatcher`, titre + année)
→ page de l'épisode → iframe du lecteur → `MediaUrlInterceptor` (WebView) → `StreamPlayerFactory` (ExoPlayer).
Si le flux retenu est illisible, `PlaybackViewModel` essaie les autres flux détectés.

## Tests

`./gradlew :app:testDebugUnitTest` (TitleMatcher, SourceScraper avec MockWebServer).
