package fr.robinrahoual.rrstreaming.ui.sources

import android.app.Application
import android.graphics.Bitmap
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import fr.robinrahoual.rrstreaming.companion.CompanionServer
import fr.robinrahoual.rrstreaming.companion.LocalNetwork
import fr.robinrahoual.rrstreaming.companion.QrCode
import fr.robinrahoual.rrstreaming.sources.ProviderEntry
import fr.robinrahoual.rrstreaming.sources.SourceRepository
import fr.robinrahoual.rrstreaming.sources.Subscription
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class CompanionInfo(val url: String, val code: String, val qr: Bitmap)

sealed interface CompanionState {
    data object Starting : CompanionState
    data object NoNetwork : CompanionState
    data class Running(val info: CompanionInfo) : CompanionState
    data class Error(val message: String) : CompanionState
}

data class SourcesUiState(
    val subscriptions: List<Subscription> = emptyList(),
    val providers: List<ProviderEntry> = emptyList(),
    val companion: CompanionState = CompanionState.Starting,
    val syncing: Boolean = false,
    val message: String? = null,
)

class SourcesViewModel(
    app: Application,
    private val repo: SourceRepository,
) : AndroidViewModel(app) {

    private var server: CompanionServer? = null
    private val companion = MutableStateFlow<CompanionState>(CompanionState.Starting)
    private val syncing = MutableStateFlow(false)
    private val message = MutableStateFlow<String?>(null)

    val ui: StateFlow<SourcesUiState> = combine(repo.store, repo.entries, companion, syncing, message) { store, entries, c, s, m ->
        SourcesUiState(store.subscriptions, entries, c, s, m)
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), SourcesUiState())

    fun startCompanion() {
        if (server != null) return
        companion.value = CompanionState.Starting
        viewModelScope.launch(Dispatchers.IO) {
            val ip = LocalNetwork.localIpv4()
            if (ip == null) { companion.value = CompanionState.NoNetwork; return@launch }
            runCatching { CompanionServer.start(getApplication(), repo) }
                .onSuccess { srv ->
                    server = srv
                    val base = "http://$ip:${srv.listeningPort}"
                    val qr = QrCode.bitmap("$base/?code=${srv.pairingCode}")
                    companion.value = CompanionState.Running(CompanionInfo(base, srv.pairingCode, qr))
                }
                .onFailure { companion.value = CompanionState.Error(it.message ?: "Serveur indisponible") }
        }
    }

    fun stopCompanion() {
        server?.stop()
        server = null
    }

    fun syncAll() = launchBusy {
        val r = repo.syncAll()
        when {
            r.ok + r.failed == 0 -> "Aucune liste à synchroniser"
            r.failed == 0 -> "Sources à jour"
            else -> "${r.ok} à jour · ${r.failed} en erreur"
        }
    }

    fun sync(id: String) = launchBusy {
        repo.sync(id).fold({ "Liste synchronisée" }, { "Échec : ${it.message}" })
    }

    fun toggleSubscription(sub: Subscription) = viewModelScope.launch {
        repo.setSubscriptionEnabled(sub.id, !sub.enabled)
    }

    fun toggleProvider(entry: ProviderEntry) = viewModelScope.launch {
        repo.setProviderEnabled(entry.provider.id, !entry.enabled)
    }

    private fun launchBusy(block: suspend () -> String) = viewModelScope.launch {
        if (syncing.value) return@launch
        syncing.value = true
        val msg = runCatching { withContext(Dispatchers.IO) { block() } }.getOrElse { it.message ?: "Erreur" }
        syncing.value = false
        message.value = msg
        delay(3_000)
        if (message.value == msg) message.value = null
    }

    override fun onCleared() = stopCompanion()

    companion object {
        /** viewModel(factory = SourcesViewModel.Factory) dans l'écran Compose. */
        val Factory = object : androidx.lifecycle.ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : androidx.lifecycle.ViewModel> create(
                modelClass: Class<T>,
                extras: androidx.lifecycle.viewmodel.CreationExtras,
            ): T {
                val app = extras[androidx.lifecycle.ViewModelProvider.AndroidViewModelFactory.APPLICATION_KEY]!!
                return SourcesViewModel(app, (app as fr.robinrahoual.rrstreaming.RRStreamingApp).sources) as T
            }
        }
    }
}
