import { existsSync } from 'fs'
import ffmpegStatic from 'ffmpeg-static'

export function resolveFfmpegPath(): string {
  if (process.platform === 'darwin') {
    for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
      if (existsSync(p)) return p
    }
  }
  if (existsSync('/usr/bin/ffmpeg')) return '/usr/bin/ffmpeg'
  return ffmpegStatic!
}
