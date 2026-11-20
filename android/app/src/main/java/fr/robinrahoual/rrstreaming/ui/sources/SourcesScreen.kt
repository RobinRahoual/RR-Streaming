package fr.robinrahoual.rrstreaming.ui.sources

import android.text.format.DateUtils
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.tv.material3.*
import fr.robinrahoual.rrstreaming.sources.ProviderEntry
import fr.robinrahoual.rrstreaming.sources.Subscription

// ---------------------------------------------------------------- Palette « tvOS »

private object Tv {
    val Background = Brush.verticalGradient(listOf(Color(0xFF1E1E24), Color(0xFF0D0D10), Color.Black))
    val Glass = Color.White.copy(alpha = 0.07f)
    val Hairline = Color.White.copy(alpha = 0.10f)
    val Secondary = Color.White.copy(alpha = 0.55f)
    val Green = Color(0xFF30D158)
    val Red = Color(0xFFFF453A)
    val Shape = RoundedCornerShape(18.dp)
}

// ---------------------------------------------------------------- Écran

@OptIn(ExperimentalTvMaterial3Api::class)
@Composable
fun SourcesScreen(vm: SourcesViewModel) {
    val state by vm.ui.collectAsStateWithLifecycle()
    val syncFocus = remember { FocusRequester() }

    // Le serveur ne tourne que tant que l'onglet est affiché.
    DisposableEffect(Unit) {
        vm.startCompanion()
        onDispose { vm.stopCompanion() }
    }
    LaunchedEffect(Unit) { runCatching { syncFocus.requestFocus() } }

    Box(Modifier.fillMaxSize().background(Tv.Background)) {
        Row(
            Modifier.fillMaxSize().padding(start = 96.dp, end = 80.dp, top = 64.dp, bottom = 48.dp),
            horizontalArrangement = Arrangement.spacedBy(64.dp),
        ) {
            LazyColumn(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                contentPadding = PaddingValues(vertical = 12.dp, horizontal = 12.dp), // place pour le zoom au focus
            ) {
                item {
                    Column(Modifier.padding(bottom = 20.dp)) {
                        Text("Sources", fontSize = 56.sp, fontWeight = FontWeight.Bold, color = Color.White)
                        Spacer(Modifier.height(6.dp))
                        Text(
                            "Utilisées uniquement pour trouver la lecture d'un titre du catalogue.",
                            fontSize = 20.sp, color = Tv.Secondary,
                        )
                        Spacer(Modifier.height(28.dp))
                        PillButton(
                            text = if (state.syncing) "Synchronisation…" else "Tout synchroniser",
                            onClick = vm::syncAll,
                            modifier = Modifier.focusRequester(syncFocus),
                        )
                    }
                }

                item { SectionTitle("Listes", "${state.subscriptions.size}") }
                if (state.subscriptions.isEmpty()) {
                    item { EmptyRow("Aucune liste. Scannez le QR code pour ajouter l'URL d'un fichier JSON.") }
                }
                items(state.subscriptions, key = { "sub-" + it.id }) { sub ->
                    SubscriptionRow(sub, onClick = { vm.sync(sub.id) }, onLongClick = { vm.toggleSubscription(sub) })
                }

                item { SectionTitle("Sources", "${state.providers.count { it.enabled }} actives sur ${state.providers.size}") }
                if (state.providers.isEmpty()) {
                    item { EmptyRow("Les sources des listes et celles ajoutées depuis le téléphone apparaîtront ici.") }
                }
                items(state.providers, key = { "prov-" + it.provider.id }) { entry ->
                    ProviderRow(entry, onClick = { vm.toggleProvider(entry) })
                }

                item {
                    Text(
                        "OK : synchroniser une liste / activer une source · Appui long sur une liste : l'activer ou la désactiver",
                        fontSize = 15.sp, color = Tv.Secondary.copy(alpha = 0.4f),
                        modifier = Modifier.padding(top = 20.dp, start = 4.dp),
                    )
                }
            }

            CompanionPanel(state.companion, Modifier.width(460.dp).fillMaxHeight())
        }

        // Toast façon tvOS
        AnimatedVisibility(
            visible = state.message != null,
            enter = fadeIn() + slideInVertically { it },
            exit = fadeOut() + slideOutVertically { it },
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 48.dp),
        ) {
            Box(
                Modifier.clip(CircleShape).background(Color(0xE62C2C2E)).border(1.dp, Tv.Hairline, CircleShape)
                    .padding(horizontal = 32.dp, vertical = 16.dp),
            ) { Text(state.message.orEmpty(), color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Medium) }
        }
    }
}

// ---------------------------------------------------------------- Panneau compagnon

@Composable
private fun CompanionPanel(state: CompanionState, modifier: Modifier) {
    Column(
        modifier.clip(RoundedCornerShape(32.dp)).background(Tv.Glass).border(1.dp, Tv.Hairline, RoundedCornerShape(32.dp))
            .padding(40.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("Gérer depuis un autre appareil", fontSize = 26.sp, fontWeight = FontWeight.SemiBold, color = Color.White)
        Spacer(Modifier.height(8.dp))
        Text(
            "Scannez le code avec votre téléphone, ou ouvrez l'adresse dans un navigateur sur le même réseau Wi-Fi.",
            fontSize = 17.sp, color = Tv.Secondary, lineHeight = 24.sp,
        )
        Spacer(Modifier.height(32.dp))

        when (state) {
            CompanionState.Starting -> PanelInfo("Démarrage…")
            CompanionState.NoNetwork -> PanelInfo("Aucun réseau local. Connectez la TV au Wi-Fi ou en Ethernet.")
            is CompanionState.Error -> PanelInfo(state.message, Tv.Red)
            is CompanionState.Running -> {
                Box(
                    Modifier.size(280.dp).clip(RoundedCornerShape(24.dp)).background(Color.White).padding(16.dp),
                ) {
                    Image(
                        bitmap = state.info.qr.asImageBitmap(),
                        contentDescription = "QR code de gestion des sources",
                        filterQuality = FilterQuality.None,
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                Spacer(Modifier.height(28.dp))
                Text(state.info.url.removePrefix("http://"), fontSize = 24.sp, fontWeight = FontWeight.SemiBold, color = Color.White)
                Spacer(Modifier.height(20.dp))
                Text("CODE", fontSize = 13.sp, letterSpacing = 2.sp, color = Tv.Secondary)
                Spacer(Modifier.height(4.dp))
                Text(
                    state.info.code.chunked(3).joinToString(" "),
                    fontSize = 40.sp, fontWeight = FontWeight.Bold, letterSpacing = 6.sp,
                    fontFamily = FontFamily.Monospace, color = Color.White,
                )
            }
        }
    }
}

@Composable
private fun PanelInfo(text: String, color: Color = Tv.Secondary) =
    Text(text, fontSize = 18.sp, color = color, modifier = Modifier.padding(vertical = 80.dp))

// ---------------------------------------------------------------- Lignes

@OptIn(ExperimentalTvMaterial3Api::class)
@Composable
private fun SubscriptionRow(sub: Subscription, onClick: () -> Unit, onLongClick: () -> Unit) {
    val meta = buildString {
        append("${sub.providers.size} source${if (sub.providers.size > 1) "s" else ""}")
        sub.lastSyncAt?.let { append(" · ").append(DateUtils.getRelativeTimeSpanString(it, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS)) }
        if (!sub.enabled) append(" · désactivée")
    }
    TvRow(
        title = sub.name,
        subtitle = sub.lastError?.let { "Erreur : $it" } ?: meta,
        subtitleColor = if (sub.lastError != null) Tv.Red else null,
        dimmed = !sub.enabled,
        trailing = "Synchroniser",
        status = when { sub.lastError != null -> Tv.Red; sub.enabled -> Tv.Green; else -> null },
        onClick = onClick,
        onLongClick = onLongClick,
    )
}

@OptIn(ExperimentalTvMaterial3Api::class)
@Composable
private fun ProviderRow(entry: ProviderEntry, onClick: () -> Unit) {
    val p = entry.provider
    val types = p.types.joinToString(" · ") { when (it.name) { "MOVIE" -> "Films"; "TV" -> "Séries"; else -> "Animes" } }
    TvRow(
        title = p.name,
        subtitle = "${entry.originName} · $types${p.language?.let { " · ${it.uppercase()}" } ?: ""}",
        dimmed = !entry.enabled,
        trailing = if (entry.enabled) "Activée" else "Désactivée",
        status = if (entry.enabled) Tv.Green else null,
        onClick = onClick,
    )
}

/** Ligne façon Réglages tvOS : verre au repos, blanche + zoom + halo au focus. */
@OptIn(ExperimentalTvMaterial3Api::class)
@Composable
private fun TvRow(
    title: String,
    subtitle: String,
    trailing: String?,
    onClick: () -> Unit,
    onLongClick: (() -> Unit)? = null,
    subtitleColor: Color? = null,
    status: Color? = null,
    dimmed: Boolean = false,
) {
    Surface(
        onClick = onClick,
        onLongClick = onLongClick,
        modifier = Modifier.fillMaxWidth(),
        shape = ClickableSurfaceDefaults.shape(Tv.Shape),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = Tv.Glass,
            contentColor = Color.White.copy(alpha = if (dimmed) 0.45f else 1f),
            focusedContainerColor = Color.White,
            focusedContentColor = Color.Black,
            pressedContainerColor = Color.White.copy(alpha = 0.85f),
            pressedContentColor = Color.Black,
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.03f, pressedScale = 0.99f),
        glow = ClickableSurfaceDefaults.glow(focusedGlow = Glow(Color.White.copy(alpha = 0.22f), 28.dp)),
    ) {
        Row(Modifier.padding(horizontal = 28.dp, vertical = 20.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(10.dp).clip(CircleShape).background(status ?: Color.Transparent)
                    .border(1.dp, if (status == null) LocalContentColor.current.copy(alpha = 0.4f) else Color.Transparent, CircleShape),
            )
            Spacer(Modifier.width(20.dp))
            Column(Modifier.weight(1f)) {
                Text(title, fontSize = 24.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(2.dp))
                Text(
                    subtitle, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    color = subtitleColor ?: LocalContentColor.current.copy(alpha = 0.6f),
                )
            }
            trailing?.let {
                Spacer(Modifier.width(16.dp))
                Text(it, fontSize = 18.sp, color = LocalContentColor.current.copy(alpha = 0.55f))
                Text("  ›", fontSize = 26.sp, color = LocalContentColor.current.copy(alpha = 0.35f))
            }
        }
    }
}

@OptIn(ExperimentalTvMaterial3Api::class)
@Composable
private fun PillButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Surface(
        onClick = onClick,
        modifier = modifier,
        shape = ClickableSurfaceDefaults.shape(CircleShape),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = Color.White.copy(alpha = 0.12f),
            contentColor = Color.White,
            focusedContainerColor = Color.White,
            focusedContentColor = Color.Black,
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.06f),
        glow = ClickableSurfaceDefaults.glow(focusedGlow = Glow(Color.White.copy(alpha = 0.25f), 24.dp)),
    ) {
        Text(text, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 36.dp, vertical = 14.dp))
    }
}

@Composable
private fun SectionTitle(title: String, detail: String) {
    Row(Modifier.fillMaxWidth().padding(top = 20.dp, bottom = 4.dp, start = 4.dp), verticalAlignment = Alignment.Bottom) {
        Text(title, fontSize = 28.sp, fontWeight = FontWeight.Bold, color = Color.White)
        Spacer(Modifier.width(14.dp))
        Text(detail, fontSize = 18.sp, color = Tv.Secondary, modifier = Modifier.padding(bottom = 3.dp))
    }
}

@Composable
private fun EmptyRow(text: String) {
    Box(
        Modifier.fillMaxWidth().clip(Tv.Shape).border(1.dp, Tv.Hairline, Tv.Shape).padding(horizontal = 28.dp, vertical = 26.dp),
    ) { Text(text, fontSize = 18.sp, color = Tv.Secondary) }
}
