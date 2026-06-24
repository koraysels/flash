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

## 2. Player — mpv (recommended) or Chromium

The annotated stream is a self-contained H.264 HLS with the boxes + HUD burned
into the video, so the Pi does **not** need a browser. A native player is lighter
and more reliable for an unattended kiosk.

### Option A — mpv (recommended, no browser)

```bash
sudo apt install mpv
mpv --fullscreen --no-osc --no-input-default-bindings --really-quiet \
    --loop=inf --hwdec=auto \
    "http://<tailnet-host>/api/cameras/<cameraId>/annotated/index.m3u8"
```

`--hwdec=auto` uses the Pi's hardware H.264 decoder. Autostart via a systemd user
service (`~/.config/systemd/user/flash-kiosk.service`):
```ini
[Unit]
Description=Flash kiosk (mpv)
After=graphical-session.target

[Service]
ExecStart=/usr/bin/mpv --fullscreen --no-osc --no-input-default-bindings --really-quiet --loop=inf --hwdec=auto "http://<tailnet-host>/api/cameras/<cameraId>/annotated/index.m3u8"
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```
Enable: `systemctl --user enable --now flash-kiosk.service`

> mpv plays the playlist URL directly — the browser `/display/<cameraId>` route is
> NOT needed on the Pi unless you want extra client-side overlays on top.

Confirm hardware decode is actually used (not software → stutter):
```bash
mpv --msg-level=vd=v "<url>" 2>&1 | grep -i "using hardware"
```
If it doesn't engage, force the Pi V4L2 decoder: `--hwdec=v4l2m2m` (or
`--hwdec=drm` on some Pi OS builds). The stream is encoded H.264 High@4.0 with no
B-frames specifically so the Pi 4/5 VideoCore decodes it in hardware.

### Option B — Chromium kiosk autostart (per Pi)

Install Chromium if needed (`sudo apt install chromium-browser`). One Pi → one
`cameraId`.

Launch command:

```bash
chromium-browser --kiosk --noerrdialogs --disable-infobars \
  --autoplay-policy=no-user-gesture-required \
  --check-for-update-interval=31536000 \
  --enable-features=VaapiVideoDecoder,VaapiVideoDecodeLinuxGL \
  --use-gl=egl --ignore-gpu-blocklist --enable-accelerated-video-decode \
  --app="http://<tailnet-host>/display/<cameraId>"
```

> The HW-decode flags matter on the Pi — without them Chromium software-decodes
> H.264 and stutters. Verify at `chrome://gpu` → "Video Decode: Hardware
> accelerated". Use the Chromium path when you want extra **client-side overlays**
> on top of the burned-in video (add them in `frontend/src/pages/PiDisplay.tsx`);
> otherwise mpv is lighter.

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
