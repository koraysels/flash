import { useQuery, useMutation } from '@tanstack/react-query'
import { getHealth, reloadKiosk, getCameras } from '../lib/api'
import { Spinner } from './ui/Spinner'

function ago(ts: number | null): string {
  if (!ts) return 'nooit'
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}u`
}

function Dot({ ok, label, title }: { ok: boolean; label: string; title?: string }) {
  return (
    <span title={title} className="flex items-center gap-1 text-[11px] uppercase tracking-wide cursor-help">
      <span className={`w-2 h-2 rounded-full ${ok ? 'bg-ok' : 'bg-danger'}`} />
      <span className={ok ? 'text-ink' : 'text-stone-400'}>{label}</span>
    </span>
  )
}

export function HealthPanel() {
  const { data, isLoading } = useQuery({ queryKey: ['health'], queryFn: getHealth, refetchInterval: 10_000 })
  // Shared cache with the dashboard/admin list, so the number matches there (i+1 over getCameras order).
  const { data: cams } = useQuery({ queryKey: ['cameras'], queryFn: getCameras })
  const numByName = new Map((cams ?? []).map((c, i) => [c.name, i + 1]))
  const reload = useMutation({ mutationFn: reloadKiosk })

  return (
    <div className="border-2 border-black mb-6">
      <div className="flex items-center justify-between px-3 py-1.5 border-b-2 border-black">
        <span className="text-xs font-bold uppercase tracking-widest">Systeemstatus</span>
        {isLoading && <Spinner className="h-3 w-3" />}
      </div>

      {/* MQTT / strobe */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 border-b border-stone-200 text-xs">
        <span className="font-bold uppercase tracking-widest w-20" title="MQTT-broker die de fysieke flits-strobe aanstuurt (krocky/speed)">MQTT</span>
        <Dot
          ok={!!data?.mqtt.connected}
          label={data?.mqtt.connected ? 'verbonden' : data?.mqtt.configured ? 'offline' : 'uit'}
          title="Verbinding met de MQTT-broker. Verbonden = speeder-events worden gepubliceerd en de strobe kan flitsen."
        />
        <span className="text-stone-400">{data?.mqtt.host}</span>
        <span className="text-stone-400 ml-auto tabular-nums">
          {data?.mqtt.publishCount ?? 0} flits{data?.mqtt.publishCount === 1 ? '' : 'en'} · laatste {ago(data?.mqtt.lastPublishAt ?? null)}
          {data?.mqtt.lastEvent && <span className="text-stone-500"> ({Math.round(data.mqtt.lastEvent.speedKmh)} km/h)</span>}
        </span>
      </div>

      {/* Pi kiosks */}
      {data?.pis.map((p) => {
        const url = `${window.location.origin}/display/${p.slot}`
        return (
          <div key={p.slot} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 border-b border-stone-200 last:border-b-0 text-xs">
            <span
              className="font-mono font-bold w-20 shrink-0 flex items-center gap-1.5 cursor-help"
              title={p.online ? 'Pi is online en werkt (pagina of stream actief)' : 'Pi lijkt offline — geen pagina-heartbeat én geen stream-activiteit'}
            >
              <span className={`w-2 h-2 rounded-full ${p.online ? 'bg-ok' : 'bg-danger'}`} />
              {p.slot.replace('FLASH-', '')}
            </span>
            <Dot
              ok={p.pageAlive}
              label="pagina"
              title="De kiosk-pagina stuurt een socket-heartbeat — groen = pagina is geladen en rendert in de browser. Rood = geen recente heartbeat (pagina niet geladen of oude build → Refresh)."
            />
            <Dot
              ok={p.streaming}
              label="stream"
              title="De Pi haalt recent geannoteerde HLS-segmenten op — groen = de videostream wordt daadwerkelijk getoond."
            />
            <span className={`flex items-center gap-1.5 truncate ${p.camera ? 'text-ink' : 'text-stone-400'}`}>
              {p.camera && numByName.has(p.camera) && (
                <span className="shrink-0 text-[11px] font-bold border border-black px-1 leading-tight tabular-nums">{numByName.get(p.camera)}</span>
              )}
              <span className="truncate">{p.camera ?? '— niet toegewezen —'}</span>
            </span>
            <div className="ml-auto flex items-center gap-3">
              <a href={url} target="_blank" rel="noreferrer" className="font-mono text-stone-400 underline hover:text-black truncate max-w-[14rem]">{url}</a>
              <button
                onClick={() => reload.mutate(p.slot)}
                disabled={reload.isPending}
                title="Stuur een refresh naar deze kiosk"
                className="text-xs uppercase tracking-wide border border-black px-2 py-0.5 hover:bg-black hover:text-white disabled:opacity-40 transition-colors"
              >
                {reload.isPending && reload.variables === p.slot ? '…' : 'Refresh'}
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
