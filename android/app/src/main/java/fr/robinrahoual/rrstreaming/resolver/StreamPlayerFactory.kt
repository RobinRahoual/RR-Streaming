package fr.robinrahoual.rrstreaming.resolver

import android.content.Context
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory

/** Passe un StreamCandidate à ExoPlayer en rejouant ses headers sur le manifest ET les segments. */
@OptIn(UnstableApi::class)
object StreamPlayerFactory {

    fun play(context: Context, player: ExoPlayer, stream: StreamCandidate, startPositionMs: Long = 0) {
        val ua = stream.headers.getIgnoreCase("User-Agent")
        val props = stream.headers.filterKeys { !it.equals("User-Agent", ignoreCase = true) }

        val http = DefaultHttpDataSource.Factory()
            .setUserAgent(ua)
            .setDefaultRequestProperties(props)
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(15_000)

        val mediaSourceFactory = DefaultMediaSourceFactory(DefaultDataSource.Factory(context, http))

        val item = MediaItem.Builder()
            .setUri(stream.url)
            .setMimeType(
                when (stream.type) {
                    StreamType.HLS -> MimeTypes.APPLICATION_M3U8
                    StreamType.DASH -> MimeTypes.APPLICATION_MPD
                    StreamType.PROGRESSIVE -> MimeTypes.VIDEO_MP4
                }
            )
            .build()

        player.setMediaSource(mediaSourceFactory.createMediaSource(item), startPositionMs)
        player.prepare()
        player.playWhenReady = true
    }
}
