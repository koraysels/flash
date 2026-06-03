# PIN Authentication & Camera Editing — Design Spec

**Date:** 2026-06-03
**Status:** Approved

## Problem

The Flash dashboard is publicly accessible on the internet. Any external visitor can add, modify, or delete cameras and calibration data. A shared PIN is needed to gate all mutating operations, while keeping read-only views (stream, snapshot, Pi display) publicly accessible.

## Goals

1. Protect all mutating API routes with a server-validated PIN
2. Store the unlock token in localStorage for session persistence (no re-entry on refresh)
3. Keep `/display/:cameraId` and all GET routes fully public
4. Add inline editing of camera name and location fields

## Non-goals

- Multiple users or roles
- Password reset flow
- httpOnly cookies (acceptable tradeoff for this use case)

---

## Architecture

```
Browser                          Backend (Fastify)
──────                           ─────────────────
PinGate component
  └─ PIN invoeren       ──────►  POST /api/auth
  └─ JWT ontvangen      ◄──────    compare vs FLASH_PIN env var
  └─ opslaan in                    return signed JWT (30d expiry)
     localStorage (flash_token)

Muterende API-calls              requireAuth preHandler
  └─ Authorization: Bearer …  ──► geldig token → door
                                  ongeldig/ontbrekend → 401
```

---

## Backend

### Environment variables (`backend/.env`)

```
FLASH_PIN=<chosen pin>
JWT_SECRET=<random 32+ char string>
```

### New file: `backend/src/auth.ts`

Two exports:

**`authRoutes(app)`** — registers `POST /api/auth`:
- Accepts `{ pin: string }` in request body
- Compares against `process.env.FLASH_PIN`
- On match: returns `{ token: string }` signed with `JWT_SECRET`, 30-day expiry
- On mismatch: returns `401 { error: 'Invalid PIN' }`

**`requireAuth`** — Fastify preHandler:
- Reads `Authorization: Bearer <token>` from request headers
- Verifies JWT with `JWT_SECRET`
- On valid: passes through
- On missing/invalid/expired: returns `401 { error: 'Unauthorized' }`

### Modified: `backend/src/index.ts`

- Register `authRoutes` before other routes
- Add `requireAuth` as `preHandler` to:
  - `POST /api/cameras`
  - `PUT /api/cameras/:id`
  - `DELETE /api/cameras/:id`
  - `POST /api/cameras/:id/calibration`
  - `POST /api/cameras/:id/tracking-config`
  - `POST /api/cameras/:id/reset-counts`
- No changes to GET routes or HLS proxy

### Package

```
pnpm --filter flash-backend add jsonwebtoken
pnpm --filter flash-backend add -D @types/jsonwebtoken
```

---

## Frontend

### New file: `frontend/src/hooks/useAuth.ts`

```typescript
// Returns: { isAuthenticated, login(pin), logout }
// - Reads flash_token from localStorage
// - Checks JWT expiry client-side (avoid unnecessary 401s)
// - login(pin): POST /api/auth, stores token on success, throws on failure
// - logout(): removes flash_token from localStorage
```

### New file: `frontend/src/components/PinGate.tsx`

- Wraps children — renders them only when `isAuthenticated`
- Shows centered PIN entry form when not authenticated
- Design: consistent with existing brutalist style (border-2 border-black, uppercase tracking-widest, bg-white text-black)
- Shows error message on wrong PIN
- Auto-focuses PIN input on mount

### Modified: `frontend/src/App.tsx`

```tsx
// Wrap Layout routes with PinGate:
<Route element={<PinGate><Layout /></PinGate>}>
  ...
</Route>
// /display/:cameraId stays outside PinGate — always public
```

### Modified: `frontend/src/lib/api.ts`

- Add `getToken()` helper: reads `flash_token` from localStorage
- Add `authHeaders()` helper: returns `{ Authorization: 'Bearer <token>' }` when token present
- All mutating fetch calls (`createCamera`, `updateCamera`, `deleteCamera`, `saveCalibration`, `saveTrackingConfig`, `resetCounts`) include `authHeaders()` in their headers
- On `401` response in any mutating call: remove `flash_token` from localStorage and call `window.location.reload()` to return to PIN screen

### Modified: `frontend/src/pages/Cameras.tsx`

Add inline editing for `name` and `location` per camera row:
- Edit button (pencil or "Edit" text) next to each camera
- Clicking activates inline edit mode for that row: replaces name/location display with input fields
- Save calls `updateCamera(id, { name, location })`
- Cancel restores original values
- Only one row editable at a time

---

## Data flow: login

1. User visits `/` → `PinGate` checks `flash_token` in localStorage
2. No token or expired → render PIN entry screen
3. User enters PIN → `login(pin)` → `POST /api/auth`
4. Backend validates → returns JWT
5. Token stored as `flash_token` in localStorage
6. `PinGate` renders children (full app)

## Data flow: authenticated request

1. User clicks "Add Camera" → `createCamera(data)` called
2. `api.ts` attaches `Authorization: Bearer <token>`
3. Backend `requireAuth` verifies token → passes through to route handler
4. Camera created, UI updated via TanStack Query invalidation

## Data flow: token expiry / invalid

1. Mutating call returns `401`
2. `api.ts` removes `flash_token` from localStorage
3. `window.location.reload()` → `PinGate` shows PIN screen again

---

## Public vs protected routes

| Route | Auth required |
|-------|--------------|
| `GET /api/cameras` | No |
| `GET /api/cameras/:id/snapshot` | No |
| `/api/cameras/:id/hls/*` | No |
| `POST /api/auth` | No |
| `POST /api/cameras` | **Yes** |
| `PUT /api/cameras/:id` | **Yes** |
| `DELETE /api/cameras/:id` | **Yes** |
| `POST /api/cameras/:id/calibration` | **Yes** |
| `POST /api/cameras/:id/tracking-config` | **Yes** |
| `POST /api/cameras/:id/reset-counts` | **Yes** |
| Frontend `/display/:cameraId` | No (outside PinGate) |

---

## Security considerations

- PIN never stored in frontend code or bundle — validated server-side only
- JWT in localStorage is vulnerable to XSS; acceptable here since no user-generated content is rendered
- JWT has 30-day expiry — user will need to re-enter PIN after expiry
- `FLASH_PIN` and `JWT_SECRET` are environment variables, never committed to git
