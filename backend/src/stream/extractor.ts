import ytdlp from 'yt-dlp-exec'

export async function extractStreamUrl(cameraPageUrl: string): Promise<string> {
  const result = await (ytdlp as any)(cameraPageUrl, {
    getUrl: true,
    noPlaylist: true,
    format: 'best',
  }) as { url?: string }

  if (!result.url) {
    throw new Error(`No stream URL found for ${cameraPageUrl}`)
  }

  return result.url
}
