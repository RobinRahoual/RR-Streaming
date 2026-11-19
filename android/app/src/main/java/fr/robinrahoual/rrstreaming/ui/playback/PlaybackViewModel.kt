package fr.robinrahoual.rrstreaming.ui.playback

import android.app.Application
import androidx.annotation.OptIn
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import fr.robinrahoual.rrstreaming.RRStreamingApp
import fr.robinrahoual.rrstreaming.resolver.PlaybackResolution
import fr.robinrahoual.rrstreaming.resolver.ProviderFailure
import fr.robinrahoual.rrstreaming.resolver.StreamCandidate
import fr.robinrahoual.rrstreaming.resolver.StreamPlayerFactory
import fr.robinrahoual.rrstreaming.resolver.StreamState
import fr.robinrahoual.rrstreaming.sources.MediaRequest
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

sealed interface PlaybackUiState {
    data object Idle : PlaybackUiState
    data class Resolving(val title: String, val status: String, val log: List<String> = emptyList()) : PlaybackUiState
    data class Playing(val title: String, val providerName: String) : PlaybackUiState
    data object NoSources : PlaybackUiState
    data class Error(val title: String, val message: String, val failures: List<ProviderFailure> = emptyList()) : PlaybackUiState
}

/**
 * Bouton « Lire » d'une fiche TMDB → StreamPrefetcher (résultat préparé à l'ouverture de la fiche) → ExoPlayer.
 * Si le flux retenu est illisible, essaie automatiquement les autres flux détectés.
 *
 * Usage (fiche film) :
 *   vm.play(MediaRequest(tmdbId = 603, type = MediaKind.MOVIE, title = "Matrix", originalTitle = "The Matrix", year = 1999), "Matrix")
 * Afficher vm.player dans un androidx.media3.ui.PlayerView quand l'état est Playing.
 */
@OptIn(UnstableApi::class)
class PlaybackViewModel(app: Application) : AndroidViewModel(app) {

    private val rr = app as RRStreamingApp
    val player: ExoPlayer = ExoPlayer.Builder(app).build()

    private val _state = MutableStateFlow<PlaybackUiState>(PlaybackUiState.Idle)
    val state: StateFlow<PlaybackUiState> = _state.asStateFlow()

    private var job: Job? = null
    private var alternatives: List<StreamCandidate> = emptyList()
    private var altIndex = 0
    private var current: Pair<String, String>? = null // titre, source

    init {
        player.addListener(object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) = tryNextStream(error.errorCodeName)
        })
    }

    private var lastMedia: MediaRequest? = null
    private var fromCache = false
    private var refreshed = false
    private var progressJob: Job? = null

    fun play(media: MediaRequest, title: String) {
        job?.cancel()
        progressJob?.cancel()
        player.stop()
        lastMedia = media
        refreshed = false
        _state.value = PlaybackUiState.Resolving(title, "Recherche d'une source…")
        // Réutilise la recherche lancée à l'ouverture de la fiche (ou la démarre).
        val flow = rr.prefetcher.prefetch(media, "page")
        progressJob = viewModelScope.launch {
            flow.collect { st ->
                if (st is StreamState.Resolving && st.provider != null) _state.update { s ->
                    if (s is PlaybackUiState.Resolving) s.copy(status = "${st.provider} — ${st.message}") else s
                }
            }
        }
        job = viewModelScope.launch { resolveAndPlay(media, title, fresh = false) }
    }

    private suspend fun resolveAndPlay(media: MediaRequest, title: String, fresh: Boolean) {
        val (result, cached) = rr.prefetcher.resolve(media, fresh)
        progressJob?.cancel()
        fromCache = cached
        when (result) {
            is PlaybackResolution.Ready -> {
                alternatives = result.alternatives.ifEmpty { listOf(result.stream) }
                altIndex = 0
                current = title to result.providerName
                StreamPlayerFactory.play(getApplication(), player, alternatives[0])
                _state.value = PlaybackUiState.Playing(title, result.providerName)
            }
            PlaybackResolution.NoSources -> _state.value = PlaybackUiState.NoSources
            is PlaybackResolution.Failed -> _state.value = PlaybackUiState.Error(
                title, "Aucune source n'a fourni de flux lisible.", result.failures,
            )
        }
    }

    private fun tryNextStream(reason: String) {
        val (title, provider) = current ?: return
        altIndex++
        when {
            altIndex < alternatives.size -> {
                StreamPlayerFactory.play(getApplication(), player, alternatives[altIndex])
                _state.value = PlaybackUiState.Playing(title, provider)
            }
            // Flux préparé à l'avance mais expiré (jeton) : une nouvelle recherche, une seule fois.
            fromCache && !refreshed && lastMedia != null -> {
                refreshed = true
                _state.value = PlaybackUiState.Resolving(title, "Le flux préparé a expiré, nouvelle recherche…")
                job = viewModelScope.launch { resolveAndPlay(lastMedia!!, title, fresh = true) }
            }
            else -> _state.value = PlaybackUiState.Error(title, "Le flux trouvé n'a pas pu être lu ($reason).")
        }
    }

    fun stop() {
        job?.cancel()
        progressJob?.cancel()
        player.stop()
        _state.value = PlaybackUiState.Idle
    }

    override fun onCleared() {
        job?.cancel()
        player.release()
    }

    companion object {
        val Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>, extras: androidx.lifecycle.viewmodel.CreationExtras): T {
                val app = extras[ViewModelProvider.AndroidViewModelFactory.APPLICATION_KEY]!!
                return PlaybackViewModel(app) as T
            }
        }
    }
}
