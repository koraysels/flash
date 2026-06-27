import { db } from './db'
import { getStreamer } from './camera-worker'

// Persists per-camera daily AB/BA/speeder totals into DailyCount, and resets the
// live counters at local midnight.
//
// Why a delta model instead of writing the running total: a worker restart (or a
// manual reset-counts) zeroes the in-memory counter mid-day. If we wrote the raw
// running total we'd overwrite the day's row with the lower post-reset value and
// lose the morning's count. Instead we accumulate DELTAS: each tick adds
// (current - lastSeen) to today's row, and treats current < lastSeen as a reset
// (delta = current). The day's row therefore keeps growing regardless of resets.

type Counts = { AB: number; BA: number; speeders: number }
const lastSeen = new Map<string, Counts>()

function localMidnight(d = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}
let currentDay = localMidnight()

async function flushDeltas(forDay: Date): Promise<void> {
  const cameras = await db.camera.findMany({ select: { id: true } })
  for (const cam of cameras) {
    const s = getStreamer(cam.id)
    if (!s) continue
    const c = s.getCounts()
    const last = lastSeen.get(cam.id) ?? { AB: 0, BA: 0, speeders: 0 }
    const dAB = c.AB >= last.AB ? c.AB - last.AB : c.AB
    const dBA = c.BA >= last.BA ? c.BA - last.BA : c.BA
    const dSp = c.speeders >= last.speeders ? c.speeders - last.speeders : c.speeders
    lastSeen.set(cam.id, c)
    if (dAB === 0 && dBA === 0 && dSp === 0) continue
    try {
      await db.dailyCount.upsert({
        where: { cameraId_date: { cameraId: cam.id, date: forDay } },
        create: { cameraId: cam.id, date: forDay, directionAB: dAB, directionBA: dBA, speeders: dSp },
        update: { directionAB: { increment: dAB }, directionBA: { increment: dBA }, speeders: { increment: dSp } },
      })
    } catch (e) {
      console.warn(`[daily] upsert failed for ${cam.id}:`, (e as Error).message)
    }
  }
}

export function startDailyCountPersistence(): void {
  const tick = async () => {
    const todayMid = localMidnight()
    if (todayMid.getTime() !== currentDay.getTime()) {
      // Day rolled over: capture yesterday's final delta, reset the live counters
      // so the dashboard starts the new day at 0, and measure today from scratch.
      await flushDeltas(currentDay)
      const cameras = await db.camera.findMany({ select: { id: true } })
      for (const cam of cameras) getStreamer(cam.id)?.resetDailyCounts()
      lastSeen.clear()
      currentDay = todayMid
    } else {
      await flushDeltas(currentDay)
    }
  }
  setInterval(() => { void tick().catch((e) => console.warn('[daily] tick failed:', e)) }, 60_000)
}
