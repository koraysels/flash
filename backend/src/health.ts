import net from 'net'

// Pi kiosk hosts come from the SSH_PI_0N env (user@ip on the tailnet). We only
// need the IP for a reachability probe.
const PI_ENV_KEYS = ['SSH_PI_01', 'SSH_PI_02', 'SSH_PI_03']
const PI_SLOTS = ['FLASH-PI-01', 'FLASH-PI-02', 'FLASH-PI-03']

export function parsePiHosts(): { slot: string; ip: string }[] {
  return PI_SLOTS.map((slot, i) => {
    const raw = process.env[PI_ENV_KEYS[i]] ?? ''
    const ip = raw.includes('@') ? raw.split('@')[1] : raw
    return { slot, ip: ip.trim() }
  }).filter((p) => p.ip)
}

// TCP connect probe — SSH (22) is up on the Pis, so a successful connect means the
// Pi is powered on and on the network. No ICMP (needs privilege in the container).
export function tcpPing(host: string, port = 22, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let settled = false
    const finish = (ok: boolean) => { if (settled) return; settled = true; sock.destroy(); resolve(ok) }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
    sock.connect(port, host)
  })
}

// Last time a client fetched an annotated HLS segment for a camera. A playing
// kiosk polls segments every ~1-2s, so a recent timestamp means the stream is
// actually being consumed (not just that the camera is running).
const lastAnnotatedAccess = new Map<string, number>()
export function touchAnnotatedAccess(cameraId: string): void {
  lastAnnotatedAccess.set(cameraId, Date.now())
}
export function annotatedAccessAt(cameraId: string): number | null {
  return lastAnnotatedAccess.get(cameraId) ?? null
}
