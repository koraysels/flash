import ytdlp from 'yt-dlp-exec'

type YtdlpResult = {
  url?: string
  [key: string]: unknown
}

export async function extractStreamUrl(cameraPageUrl: string): Promise<string> {
  let result: YtdlpResult
  try {
    result = await ytdlp(cameraPageUrl, {
      getUrl: true,
      noPlaylist: true,
      format: 'best',
    }) as YtdlpResult
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`No stream URL found for ${cameraPageUrl}: ${message}`)
  }

  if (!result.url) {
    throw new Error(`No stream URL found for ${cameraPageUrl}: yt-dlp returned no URL`)
  }

  return result.url
}
