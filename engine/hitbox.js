/**
 * AE1 - Hitbox: an invisible collision volume around a mesh, and the base for
 * PICKABLE items (DESIGN.md §18.11).
 *
 * `(extends Hitbox)` on a decomposed glb element gives it a volume: the AABB of
 * its bound three.js object, asked from the renderer through the same injected
 * channel as the ground query (`world.env3d.boundsOf`) — this file stays pure
 * math, no three.js, and ships in the classic bundle.
 *
 * The volume is never drawn; it exists for overlap tests. The first consumer is
 * the third-person character's pickup: E while overlapping → the element hides,
 * an item enters the inventory, and — through the `mount` component — the
 * renderer parents the mesh to a SOCKET (a bone) on the character. dat:
 *
 *   (socket "rightHand")          ; which character socket to mount to
 *   (mountX 0) (mountY 0) (mountZ 0)      ; grip position offset, WORLD units
 *   (mountOffsetX 0) (mountOffsetY 0) (mountOffsetZ 0)  ; grip rotation, DEGREES
 *   (mountScale 1)                        ; world scale when wielded
 *   (pickable true)                       ; a hitbox that is scenery: false
 *
 * The renderer reads these LIVE while the item is mounted — tune the numbers
 * in Properties during play and watch the grip move in the hand.
 */

import { AE1Element, defineDatAccessors } from './element.js';

export class AE1Hitbox extends AE1Element {
  /** The world-space AABB of the bound mesh: {min:{x,y,z}, max:{x,y,z}}, or
   *  null before the renderer has it. */
  bounds() {
    return this.world?.env3d?.boundsOf?.(this) ?? null;
  }

  /**
   * Does a point (with a little forgiveness) sit inside the volume?
   * `pad` grows the box horizontally — a pickup should not demand pixel
   * placement — and the vertical test accepts anything from the box's base
   * to head height above it.
   */
  containsPoint(x, y, z, pad = 0.5) {
    const b = this.bounds();
    if (!b) return false;
    return (
      x >= b.min.x - pad &&
      x <= b.max.x + pad &&
      z >= b.min.z - pad &&
      z <= b.max.z + pad &&
      y >= b.min.y - pad &&
      y <= b.max.y + 2
    );
  }

  /** Do two volumes overlap? (AABB vs AABB — a weapon swing meeting a body.) */
  intersects(other, pad = 0) {
    const a = this.bounds();
    const b = other?.bounds?.();
    if (!a || !b) return false;
    return (
      a.min.x - pad <= b.max.x && a.max.x + pad >= b.min.x &&
      a.min.y - pad <= b.max.y && a.max.y + pad >= b.min.y &&
      a.min.z - pad <= b.max.z && a.max.z + pad >= b.min.z
    );
  }

  /**
   * AUTO-FIT COLLISION CAPSULE (Austin's call): the AABB's farthest axis
   * becomes the capsule's height, the other two give its radius — no
   * authoring, just the mesh's own bounds. Computed once and cached on the
   * element (`_physCapsule`) rather than every tick: the shape doesn't change
   * once an item is in the world, and `boundsOf` walks the whole mesh.
   * Left `undefined` (not `null`) until a real box comes back, so a call
   * landing before the renderer has bound the object just retries next tick
   * instead of freezing in a bad state.
   */
  _capsuleFit() {
    if (this._physCapsule !== undefined) return this._physCapsule;
    const b = this.world?.env3d?.boundsOf?.(this);
    if (!b) return null;
    const dx = b.max.x - b.min.x, dy = b.max.y - b.min.y, dz = b.max.z - b.min.z;
    const axis = dx >= dy && dx >= dz ? 'x' : dy >= dz ? 'y' : 'z';
    const height = axis === 'x' ? dx : axis === 'y' ? dy : dz;
    const cross = [dx, dy, dz].filter((_, i) => 'xyz'[i] !== axis);
    const radius = Math.max(...cross) / 2;
    // How far BELOW this element's own origin the geometry's lowest point
    // sits — the number gravity actually needs. A prop's origin is wherever
    // it was authored (the fist pair's is `RarmAxis`, a grip marker deep
    // inside the mesh, not its base), so resting the ORIGIN on the ground ray
    // buried everything below it in the floor (Austin's screenshot).
    const bottomOffset = (this.y ?? 0) - b.min.y;
    this._physCapsule = { axis, height, radius, bottomOffset };
    return this._physCapsule;
  }

  /* -- physics (v1: gravity + the floor, §18.12) -------------------------- */
  //
  // `(hasPhysics true)` makes a free item FALL: unmounted, visible, and off
  // the ground → accelerate down, land on whatever the ground ray finds, rest
  // on the AUTO-FIT CAPSULE's base rather than its own origin. This is the
  // seed of the physics system (soft mesh collisions, procedural reaction) —
  // the property surface is here; the depth comes later (lateral capsule-vs-
  // capsule collision is the obvious next increment, once something needs it).
  _hbTick(dt) {
    if (!(this.hasPhysics === true || this.hasPhysics === 'true')) return;
    if (this.components?.model?.mount) return; // a wielded item rides a hand
    if (this.visible === false) return;
    const g = this.world?.env3d?.groundAt?.(this, this.x ?? 0, this.z ?? 0, (this.y ?? 0) + 0.5);
    if (g == null) return;
    const restY = g + (this._capsuleFit()?.bottomOffset ?? 0);
    if ((this.y ?? 0) > restY + 1e-3) {
      this._hbVy = (this._hbVy ?? 0) - 14 * dt;
      this.y = Math.max(restY, (this.y ?? 0) + this._hbVy * dt);
    } else {
      this._hbVy = 0;
      this.y = restY;
    }
  }
}

AE1Hitbox.agsDef = {
  name: 'Hitbox',
  extends: null,
  runInfo: { _hbTick: ['onTick'] },
};

AE1Hitbox.agsDat = {
  socket: 'rightHand',
  mountX: 0,
  mountY: 0,
  mountZ: 0,
  mountOffsetX: 0,
  mountOffsetY: 0,
  mountOffsetZ: 0,
  mountScale: 1,
  pickable: true,
  // A WEAPON while equipped: the character's primary click swings (the
  // `attack` state) instead of just dispatching hooks (§18.11).
  isWeapon: false,
  // What a swing with this weapon takes off a health pool (§18.12).
  damage: 0,
  // THIS weapon's attack clip — overrides the character's `(attack …)` while
  // wielded, so a bazooka fires and a lance stabs (§18.14).
  attack: '',
  // The AMMUNITION: the name of a Projectile element in the scene (its
  // template). Fired at `projectileAt` — a fraction of the attack clip, so
  // the round leaves the muzzle mid-animation, not at the click (§18.15).
  projectile: '',
  projectileAt: 0.5,
  // The item-AUTHORED grip: a child node (a Blender Empty parented to the
  // mesh) whose frame lands exactly on the hand bone when mounted. Empty =
  // auto-detect a node named like Socket*RightHand (§18.14).
  gripNode: '',
  // The item-authored MUZZLE: where a fired round leaves from (§18.16).
  // Empty = auto-detect a node named like *Muzzle*.
  muzzleNode: '',
  // AIM ASSIST (§18.16): while wielded, the weapon mesh pivots AROUND the
  // right-hand grip so the muzzle axis tracks the camera's focal point — the
  // barrel points where the round will fly. Priority order: the GRIP anchors
  // position (never moves out of the hand), the MUZZLE steers orientation
  // (weighted, clamped), the left hand is cosmetic and may be ignored.
  aimAssist: true,
  // How much of the full correction to apply (0..1 — subtle beats robotic),
  // and the most the barrel may swing off its animated pose, in degrees.
  aimWeight: 0.75,
  aimMaxDeg: 30,
  // Gravity + the floor (v1 physics): a free item falls and rests (§18.12).
  hasPhysics: false,
  // Near-plane fading (§18.33): this element's static meshes dither out as
  // they close on the camera instead of slicing across the near plane.
  // Default ON engine-wide (scriptless elements too); false opts out.
  nearFade: true,
};

defineDatAccessors(AE1Hitbox);
