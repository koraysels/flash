import { describe, it, expect, vi, afterEach } from 'vitest'
import { AnnotatedEncoder } from '../stream/annotated-encoder'

describe('AnnotatedEncoder', () => {
  afterEach(() => { vi.useRealTimers() })

  it('exposes a playlist path under the out dir', () => {
    const enc = new AnnotatedEncoder('camA', '/tmp/flash-hls/camA')
    expect(enc.playlistPath).toBe('/tmp/flash-hls/camA/index.m3u8')
  })

  it('stays active until stop() (always-on, no idle auto-stop)', () => {
    vi.useFakeTimers()
    const enc = new AnnotatedEncoder('camA', '/tmp/flash-hls/camA')
    enc.start()
    expect(enc.isActive()).toBe(true)
    vi.advanceTimersByTime(60_000)
    expect(enc.isActive()).toBe(true)   // never idle-stops
    enc.stop()
    expect(enc.isActive()).toBe(false)
  })
})
