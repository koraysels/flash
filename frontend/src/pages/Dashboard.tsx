import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useCameras } from '../hooks/useCameras'
import { useCameraFeed } from '../hooks/useCameraFeed'
import { CameraStream } from '../components/CameraStream'
import { Camera, resetCounts, testMqttFlash, setDisplaySlot, DISPLAY_SLOTS } from '../lib/api'
import type { TrapMeasurement } from '../hooks/useCameraFeed'
import { Spinner, LoadingOverlay } from '../components/ui/Spinner'
import { HealthPanel } from '../components/HealthPanel'
import { PageHeader } from '../components/ui/primitives'

function TrapCol({ measurements, maxSpeedKmh, label }: { measurements: TrapMeasurement[]; maxSpeedKmh: number | null; label: string }) {
  const now = Date.now()
  return (
    <div className="flex-1 min-w-0">
      <p className="px-2 pt-2 pb-1 text-xs uppercase tracking-widest text-stone-400 font-bold">{label}</p>
      {measurements.length === 0 ? (
        <p className="px-2 pb-2 text-xs text-stone-300">—</p>
      ) : (
        <div className="divide-y divide-stone-100">
          {measurements.slice(0, 5).map((m, i) => {
            const agoS = Math.round((now - m.timestamp) / 1000)
            const agoStr = agoS < 60 ? `${agoS}s` : `${Math.round(agoS / 60)}m`
            return (
              <div key={i} className="flex items-center justify-between px-2 py-1 text-xs tabular-nums">
                <span className={`font-bold ${m.isSpeeder ? 'text-red-600' : ''}`}>
                  {Math.round(m.speedKmh)}
                  {m.isSpeeder && maxSpeedKmh && (
                    <span className="font-normal text-red-500 ml-0.5">+{Math.round(m.speedKmh - maxSpeedKmh)}</span>
                  )}
                  <span className="font-normal text-stone-400 ml-0.5">km/h</span>
                </span>
                <span className="text-stone-300 text-xs">{agoStr}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function TrapLog({ measurements, maxSpeedKmh }: { measurements: TrapMeasurement[]; maxSpeedKmh: number | null }) {
  if (!measurements.length) return (
    <div className="border-t-2 border-black px-3 py-2 text-xs text-stone-400 uppercase tracking-widest">
      Nog geen metingen — wachten op voertuigen die beide lijnen kruisen
    </div>
  )
  const ab = measurements.filter((m) => m.direction === 'AB')
  const ba = measurements.filter((m) => m.direction === 'BA')
  return (
    <div className="border-t-2 border-black">
      <p className="px-3 pt-2 text-xs uppercase tracking-widest text-stone-400 font-bold">Recente trap-metingen</p>
      <div className="flex divide-x divide-stone-200">
        <TrapCol measurements={ab} maxSpeedKmh={maxSpeedKmh} label="A→B" />
        <TrapCol measurements={ba} maxSpeedKmh={maxSpeedKmh} label="B→A" />
      </div>
    </div>
  )
}

function CameraCard({ cam }: { cam: Camera }) {
  const [resetting, setResetting] = useState(false)
  const qc = useQueryClient()
  const { aiFps, videoFps, counts, avgSpeedKmh, active, recentTrapMeasurements } = useCameraFeed(cam.id)
  const totalVehicles = counts.AB + counts.BA

  const onSlotChange = async (slot: string) => {
    await setDisplaySlot(cam.id, slot || null)
    qc.invalidateQueries({ queryKey: ['cameras'] })
  }

  const calibrated = cam.homographyMatrix?.length === 9

  return (
    <div className="border-2 border-black bg-white">
      {/* Header: identity + live status only */}
      <div className="flex justify-between items-start px-3 py-2 border-b-2 border-black">
        <div className="min-w-0">
          <p className="font-bold text-sm uppercase tracking-wide truncate">{cam.name}</p>
          <p className="text-xs text-stone-500 truncate">{cam.location}</p>
        </div>
        {active ? (
          <div className="flex items-center gap-3 text-xs tabular-nums shrink-0">
            <span className="text-stone-400">{videoFps}fps</span>
            <span className="border border-black px-1.5 py-0.5 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-black animate-pulse" />
              AI {aiFps}fps
            </span>
          </div>
        ) : (
          <span className="text-xs text-stone-500 border border-stone-300 px-2 py-0.5 flex items-center gap-1.5 shrink-0">
            <Spinner className="h-3 w-3" />
            OPSTARTEN
          </span>
        )}
      </div>

      <div className="relative">
        <CameraStream
          cameraId={cam.id}
          lineA={cam.countingLineA}
          lineB={cam.countingLineB}
          lineAPoints={cam.countingLineAPoints}
          lineBPoints={cam.countingLineBPoints}
          maxSpeedKmh={cam.maxSpeedKmh}
          className="aspect-[4/3]"
        />
        {!active && <LoadingOverlay label="Opstarten…" sub="camera verbindt / herstart — even wachten" />}
      </div>

      <div className="grid grid-cols-3 border-t-2 border-black">
        <div className="py-3 text-center border-r-2 border-black">
          <p className="text-xs uppercase tracking-widest text-stone-400 mb-1">A→B</p>
          <p className="text-2xl font-bold tabular-nums">{counts.AB}</p>
        </div>
        <div className="py-3 text-center border-r-2 border-black">
          <p className="text-xs uppercase tracking-widest text-stone-400 mb-1">B→A</p>
          <p className="text-2xl font-bold tabular-nums">{counts.BA}</p>
        </div>
        <div className="py-3 text-center">
          <p className="text-xs uppercase tracking-widest text-stone-400 mb-1">Totaal</p>
          <p className="text-2xl font-bold tabular-nums">{totalVehicles}</p>
        </div>
      </div>

      {/* Action bar — every camera action, colour-coded, above the detection list */}
      <div className="flex items-center gap-2 px-3 py-2 border-t-2 border-black">
        <select
          value={cam.displaySlot ?? ''}
          onChange={(e) => onSlotChange(e.target.value)}
          title="Welke vaste Pi-kiosk deze camera toont"
          className="text-xs uppercase tracking-wide border-2 border-black px-1.5 py-1.5 bg-white hover:bg-stone-50 focus:outline-none"
        >
          <option value="">— Geen Pi —</option>
          {DISPLAY_SLOTS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <a
          href={`/cameras/${cam.id}/calibrate`}
          title={calibrated ? 'Kalibratie & tracking aanpassen' : 'Nog niet gekalibreerd — klik om te kalibreren'}
          className={`text-xs uppercase tracking-wide border-2 px-2.5 py-1.5 transition-colors ${
            calibrated
              ? 'border-black hover:bg-black hover:text-white'
              : 'border-warn text-warn hover:bg-warn hover:text-white'
          }`}
        >
          {calibrated ? 'Kalibreren' : 'Kalibreren ⚠'}
        </a>
        <a
          href={`/camera/${cam.id}`}
          target="_blank"
          rel="noreferrer"
          title="Open de live fullscreen-weergave"
          className="text-xs uppercase tracking-wide border-2 border-black bg-black text-white px-2.5 py-1.5 hover:bg-stone-800 transition-colors"
        >
          Live ↗
        </a>
        <button
          onClick={async () => {
            setResetting(true)
            try { await resetCounts(cam.id) } finally { setResetting(false) }
          }}
          disabled={resetting}
          title="Tellingen voor deze camera op nul zetten"
          className="ml-auto text-xs uppercase tracking-wide border-2 border-danger text-danger px-2.5 py-1.5 hover:bg-danger hover:text-white disabled:opacity-40 transition-colors"
        >
          {resetting ? '…' : 'Reset'}
        </button>
      </div>

      {/* Speed status strip (info only — no navigation here) */}
      <div className="flex items-center justify-between px-3 py-2 border-t-2 border-black text-xs">
        <span>
          {calibrated
            ? avgSpeedKmh !== null
              ? <span className="font-bold">GEM {Math.round(avgSpeedKmh)} KM/H</span>
              : <span className="text-stone-500">SNELHEID GEKALIBREERD</span>
            : <span className="text-warn font-bold uppercase tracking-widest">Niet gekalibreerd</span>}
        </span>
        {cam.maxSpeedKmh != null && counts.speeders > 0 && (
          <span className="text-danger font-bold">{counts.speeders}× &gt;{cam.maxSpeedKmh}</span>
        )}
      </div>

      {cam.trapSpeedEnabled && (
        <TrapLog measurements={recentTrapMeasurements} maxSpeedKmh={cam.maxSpeedKmh} />
      )}
    </div>
  )
}

export default function Dashboard() {
  const { data: cameras, isLoading, error } = useCameras()
  const [flashMsg, setFlashMsg] = useState<string | null>(null)
  const [flashing, setFlashing] = useState(false)

  const triggerFlash = async () => {
    setFlashing(true)
    setFlashMsg(null)
    try {
      const r = await testMqttFlash()
      setFlashMsg(r.connected ? '✓ Test-flits gepubliceerd naar krocky/speed' : '⚠ Broker niet verbonden — controleer de MQTT-env op de backend')
    } catch {
      setFlashMsg('✗ Test mislukt')
    } finally {
      setFlashing(false)
      setTimeout(() => setFlashMsg(null), 6000)
    }
  }

  if (isLoading) return <div className="flex items-center gap-2 text-stone-400 text-xs uppercase tracking-widest p-8"><Spinner /> Laden…</div>
  if (error) return <div className="text-red-600 text-xs uppercase tracking-widest p-8">Camera's laden mislukt</div>
  if (!cameras?.length) return (
    <div className="p-8 text-xs text-stone-500 uppercase tracking-widest">
      Geen camera's geconfigureerd. <a href="/cameras" className="underline text-black">Voeg er een toe →</a>
    </div>
  )

  return (
    <div>
      <PageHeader
        eyebrow="Flash · verkeersmonitor"
        title="Overzicht"
        right={
          <>
            {flashMsg && <span className="text-xs text-stone-600">{flashMsg}</span>}
            <button
              onClick={triggerFlash}
              disabled={flashing}
              className="border-2 border-black px-3 py-1.5 text-xs font-bold uppercase tracking-wide bg-danger text-white hover:opacity-90 disabled:opacity-50"
            >
              {flashing ? 'Verzenden…' : '🚨 Test-flash'}
            </button>
          </>
        }
      />

      {/* System status: MQTT strobe + per-Pi reachability / page / stream + refresh. */}
      <HealthPanel />

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {cameras.map((cam) => (
          <CameraCard key={cam.id} cam={cam} />
        ))}
      </div>
    </div>
  )
}
