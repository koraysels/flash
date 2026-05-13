import { describe, it, expect, vi } from 'vitest'
import { extractStreamUrl } from '../../src/stream/extractor'

vi.mock('yt-dlp-exec', () => ({
  default: vi.fn().mockResolvedValue({
    url: 'https://streams.example.com/camera1/playlist.m3u8',
  }),
}))

describe('extractStreamUrl', () => {
  it('returns the HLS stream URL for a camera page', async () => {
    const url = await extractStreamUrl('https://www.verkeerscentrum.be/camerabeelden/123')
    expect(url).toBe('https://streams.example.com/camera1/playlist.m3u8')
  })

  it('throws if yt-dlp returns no url', async () => {
    const ytdlp = await import('yt-dlp-exec')
    vi.mocked(ytdlp.default).mockResolvedValueOnce({} as any)
    await expect(extractStreamUrl('https://example.com')).rejects.toThrow('No stream URL found')
  })
})
