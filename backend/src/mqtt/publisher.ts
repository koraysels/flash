/**
 * MQTT speed-event publisher — a side-channel only. It NEVER blocks or affects
 * the detection/tracking/speed pipeline: one shared client, fire-and-forget
 * QoS 0, auto-reconnect, and if the broker is down the event is dropped.
 *
 * Topic/payload contract is documented in docs/mqtt-speed-format.md (consumed by
 * flash-artnet-python -> Art-Net strobe). Topic krocky/speed (env MQTT_TOPIC).
 */
import mqtt, { type MqttClient } from 'mqtt'

const HOST = process.env.MQTT_HOST ?? '100.71.177.9'
const PORT = Number(process.env.MQTT_PORT ?? 1883)
const USER = process.env.MQTT_USER ?? 'flash'
const PASS = process.env.MQTT_PASS ?? ''
const TOPIC = process.env.MQTT_TOPIC ?? 'krocky/speed'
const SPEED_FLOOR = Number(process.env.MQTT_SPEED_FLOOR ?? 0)
// Estimated delay (s) between detection (ts) and the moment it shows on the kiosk
// screen — encode + HLS segmenting + player buffer. Tune per kiosk; published so
// the strobe schedules flash_at = ts + hls_latency_s without code changes.
export const HLS_LATENCY_S = Number(process.env.HLS_LATENCY_S ?? 8)

export type SpeedEvent = {
  feed: string
  location: string
  direction: 'AB' | 'BA' | null
  trackId: number
  speedKmh: number
  maxSpeedKmh: number | null
  ts: number
  hls_latency_s : number
}

let client: MqttClient | null = null

/** True when the shared client is connected to the broker. */
export function mqttConnected(): boolean {
  return !!(client && client.connected)
}

/** Connect once at startup. No-op (with a warning) when no password is configured. */
export function connectMqtt(): void {
  if (client) return
  if (!PASS) {
    console.warn('[mqtt] MQTT_PASS not set — speed publisher disabled')
    return
  }
  client = mqtt.connect(`mqtt://${HOST}:${PORT}`, {
    username: USER,
    password: PASS,
    reconnectPeriod: 5_000,   // auto-reconnect
    connectTimeout: 10_000,
    clean: true,
  })
  client.on('connect', () => console.log(`[mqtt] connected ${HOST}:${PORT} -> topic "${TOPIC}"`))
  client.on('error', (err) => console.warn(`[mqtt] error: ${err.message}`))
  client.on('reconnect', () => console.warn('[mqtt] reconnecting…'))
}

/**
 * Publish one confident speed reading for a vehicle. Fire-and-forget: returns
 * immediately, drops the event if the broker is unreachable, never throws.
 * Payload schema: docs/mqtt-speed-format.md.
 */
export function publishSpeed(e: SpeedEvent): void {
  if (!client || !client.connected) return       // broker down -> drop, don't block
  if (e.speedKmh < SPEED_FLOOR) return            // coarse prefilter; real limit is downstream
  const payload = JSON.stringify({
    schema: 1,
    feed: e.feed,
    location: e.location,
    direction: e.direction,
    track_id: e.trackId,
    speed_kmh: Math.round(e.speedKmh * 10) / 10,
    max_speed_kmh: e.maxSpeedKmh,
    ts: e.ts,
    hls_latency_s: e.hls_latency_s,
  })
  client.publish(TOPIC, payload, { qos: 0 })
}
