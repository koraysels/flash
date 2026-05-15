import ytdlp from 'yt-dlp-exec'

type YtdlpResult = {
  url?: string
  [key: string]: unknown
}

const DIRECT_STREAM_RE = /\.(m3u8|m3u)(\?|$)/i

function tryVerkeerscentrum(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.hostname === 'players.media.verkeerscentrum.be') {
      const name = parsed.searchParams.get('name')
      if (name) {
        return `https://hls.media.verkeerscentrum.be/${name}.stream/playlist.m3u8`
      }
    }
  } catch { /* not a valid URL */ }
  return null
}

export async function extractStreamUrl(rawUrl: string): Promise<string> {
  const pageUrl = rawUrl.trim()
  // verkeerscentrum.be player page → construct HLS URL directly
  const vcUrl = tryVerkeerscentrum(pageUrl)
  if (vcUrl) return vcUrl

  // Direct HLS / RTSP / RTMP URLs pass through unchanged
  if (DIRECT_STREAM_RE.test(pageUrl) || /^(rtsp|rtmp|rtp):\/\//i.test(pageUrl)) {
    return pageUrl
  }

  // Fall back to yt-dlp for generic page URLs
  let result: YtdlpResult
  try {
    result = await ytdlp(pageUrl, {
      getUrl: true,
      noPlaylist: true,
      format: 'best',
    }) as YtdlpResult
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`No stream URL found for ${pageUrl}: ${message}`)
  }

  if (!result.url) {
    throw new Error(`No stream URL found for ${pageUrl}: yt-dlp returned no URL`)
  }

  return result.url
}
