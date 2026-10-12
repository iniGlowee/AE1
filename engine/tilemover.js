/**
 * AE1 - TileMover: the reference MMO-style point-and-click movement on a tile grid.
 *
 * `(extends TileMover)` gives a character grid-based click-to-move: click the
 * ground and it routes there with the authentic the reference MMO BFS (8-dir, no
 * corner-cutting, nearest-reachable fallback), then walks tile-to-tile hugging
 * the terrain. It extends ThirdPersonCharacter so the existing ThirdPersonCamera
 * follows it unchanged — but it wires ITS OWN tick, so none of the WASD/gravity
 * physics runs; movement comes only through the routed step path.
 *
 * The collision grid is a `clip` dat: a base64 string of size*size bytes, one
 * per tile, packed BLOCKED=1 | WALL_N=2 | WALL_S=4 | WALL_E=8 | WALL_W=16
 * (the researcher's rsregion_export → 1-byte pack). Height comes from the live
 * ground raycast (env3d.groundAt), so the mover hugs whatever mesh is under it.
 *
 * Reference: the movement research notes
 */
import { defineDatAccessors } from './element.js';
import { AE1ThirdPersonCharacter } from './thirdperson.js';

const B = 1, WN = 2, WS = 4, WE = 8, WW = 16; // packed clip bits
const DEG = 180 / Math.PI;

// 8 directions as (dx, dz); orthogonals first (BFS explores them before diagonals).
const DIRS = [
  [0, 1], [0, -1], [1, 0], [-1, 0],   // N  S  E  W   (N = +z, E = +x)
  [1, 1], [-1, 1], [1, -1], [-1, -1], // NE NW SE SW
];

export class AE1TileMover extends AE1ThirdPersonCharacter {
  /* -- lifecycle --------------------------------------------------------- */

  _tileBegin() {
    // Cursor mode: the pointer stays visible and clicks are read as tiles.
    const input = this.world?.input3d;
    if (input) input.cursorMode = true;

    // §occluder fade. Rather than pull the camera in when a wall blocks the view
    // (which reads as "stuck"), we DITHER OUT the geometry between the camera and
    // the character — the engine's per-fragment near-fade. `fadeScenery` (opt-in)
    // turns it on for the scene: the player itself NEVER fades (it's what the
    // fade exists to keep visible), floor/terrain elements named in `fadeExcept`
    // never fade (they'd strobe as the camera skims them), and everything else —
    // walls, buildings, fences — fades near the lens. Object/ground elements have
    // no nearFade dat, so we set it on the live element here.
    if (this.fadeScenery === true || this.fadeScenery === 'true') {
      const skip = new Set(String(this.fadeExcept || '').split(',').map((s) => s.trim()).filter(Boolean));
      for (const e of this.world?.scene?.all?.() ?? []) {
        if (e === this || e.isPlayer) e.nearFade = false;
        else e.nearFade = !skip.has(e.name);
      }
    }

    // Unpack the clip grid (base64 → bytes). Missing/short ⇒ an all-open grid.
    this._N = Math.max(1, Number(this.gridSize) || 64);
    this._clip = this._decodeClip(this.clip, this._N);

    // Start standing at the centre of the tile we spawned on.
    this._tx = this._clampTile(Math.floor(this.x ?? 0));
    this._tz = this._clampTile(Math.floor(this.z ?? 0));
    this.x = this._tx + 0.5;
    this.z = this._tz + 0.5;
    this._path = [];        // remaining world-space tile centres to walk through
    this._facing = Number(this.rotationY) || 0;  // yaw about world-up (NOT roll)
    this._grounded = true;  // the camera/character treat us as on the ground
    this._snapY();
  }

  _decodeClip(b64, N) {
    const grid = new Uint8Array(N * N);
    if (typeof b64 !== 'string' || !b64) return grid;
    try {
      const bin = atob(b64.trim());
      for (let i = 0; i < grid.length && i < bin.length; i++) grid[i] = bin.charCodeAt(i);
    } catch (e) {
      console.warn('[TileMover] clip decode failed:', e?.message ?? e);
    }
    return grid;
  }

  /* -- grid + traversability (deliverable 01 §2) ------------------------- */

  _clampTile(v) { return v < 0 ? 0 : v >= this._N ? this._N - 1 : v; }
  _inBounds(x, z) { return x >= 0 && z >= 0 && x < this._N && z < this._N; }
  _clipAt(x, z) { return this._inBounds(x, z) ? this._clip[x * this._N + z] : B; }

  _canStep(fx, fz, dx, dz) {
    const tx = fx + dx, tz = fz + dz;
    if (!this._inBounds(tx, tz)) return false;
    const c = this._clipAt(tx, tz);
    if (dz === 1 && dx === 0) return !(c & (B | WS));            // N: enter target's south edge
    if (dz === -1 && dx === 0) return !(c & (B | WN));           // S
    if (dx === 1 && dz === 0) return !(c & (B | WW));            // E: enter target's west edge
    if (dx === -1 && dz === 0) return !(c & (B | WE));           // W
    // diagonals: both orthogonals clear AND the corner tile's two facing edges (no corner-cutting)
    if (dx === 1 && dz === 1) return this._canStep(fx, fz, 0, 1) && this._canStep(fx, fz, 1, 0) && !(c & (B | WS | WW));
    if (dx === -1 && dz === 1) return this._canStep(fx, fz, 0, 1) && this._canStep(fx, fz, -1, 0) && !(c & (B | WS | WE));
    if (dx === 1 && dz === -1) return this._canStep(fx, fz, 0, -1) && this._canStep(fx, fz, 1, 0) && !(c & (B | WN | WW));
    if (dx === -1 && dz === -1) return this._canStep(fx, fz, 0, -1) && this._canStep(fx, fz, -1, 0) && !(c & (B | WN | WE));
    return false;
  }

  /* -- BFS route (deliverable 01 §3) ------------------------------------- */

  _route(sx, sz, dx, dz) {
    const N = this._N;
    if (Math.max(Math.abs(sx - dx), Math.abs(sz - dz)) > N) return [];
    const via = new Int8Array(N * N).fill(-1);  // dir index each tile was reached from
    const seen = new Uint8Array(N * N);
    const q = [];
    let qh = 0;
    const start = sx * N + sz;
    seen[start] = 1; via[start] = 8;            // 8 = sentinel (the start)
    q.push([sx, sz]);
    let found = false;
    while (qh < q.length) {
      const [cx, cz] = q[qh++];
      if (cx === dx && cz === dz) { found = true; break; }
      for (let d = 0; d < 8; d++) {
        const nx = cx + DIRS[d][0], nz = cz + DIRS[d][1];
        if (!this._inBounds(nx, nz)) continue;
        const ni = nx * N + nz;
        if (seen[ni] || !this._canStep(cx, cz, DIRS[d][0], DIRS[d][1])) continue;
        seen[ni] = 1; via[ni] = d; q.push([nx, nz]);
      }
    }
    let ex = dx, ez = dz;
    if (!found) {
      // nearest-reachable fallback: the seen tile closest to dest in a ±10 box
      let best = -1, bx = 0, bz = 0;
      for (let x = Math.max(0, dx - 10); x <= Math.min(N - 1, dx + 10); x++)
        for (let z = Math.max(0, dz - 10); z <= Math.min(N - 1, dz + 10); z++)
          if (seen[x * N + z]) {
            const dd = (x - dx) * (x - dx) + (z - dz) * (z - dz);
            if (best < 0 || dd < best) { best = dd; bx = x; bz = z; }
          }
      if (best < 0) return [];
      ex = bx; ez = bz;
    }
    // backtrace to the start, emit every tile (unit steps)
    const tiles = [];
    let x = ex, z = ez;
    while (!(x === sx && z === sz)) {
      tiles.push([x, z]);
      const d = via[x * N + z];
      if (d < 0 || d === 8) break;
      x -= DIRS[d][0]; z -= DIRS[d][1];
    }
    tiles.reverse();
    return tiles;
  }

  /* -- per-frame drive --------------------------------------------------- */

  /** The scene's left-click default-action handler, if any (the ElementGraph).
   *  Duck-typed so the mover never imports it; cached once found. */
  _primaryHandler() {
    if (this._ph && this.world?.scene?.all?.().includes?.(this._ph)) return this._ph;
    for (const e of this.world?.scene?.all?.() ?? []) {
      if (e !== this && typeof e.tryPrimary === 'function') { this._ph = e; return e; }
    }
    return null;
  }

  _snapY() {
    const g = this.world?.env3d?.groundAt?.(this, this.x, this.z, (this.y ?? 0) + 2);
    if (g != null) this.y = g;
  }

  _tileTick(dt) {
    const input = this.world?.input3d;
    if (input && !input.cursorMode) input.cursorMode = true;

    // 1) INTENT — turn clicks into a route. But first, the RS LEFT-CLICK rule:
    // if the click landed on something with a DEFAULT ACTION (a door to open,
    // say), do that instead of walking. A duck-typed handler (the ElementGraph)
    // decides via tryPrimary; only clicks it declines fall through to movement.
    const handler = this._primaryHandler();
    const clicks = input?.takeClicks?.() ?? [];
    for (const c of clicks) {
      if (c.button !== 0) continue; // left-click walks
      if (handler && handler.tryPrimary(c.nx, c.ny)) continue; // default action ran — no walk
      const hit = this.world?.env3d?.pointerGround?.(c.nx, c.ny);
      if (!hit) continue;
      const dx = this._clampTile(Math.floor(hit.x));
      const dz = this._clampTile(Math.floor(hit.z));
      const path = this._route(this._tx, this._tz, dx, dz);
      this._path = path.map(([tx, tz]) => [tx + 0.5, tz + 0.5]);
    }

    // 2) VIEW/SIM — glide toward the next tile centre at `speed` tiles/sec.
    if (this._path.length) {
      const speed = Math.max(0.5, Number(this.speed) || 3);
      let budget = speed * dt;
      while (budget > 0 && this._path.length) {
        const [gx, gz] = this._path[0];
        const ddx = gx - this.x, ddz = gz - this.z;
        const dist = Math.hypot(ddx, ddz);
        if (dist < 1e-4) { this._path.shift(); continue; }
        // Turn to face the way we move. The character mesh's front is local -Z
        // (glTF convention), so a raw atan2 yaw points its BACK forward — hence
        // facingOffset (default 180). Tune the dat if a mesh faces elsewhere.
        this._facing = Math.atan2(ddx, ddz) * DEG + (Number(this.facingOffset) || 0);
        const step = Math.min(budget, dist);
        this.x += (ddx / dist) * step;
        this.z += (ddz / dist) * step;
        budget -= step;
        if (dist - step < 1e-4) {
          this.x = gx; this.z = gz;
          this._tx = Math.floor(gx); this._tz = Math.floor(gz);
          this._path.shift();
        }
      }
      this.rotationY = this._facing; // yaw about world-up — turn to face the way we walk
      this._heading = this._facing;  // the camera eases behind this
    }

    // 3) always hug the ground under us
    this._snapY();
  }
}

AE1TileMover.agsDef = {
  name: 'TileMover',
  extends: 'ThirdPersonCharacter',
  // Hand-built: ONLY our hooks are wired, so the ThirdPersonCharacter's WASD/
  // gravity tick (_tpcTick) never runs — movement is purely click-routed.
  runInfo: { _tileBegin: ['onLoad'], _tileTick: ['onTick'] },
};

AE1TileMover.agsDat = {
  ...AE1ThirdPersonCharacter.agsDat,
  clip: '',          // base64 of size*size packed clip bytes
  gridSize: 64,      // tiles per side
  speed: 3,          // tiles per second (walk)
  facingOffset: 180, // deg added to the movement heading so the mesh's front (-Z) leads
  isPlayer: true,
  fadeScenery: false, // dither out scenery between camera and character (occluder fade)
  fadeExcept: '',     // comma-separated element names that must NOT fade (the ground/terrain)
};

defineDatAccessors(AE1TileMover);
