# Deploying Flash with Komodo + Traefik

## Overview

Flash runs as two Docker containers managed by Komodo:

- **backend** — Fastify API + AI pipeline (Node 20, ffmpeg, ONNX)
- **frontend** — React SPA served by nginx; proxies `/api` and `/socket.io` to the backend

Traefik runs as a **shared reverse proxy** across all your VPS projects. Each project's compose file connects to a shared `traefik` Docker network and adds labels — Traefik picks them up automatically. SSL is handled by Let's Encrypt with zero configuration.

```
Internet
    │
    ▼
Traefik (:80 / :443)  ◀── shared across all your projects
    │
    └── flash.yourdomain.com ──▶  frontend container (nginx)
                                          │
                              ┌───────────┴───────────┐
                         /api/*  /socket.io/*     static files
                              │
                              ▼
                       backend container
                   (internal Docker network,
                    never exposed to host or Traefik)
```

---

## Step 1 — Install Komodo

```bash
curl -fsSL https://raw.githubusercontent.com/moghtech/komodo/main/scripts/setup-komodo.sh | sh
```

Komodo UI runs on port **9120**. Restrict it to your IP only:

```bash
ufw allow from YOUR_HOME_IP to any port 9120
```

---

## Step 2 — Deploy the shared Traefik stack

This is a one-time setup on the VPS. All your projects will share this Traefik instance.

Create `/opt/traefik/docker-compose.yml`:

```yaml
services:
  traefik:
    image: traefik:v3
    restart: unless-stopped
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
      - --entrypoints.web.http.redirections.entrypoint.to=websecure
      - --entrypoints.web.http.redirections.entrypoint.scheme=https
      - --certificatesresolvers.letsencrypt.acme.tlschallenge=true
      - --certificatesresolvers.letsencrypt.acme.email=YOUR_EMAIL
      - --certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - letsencrypt:/letsencrypt
    networks:
      - traefik

volumes:
  letsencrypt:

networks:
  traefik:
    name: traefik          # other projects connect to this by name
```

Start it:

```bash
cd /opt/traefik && docker compose up -d
```

Open port 80 and 443 in UFW:

```bash
ufw allow 80
ufw allow 443
```

---

## Step 3 — Add your VPS as a server in Komodo

1. Open Komodo UI → **Servers** → **New Server**
2. Name: `vps`, Address: `localhost`
3. **Test Connection** → should go green

---

## Step 4 — Add the Flash git repo

**Repos** → **New Repo**

| Field | Value |
|---|---|
| Name | `flash` |
| URL | `https://github.com/yourname/flash` |
| Branch | `main` |

---

## Step 5 — Create the Stack

**Stacks** → **New Stack**

| Field | Value |
|---|---|
| Name | `flash` |
| Server | `vps` |
| Repo | `flash` |
| Compose file | `docker-compose.yml` |

### Environment variables

Set these in the Stack's **Environment** tab — do **not** commit them to git:

```env
DATABASE_URL=postgresql://user:pass@your-neon-host/flash?sslmode=require
FLASH_DOMAIN=flash.yourdomain.com
VITE_GOOGLE_MAPS_API_KEY=
```

> `FLASH_DOMAIN` is used in the Traefik routing label.  
> `VITE_GOOGLE_MAPS_API_KEY` is optional — leave blank if not using the calibration map.

---

## Step 6 — Deploy

Click **Deploy**. Komodo runs:

```bash
docker compose build
docker compose up -d
```

Traefik detects the new container via the Docker socket, requests a certificate from Let's Encrypt, and starts routing `flash.yourdomain.com` to the frontend. First deploy takes a few minutes to build the images.

---

## Step 7 — Auto-deploy on git push

1. In Komodo: **Stack → Webhooks** → copy the webhook URL
2. In GitHub: **Settings → Webhooks → Add webhook**
   - Payload URL: the Komodo webhook URL
   - Content type: `application/json`
   - Trigger: `push`

Every `git push main` now triggers a rebuild and redeploy automatically.

---

## Pre-deploy checklist

- [ ] DNS A record for `flash.yourdomain.com` → your VPS IP (must resolve before deploy or Let's Encrypt will fail)
- [ ] Ports 80 and 443 open in UFW
- [ ] Port 3001 **not** in UFW (backend is internal only)
- [ ] `backend/.env` is in `.gitignore` — env vars go in Komodo, not git
- [ ] Neon dashboard → IP allowlist → add your VPS IP
- [ ] Traefik stack is running (`docker ps | grep traefik`)

---

## Adding future projects to Traefik

Any other compose project on the VPS just needs:

```yaml
networks:
  traefik:
    external: true
    name: traefik

services:
  yourapp:
    ...
    networks:
      - traefik
    labels:
      - traefik.enable=true
      - traefik.docker.network=traefik
      - traefik.http.routers.yourapp.rule=Host(`yourapp.yourdomain.com`)
      - traefik.http.routers.yourapp.entrypoints=websecure
      - traefik.http.routers.yourapp.tls.certresolver=letsencrypt
      - traefik.http.services.yourapp.loadbalancer.server.port=3000
```

Traefik picks it up automatically — no restart needed.
