# Raspberry Pi Kiosk Setup — Flash Annotated Display

Each Pi shows **one camera, fullscreen**, playing the backend's annotated H.264/HLS
stream (boxes + counts HUD burned into the video). No app chrome, no scrollbar.

The kiosk route is `/display/<cameraId>`. The video source it loads is
`/api/cameras/<cameraId>/annotated/index.m3u8` (served on demand — the encoder
starts when the first segment is requested and idle-stops ~15 s after the last).

## 1. Put the host and the Pis on Tailscale

Direct WireGuard between the Pi and the rtx4090 host avoids the Cloudflare tunnel
(no websocket-idle limits, lower latency, more stable). The Cloudflare tunnel stays
for public access.

On the **rtx4090 host** and on **each Pi**:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Note the host's tailnet name (MagicDNS, e.g. `rtx4090-win10`) or its `100.x.y.z`
address. From a Pi, confirm the backend is reachable (replace `<id>` with a running
camera id):

```bash
curl -sI http://<tailnet-host>/display/<id>          # 200 (HTML)
curl -s  http://<tailnet-host>/api/cameras/<id>/annotated/index.m3u8 | head   # #EXTM3U after ~1-3s
```

> The frontend (nginx) listens on port 80 in its container; ensure that port is
> published on the host and reachable over the tailnet (the existing public setup
> already exposes the frontend — use the same host:port over Tailscale).

## 2. Chromium kiosk autostart (per Pi)

Install Chromium if needed (`sudo apt install chromium-browser`). One Pi → one
`cameraId`.

Launch command:

```bash
chromium-browser --kiosk --noerrdialogs --disable-infobars \
  --autoplay-policy=no-user-gesture-required \
  --check-for-update-interval=31536000 \
  --app="http://<tailnet-host>/display/<cameraId>"
```

Autostart options (pick one):

**LXDE autostart** (`~/.config/lxsession/LXDE-pi/autostart`):
```
@xset s off
@xset -dpms
@xset s noblank
@chromium-browser --kiosk --noerrdialogs --disable-infobars --autoplay-policy=no-user-gesture-required --app=http://<tailnet-host>/display/<cameraId>
```

**systemd user service** (`~/.config/systemd/user/flash-kiosk.service`):
```ini
[Unit]
Description=Flash kiosk display
After=graphical-session.target

[Service]
ExecStart=/usr/bin/chromium-browser --kiosk --noerrdialogs --disable-infobars --autoplay-policy=no-user-gesture-required --app=http://<tailnet-host>/display/<cameraId>
Restart=always

[Install]
WantedBy=default.target
```
Enable: `systemctl --user enable --now flash-kiosk.service`

## 3. Verify on the Pi

Boot the Pi. Expected:

- Chromium opens fullscreen to the camera, **no scrollbar, no chrome**.
- Video plays **smoothly** (H.264 hardware-decoded by the Pi).
- **Boxes + counts HUD are part of the video** and track perfectly — no ghost,
  no freeze, no lag.
- A few seconds of startup latency is normal (HLS warm-up).

If playback stutters:

- Confirm hardware decode is active: open `chrome://gpu` → "Video Decode" should be
  hardware-accelerated.
- Confirm the stream is H.264 (the backend uses `h264_nvenc`, with `libx264`
  fallback — both are H.264; the Pi decodes H.264 in hardware).
- Confirm you are hitting the **Tailscale** host, not the Cloudflare hostname.

## Notes

- The annotated encoder is **on-demand**: if no Pi is watching a camera, no encoder
  runs for it (saves NVENC sessions / CPU). It starts within ~1–3 s of the first
  playlist request and idle-stops ~15 s after the last segment pull.
- The interactive dashboard (`/`, calibration) is unchanged — it still uses the
  MJPEG + live canvas overlay for low-latency interaction. Only the kiosk uses the
  annotated HLS stream.
