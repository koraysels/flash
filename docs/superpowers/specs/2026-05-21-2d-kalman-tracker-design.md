# Design: 2D Kalman filter + direction-aware matching

**Datum:** 2026-05-21  
**Scope:** `backend/src/ai/tracker.ts`  
**Aanleiding:** X en Y worden apart gefilterd via twee `KF1D` instanties. De snelheidsvector `(vx, vy)` bestaat niet als eerste-klas concept, waardoor de matching-stap geen gebruik kan maken van de bewegingsrichting. Dit veroorzaakt ID-switches bij parallelle of inhaalende voertuigen.

---

## Wat verandert

### 1. Nieuwe klasse `KF2D` (vervangt `KF1D` × 2)

State: `[cx, cy, vx, vy]`  
Covariantie: twee ontkoppelde 2×2 blokken (x-blok en y-blok) — wiskunde identiek aan de huidige twee `KF1D`'s, verpakt als één object.

```
predict(dt):
  cx += vx * dt
  cy += vy * dt
  (covariantie propagatie per blok, zelfde als huidige KF1D)

update(meas_cx, meas_cy, r):
  Kalman update voor x-blok met meas_cx
  Kalman update voor y-blok met meas_cy

velAngle(): atan2(vy, vx)           → richting in radialen
velMag():   √(vx² + vy²)            → snelheid in px/s
```

Initialisatie: `vel = (0, 0)`, grote initiële covariantie voor snelheid (identiek aan huidige `KF1D`).

Bestaande parameters `qPos` en `qVel` blijven ongewijzigd — geen breaking change naar camera-configuratie.

### 2. Direction-aware matching in `greedyMatch`

Naast de IoU-score wordt een richting-compatibiliteitsscore berekend wanneer een track een duidelijke snelheid heeft.

**Drempel:** alleen gebruiken als `velMag() > 20 px/s` (anders is de richting te onzeker om te vertrouwen).

**Richtingsdelta:** vector van predicted center naar detection center = `(det_cx - pred_cx, det_cy - pred_cy)`.

**Compatibiliteitsscore:** cosinus-similariteit tussen `(vx, vy)` en de richtingsdelta. Bereik: `[-1, 1]`, genormaliseerd naar `[0, 1]`.

**Gecombineerde score:**
```
score = iou * 0.7 + direction_compat * 0.3
```

Als `velMag < 20 px/s` of als de track minder dan 3 frames oud is: `score = iou` (geen richting meewegen — te weinig info).

**Effect:** een voertuig dat naar rechts rijdt kan nooit gematcht worden met een detectie die links van de predicted positie ligt, ook al is de IoU hoog genoeg.

### 3. Type-update `KFTrack`

```typescript
// Oud:
kfX: KF1D
kfY: KF1D

// Nieuw:
kf: KF2D
```

Alle andere velden (`bcx`, `bcy`, `w`, `h`, `history`, `missedFrames`, `confirmedFrames`...) blijven ongewijzigd.

---

## Wat NIET verandert

- `TrackerConfig` en alle parameters
- `TrackedVehicle` type (public interface)
- `greedyMatch` threshold-logica en 2-fasen aanpak
- Alle consumers van de tracker (`ai-worker.ts`, `counter.ts`, `trap-speed.ts`)
- Camera-configuraties in de database

---

## Foutafhandeling

- Als `velMag() === 0` (eerste frames van een track): richting wordt genegeerd, enkel IoU gebruikt.
- Als de richtingsdelta zelf een nulvector is (detectie op exact dezelfde positie): richting-score = 0.5 (neutraal).
- De drempel van 20 px/s is een constante bovenaan `tracker.ts`, makkelijk aanpasbaar.

---

## Testing

Bestaande tests in `backend/src/__tests__/` die de tracker raken:

1. **Bestaande tracker-tests** moeten blijven slagen — de public interface verandert niet.
2. **Nieuwe test: ID-switch preventie** — twee tracks die naast elkaar rijden in tegengestelde richting mogen niet swappen na een overlap-frame.
3. **Nieuwe test: richting neutraal bij lage snelheid** — een track met `velMag < 20` gedraagt zich identiek aan de huidige tracker (enkel IoU).

---

## Volgorde van implementatie

1. `KF2D` klasse schrijven en unit-testen
2. `KFTrack` type updaten, `kfX`/`kfY` → `kf`
3. `predict`/`update` aanroepen in `Tracker.update()` aanpassen
4. Direction-score toevoegen aan `greedyMatch`
5. Bestaande tests runnen, nieuwe tests toevoegen
