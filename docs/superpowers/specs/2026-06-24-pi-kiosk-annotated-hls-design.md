# Flash — Annotated H.264 Kiosk Stream + Fullscreen Pi Display

**Date:** 2026-06-24
**Status:** Draft for review

## Problem

The live view renders video and AI boxes as **two unsynchronized streams**:

- **Video** = MJPEG (`/api/cameras/:id/mjpeg`): backend ffmpeg emits one full JPEG
  per frame; the browser decodes every frame. Heavy (23–44 MB responses observed),
  CPU-bound — choppy on a Raspberry Pi / Chromium.
- **Boxes** = socket.io `frame` events drawn on a separate `<canvas>` overlay,
  aligned to the MJPEG frame by `frameSeq` and smoothed with lerp.

Because the two streams are independent, the overlay can never perfectly track the
video. Every tuning knob trades one artifact for another:

- emit predicted (coasted) tracks → **ghost boxes** drift onto empty road
- skip predicted tracks → boxes **freeze** during detection gaps ("stuck")
- raise lerp → boxes **lag** fast vehicles

This is a structural limit of "separate overlay synced to MJPEG", not a tuning bug.

## Goal

A **kiosk display** for Raspberry Pi screens:

- Each Pi shows **one camera, fullscreen**, edge-to-edge, no app chrome, no scrollbar.
- **Boxes + a minimal counts/speed overlay** visible.
- **Smooth** video on Pi Chromium.
- Boxes perfectly tracking the video (no ghost / freeze / lag).
- Latency is **not** a concern (2–6 s acceptable).

## Approach

**Burn the annotation into the video on the backend, encode H.264, serve as HLS.**
The Pi then plays a single `<video>` — no canvas, no socket, no sync logic. The boxes
are *in the pixels*, so they are perfectly synced by construction, and Chromium
hardware-decodes H.264 so playback is smooth.

The interactive app (dashboard, calibration) **keeps** its current MJPEG + canvas
overlay — it needs the live, interactive overlay and low latency. Only the **kiosk**
uses the annotated HLS stream. This keeps the change additive and low-risk.

### Why this over alternatives

- **HLS + canvas overlay (no burn-in):** still two streams; sync by PTS is hard in
  the browser and doesn't fully remove lag. Rejected — doesn't fix the core problem.
- **WebRTC:** sub-second latency we don't need, and heavy (signaling + ICE +
  STUN/TURN, awkward behind Cloudflare). Rejected for now.
- **Keep MJPEG, tune more:** cannot fix the structural sync problem. Rejected.

## Architecture

### Backend — annotated encoder per camera

Today, per camera (`backend/src/stream/mjpeg-streamer.ts`):
ffmpeg (HLS in → `image2pipe` MJPEG out) → frame queue → AI worker
(`ai-worker.ts`: decode + detect + track) → socket `frame` events + raw MJPEG to clients.

Add an **annotated-HLS branch** (opt-in per camera, or always-on if cheap enough):

1. The AI worker already has the decoded frame + tracked boxes. Re-enable
   `annotateFrame()` (`backend/src/ai/annotator.ts`, still present) to draw boxes +
   labels onto the frame, producing an annotated JPEG/raw RGBA. Draw at AI rate
   (~20 fps); for frames between detections, repeat the last annotated frame (the
   encoder pads to a constant output fps).
2. Pipe annotated frames into a **per-camera ffmpeg encoder**:
   `image2pipe` in → **`h264_nvenc`** (NVIDIA hardware encoder on the 4090) →
   **HLS** (`-f hls`, short segments, e.g. `-hls_time 1 -hls_list_size 6
   -hls_flags delete_segments+append_list`) written to a tmpfs dir or piped.
3. Serve the generated playlist/segments at a **new** route, e.g.
   `/api/cameras/:id/annotated/index.m3u8` + `/.../annotated/<segment>.ts`.
   This is distinct from the existing `/api/cameras/:id/hls/*` passthrough proxy of
   the *raw* upstream.

Counts/speed overlay: burn a minimal corner HUD into the same annotated frame
(reuse the annotator), so it is also perfectly synced. (Alternative: a tiny
socket-fed DOM overlay on the kiosk — acceptable since its position is independent
of the boxes. Default: burn it in, fewer moving parts.)

**Lifecycle:** the annotated encoder starts when a kiosk client requests the
camera's annotated playlist and stops (or idles) when no client has pulled a
segment for N seconds — to conserve NVENC sessions.

### NVENC session limit (key constraint)

Consumer GeForce drivers cap simultaneous NVENC encode sessions (historically 3,
commonly raised to ~8 by recent drivers / the nvidia patch). With 6+ cameras this
can be exceeded. Mitigations, in order:

1. **On-demand encoding** — only encode cameras a kiosk is actually watching
   (each Pi = 1 camera ⇒ usually ≤ number of Pis, not all cameras).
2. Fall back to **software `libx264 -preset ultrafast`** for overflow cameras
   (CPU is ~8% idle; a few extra encodes are affordable).
3. Cap concurrent annotated encoders and document the limit.

Decision for v1: **on-demand `h264_nvenc`, with `libx264` fallback** when NVENC
session creation fails.

### Frontend — fullscreen kiosk route

New route `/display/:cameraId` (`frontend/src/pages/`), separate from the dashboard:

- Full-viewport `<video>` (HLS.js, like the existing HLS path) playing
  `/api/cameras/:id/annotated/index.m3u8`. `object-fit: cover` or `contain`
  (decide: `contain` to avoid cropping plate-relevant edges).
- **No** canvas overlay, **no** socket subscription for boxes (they're in the video).
- CSS: `html,body,#root { height:100%; margin:0; overflow:hidden }`, video fills
  the viewport, no headers/footers/cards.
- Minimal counts/speed: if burned-in, nothing to do; if DOM overlay chosen, a tiny
  absolutely-positioned corner element fed by socket (latency-tolerant).
- Auto-enter fullscreen where possible; on the Pi, Chromium runs in `--kiosk` mode
  so the route already fills the screen.
- Auto-reconnect / reload on stream error (kiosks run unattended).

### Transport — Tailscale for the Pis

- Run the Pis on the **tailnet**; they reach the backend directly over WireGuard
  (e.g. the rtx4090 host's tailscale IP), bypassing the Cloudflare tunnel entirely.
  This removes tunnel buffering / websocket-idle limits and lowers latency.
- **Cloudflare tunnel stays** for public access.
- Pi setup: Chromium `--kiosk --app=https://<tailscale-host>/display/<cameraId>`,
  autostart on boot.

## Components / boundaries

- `annotator.ts` — pure: (frame, boxes, counts) → annotated image. Already exists;
  extend for the corner HUD.
- `AnnotatedEncoder` (new, backend) — owns one camera's ffmpeg NVENC→HLS pipeline +
  segment dir + lifecycle (start on demand, idle-stop). Fed annotated frames by the
  AI worker.
- annotated-HLS routes (new) — serve playlist + segments; trigger encoder start.
- `DisplayPage` (new, frontend) — fullscreen HLS `<video>` kiosk.
- Unchanged: dashboard, calibration, MJPEG + canvas overlay, socket protocol.

## Out of scope (v1)

- Migrating the interactive dashboard off MJPEG.
- WebRTC.
- Multi-camera kiosk grid / rotation (one camera fullscreen only).
- Audio.

## Risks / open questions

- **NVENC session cap** — mitigated by on-demand + libx264 fallback; verify the
  driver's session limit on the rtx4090.
- **Added annotation+encode CPU/GPU cost** — measure; 4090 has headroom but confirm.
- **Segment storage** — use tmpfs to avoid disk wear; bound by `hls_list_size` +
  `delete_segments`.
- **Latency** — accepted (2–6 s).
- `object-fit` `contain` vs `cover` — `contain` (no crop) unless letterbox bars are
  objectionable on the Pi.

## Rollout

Additive: new routes + new frontend page; existing app untouched. Deploy via the
normal Komodo webhook → build (note: NVENC needs the container to see the GPU —
already configured via the compose `deploy.devices` reservation and the CUDA base).

## Implementation order (for the plan)

1. Backend `AnnotatedEncoder` + annotated-HLS routes + worker feeding annotated
   frames (NVENC, libx264 fallback, on-demand lifecycle).
2. Frontend `/display/:cameraId` fullscreen kiosk page (HLS.js).
3. Tailscale wiring + Pi Chromium kiosk autostart.
4. Verify on a real Pi: smooth playback, synced boxes, fullscreen, no scrollbar.
