# Flash → MQTT speed-event format

Flash publishes one MQTT message per vehicle the moment its speed is confidently
measured. The `flash-artnet-python` strobe service consumes these to fire the
Art-Net strobe when a speeder appears **on the kiosk screen**.

## Connection

| | |
|---|---|
| Broker | `mqtt://100.71.177.9:1883` (Tailscale) |
| Username | `flash` |
| Password | (env `MQTT_PASS`) |
| Topic | `krocky/speed` |
| QoS | 0 (fire-and-forget; missed messages are not retried) |
| Retain | no |

## Payload (JSON, UTF-8)

Keys are **camelCase** (`trackId`/`speedKmh`/`maxSpeedKmh`); only `hls_latency_s` is snake_case.

```json
{
  "feed": "cmqrxxcjc0001lrpdik7bz3qz",
  "location": "Zelzatetunnel & A11",
  "direction": "AB",
  "trackId": 1234,
  "speedKmh": 138.4,
  "maxSpeedKmh": 120,
  "ts": 1750800000.123,
  "hls_latency_s": 8.0
}
```

| Field | Type | Meaning |
|---|---|---|
| `feed` | string | Camera id (stable per camera, = the `/display/<id>` route id). |
| `location` | string | Human-readable camera location/name (from the DB). |
| `direction` | `"AB"` \| `"BA"` \| `null` | Travel direction across the counting lines. `null` if not determinable (e.g. continuous-speed mode). |
| `trackId` | int | Per-feed vehicle track id. **Unique only within a feed** — dedupe on `(feed, trackId)`. Resets when the camera worker restarts. |
| `speedKmh` | float | Measured speed (1 decimal). |
| `maxSpeedKmh` | int \| null | Posted limit for this feed. `null` if the camera is uncalibrated / no limit set. |
| `ts` | float | Unix epoch **seconds** of the real detection moment (the frame's ingest time). NOT when the message was sent. |
| `hls_latency_s` | float | Estimated delay between `ts` and when that moment is visible on the kiosk screen (encode + HLS segmenting + player buffer). |

## How the strobe should use it

1. **Filter**: flash only if `maxSpeedKmh != null && speedKmh > maxSpeedKmh`
   (plus any margin you want). Flash sends every confident reading; the limit
   decision is yours.
2. **Dedupe**: ignore a `(feed, trackId)` already handled within ~10 s.
3. **Schedule (display-synced)**: the speeder is on screen at
   `screen_time = ts + hls_latency_s`. Fire the strobe at
   `screen_time + DISPLAY_DELAY` (your own fine-tune offset). If `screen_time`
   is already in the past by more than a small grace window, skip (stale).
4. **Per-feed**: one strobe per feed/screen — use `feed` (or `location`) to
   route to the right fixture/universe.

## Notes

- `hls_latency_s` is currently a **configured estimate** (env `HLS_LATENCY_S`
  on the Flash backend, default 8.0). Tune it once by eyeballing a car on the
  Pi vs. the strobe; it's fairly constant per kiosk. It is published (not
  hard-coded in the strobe) so it can be adjusted without touching the strobe.
- Extra/unknown fields may be added in future `schema` versions — ignore
  unknown keys; don't hard-fail on them.
- Messages are **dropped** (not queued) when the broker is unreachable — the
  publisher never blocks the detection pipeline.
