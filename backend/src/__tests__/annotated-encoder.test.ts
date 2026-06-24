import { describe, it, expect, vi, afterEach } from 'vitest'
import { AnnotatedEncoder } from '../stream/annotated-encoder'

describe('AnnotatedEncoder', () => {
  afterEach(() => { vi.useRealTimers() })

  it('exposes a playlist path under the out dir', () => {
    const enc = new AnnotatedEncoder('camA', '/tmp/flash-hls/camA')
    expect(enc.playlistPath).toBe('/tmp/flash-hls/camA/index.m3u8')
  })

  it('idle-stops after IDLE_MS without touch', () => {
    vi.useFakeTimers()
    const enc = new AnnotatedEncoder('camA', '/tmp/flash-hls/camA')
    enc.start()
    expect(enc.isActive()).toBe(true)
    vi.advanceTimersByTime(20_000)
    expect(enc.isActive()).toBe(false)
    enc.stop()
  })

  it('touch resets the idle timer', () => {
    vi.useFakeTimers()
    const enc = new AnnotatedEncoder('camA', '/tmp/flash-hls/camA')
    enc.start()
    vi.advanceTimersByTime(10_000)
    enc.touch()
    vi.advanceTimersByTime(10_000)
    expect(enc.isActive()).toBe(true)  // 10s after touch < 15s idle
    enc.stop()
  })
})
