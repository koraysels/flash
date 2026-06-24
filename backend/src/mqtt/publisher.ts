/**
 * MQTT speed-event publisher — a side-channel only. It NEVER blocks or affects
 * the detection/tracking/speed pipeline: one shared client, fire-and-forget
 * QoS 0, auto-reconnect, and if the broker is down the event is dropped.
 *
 * Topic/payload contract (consumed by flash-artnet-python -> Art-Net strobe):
 *   topic:   krocky/speed (env MQTT_TOPIC)
 *   payload: {"feed": "<cameraId>", "track_id": <int>, "speed_kmh": <float>, "ts": <unix epoch seconds float>}
 */
import mqtt, { type MqttClient } from 'mqtt'

const HOST = process.env.MQTT_HOST ?? '100.71.177.9'
const PORT = Number(process.env.MQTT_PORT ?? 1883)
const USER = process.env.MQTT_USER ?? 'flash'
const PASS = process.env.MQTT_PASS ?? ''
const TOPIC = process.env.MQTT_TOPIC ?? 'krocky/speed'
const SPEED_FLOOR = Number(process.env.MQTT_SPEED_FLOOR ?? 0)

let client: MqttClient | null = null

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
 */
export function publishSpeed(feed: string, trackId: number, speedKmh: number, ts: number): void {
  if (!client || !client.connected) return       // broker down -> drop, don't block
  if (speedKmh < SPEED_FLOOR) return              // coarse prefilter; real limit is downstream
  const payload = JSON.stringify({
    feed,
    track_id: trackId,
    speed_kmh: Math.round(speedKmh * 10) / 10,
    ts,
  })
  client.publish(TOPIC, payload, { qos: 0 })
}
