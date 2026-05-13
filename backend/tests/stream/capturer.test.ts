import { describe, it, expect, vi } from 'vitest'

vi.mock('ffmpeg-static', () => ({ default: '/usr/bin/ffmpeg' }))

vi.mock('fluent-ffmpeg', () => {
  const mockInstance = {
    inputOptions: vi.fn().mockReturnThis(),
    output: vi.fn().mockReturnThis(),
    outputOptions: vi.fn().mockReturnThis(),
    on: vi.fn().mockReturnThis(),
    run: vi.fn(),
    kill: vi.fn(),
    setFfmpegPath: vi.fn(),
  }
  const mockFfmpeg = Object.assign(vi.fn(() => mockInstance), {
    setFfmpegPath: vi.fn(),
  })
  return { default: mockFfmpeg }
})

import { FrameCapturer } from '../../src/stream/capturer'

describe('FrameCapturer', () => {
  it('starts and stops correctly', () => {
    const capturer = new FrameCapturer('https://example.com/stream.m3u8', 'cam1')
    capturer.start()
    expect(capturer.isRunning()).toBe(true)
    capturer.stop()
    expect(capturer.isRunning()).toBe(false)
  })

  it('does not start twice', () => {
    const capturer = new FrameCapturer('https://example.com/stream.m3u8', 'cam1')
    capturer.start()
    capturer.start()
    expect(capturer.isRunning()).toBe(true)
    capturer.stop()
  })
})
