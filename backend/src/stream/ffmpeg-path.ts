import { existsSync } from 'fs'
import ffmpegStatic from 'ffmpeg-static'

export function resolveFfmpegPath(): string {
  if (process.platform === 'darwin') {
    for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
      if (existsSync(p)) return p
    }
  }
  // Prefer the modern NVENC-enabled jellyfin-ffmpeg (installed in the Docker image),
  // then a system ffmpeg, then the bundled static binary.
  for (const p of ['/usr/lib/jellyfin-ffmpeg/ffmpeg', '/usr/bin/ffmpeg']) {
    if (existsSync(p)) return p
  }
  return ffmpegStatic!
}
