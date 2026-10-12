/**
 * AE1 — BONE PHYSICS (§18.66): the Kawaii-Physics idea, homebrewed.
 *
 * the reference action game rigs ship whole families of SECONDARY bones (hair, coat tails, the
 * Commander's sword sash — the `bone3xxx` chains) that the original game
 * simulated at runtime; frozen at rest they read as starched cloth and
 * floating props. This module is the missing simulation: a pseudo-physics
 * pass that runs AFTER the animation mixers each frame — a post-FX layer
 * for the skeleton, the way the a commercial engine KawaiiPhysics plugin sits on top
 * of an anim graph.
 *
 * THE THREE LESSONS BAKED IN (each one was a visible failure first):
 *
 * 1. THE FEEDBACK TRAP (v1's strobing spikes): secondary bones have no
 *    animation tracks, so the mixer never re-poses them — a rotation
 *    written this frame is read back next frame as "the animated pose"
 *    and the sim springs toward its own output. Pose BOOKKEEPING fixes
 *    it: every chain bone is restored to its pre-physics local unless
 *    the mixer visibly re-posed it.
 *
 * 2. FRAME-RATE COUPLING (v2's fast rigid vibration): applying
 *    stiffness/damping per FRAME makes the spring rate scale with fps
 *    and drowns gravity (a per-frame 0.15 spring holds a horizontal
 *    sword ~9 mm from its rest pose forever). The industry answer —
 *    a commercial engine's anim dynamics, KawaiiPhysics, Blender's wiggle bones — is
 *    a FIXED-TIMESTEP substep loop (h = 1/60, ≤4 substeps, remainder
 *    carried) with coefficients normalized in TIME:
 *      keep   = (1 − damping)^(h·60)      — exponential decay
 *      spring = 1 − (1 − stiffness)^(h·60)
 *    Dats keep their 0..1 per-60fps-frame intuition; behavior no longer
 *    depends on the display's refresh rate.
 *
 * 3. THE CLAMP THAT PINNED THE SWORD: a divergence cap must allow a
 *    horizontal accessory to fold a full quarter-turn and HANG —
 *    maxAngle defaults to 90° and is a tuning dat, not a straitjacket.
 *
 * The sim, per chain (root pinned to its animated position): verlet
 * nodes + gravity + a spring toward the animated pose + an unstretchable
 * length constraint root → tip (near-zero authored segments ride the
 * animation rigidly), a VIRTUAL TIP node past the last bone (KawaiiPhysics'
 * dummy bone: without it the final bone never swings), then blend with
 * the animation by `weight` and aim each bone via a world-space delta
 * applied in local space.
 *
 * Config rides the model component (`model.bonePhys`):
 *   { chains: 'auto' | ['rootA', …],   // auto = every secondary chain
 *     pattern: '^bone3\\d{3}$',  // ANCHOR IT: '^bone3' alone also matches
 *                                // core bones (bone3 = spine, bone30…) and
 *                                // the sim will bend necks with gravity
 *     stiffness: 0.03, damping: 0.35,  // 0..1, calibrated per 60fps frame
 *     gravity: 9.8, weight: 1,
 *     maxAngle: 90, tipLength: 0.12, minLen: 2,
 *     overrides: { rootBoneName: { stiffness, damping, gravity, weight } } }
 *
 * State is keyed by element id and rebuilt when the config object changes
 * identity — dat edits re-apply on play restart.
 */

export function createBonePhys(THREE) {
  const states = new Map(); // el.id -> { cfg, acc, chains: [...] }
  const H = 1 / 60; // the fixed substep
  const MAX_STEPS = 4;

  const _a = new THREE.Vector3();
  const _dirA = new THREE.Vector3();
  const _dirP = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _qi = new THREE.Quaternion();
  const _w = new THREE.Quaternion();
  const _wi = new THREE.Quaternion();
  const EPS = 1e-6;

  function chainParams(cfg, rootName, nodeCount) {
    const o = (cfg.overrides && cfg.overrides[rootName]) || {};
    const stiffness = Math.min(1, Math.max(0, Number(o.stiffness ?? cfg.stiffness ?? 0.03)));
    const damping = Math.min(0.99, Math.max(0, Number(o.damping ?? cfg.damping ?? 0.35)));
    // §18.68 THE WHIP FIX — parameter CURVES along the chain (KawaiiPhysics'
    // damping/stiffness curves): live sampling showed the tail tip moving
    // 6x the root with 10x spikes, because uniform stiffness makes every
    // node chase its (fast-moving) animated target at the same rate and
    // the hard length constraint funnels every correction into the tip.
    // Toward the tip: the spring RELAXES (falloff) so far nodes follow
    // momentum instead of snapping to targets, and damping RISES so the
    // accumulated whip energy bleeds out — fluid, heavy, swoopy.
    const falloff = Math.min(1, Math.max(0, Number(o.stiffnessFalloff ?? cfg.stiffnessFalloff ?? 0.7)));
    const tipDamp = Math.max(0, Number(o.tipDamping ?? cfg.tipDamping ?? 0.4));
    const keepArr = [];
    const springArr = [];
    for (let i = 0; i < nodeCount; i++) {
      const t = nodeCount > 1 ? i / (nodeCount - 1) : 0;
      const s = stiffness * (1 - falloff * t);
      const d = Math.min(0.99, damping + tipDamp * t);
      keepArr.push(Math.pow(1 - d, H * 60));
      springArr.push(1 - Math.pow(1 - s, H * 60));
    }
    return {
      keepArr,
      springArr,
      gravity: Number(o.gravity ?? cfg.gravity ?? 9.8),
      weight: Math.min(1, Math.max(0, Number(o.weight ?? cfg.weight ?? 1))),
      // per-substep speed ceiling (m/s): a solver correction may bend,
      // never crack — the last line against sharp tail snaps
      maxStep: Math.max(0.1, Number(o.maxSpeed ?? cfg.maxSpeed ?? 2.5)) * H,
      iters: Math.max(1, Math.min(6, Number(o.iterations ?? cfg.iterations ?? 3))),
      // §18.69 IN-SIM CONE LIMIT (Kawaii's LimitAngle): each segment may
      // deviate at most this far from its ANIMATED direction — collision's
      // cheap honest cousin. A sash can sway but never curl up through the
      // torso to tangle with the ponytail; sim STATE stays sane too (the
      // old write-time clamp let positions wander while the visual pinned).
      // default OFF (180): with physics owning the bones outright (§18.71)
      // the cone is a shaping tool for chains that must keep an authored
      // curve (hair), not a safety net — on hanging chains it CAUSED curls
      limit: ((Number(o.limitAngle ?? cfg.limitAngle ?? 180)) * Math.PI) / 180,
      // §18.69 GOAL SMOOTHING: a time-constant low-pass on the written
      // pose — 60 Hz solver chatter dies, slow swoop passes through.
      smoothTime: Math.max(0, Number(o.smoothTime ?? cfg.smoothTime ?? 0.05)),
      // §18.73 DRAPE MODE: a chain anchored at BOTH ends (the Commander's
      // waist chain: bone ids jump mid-chain where the return side starts,
      // and its bind shape descends then RISES home). Simulated as an open
      // tail the far anchor flops free and "curls" hunting for its bind
      // position. pinTail pins the last bone like the root and relaxes
      // constraints in BOTH directions — a catenary drape, not a tail.
      pinTail: !!(o.pinTail ?? cfg.pinTail ?? false),
    };
  }

  /** Rotate `dir` back toward `ref` so their angle is at most `limit`.
   *  Both unit vectors; `dir` is modified in place. */
  function clampDir(dir, ref, limit) {
    const cosA = Math.min(1, Math.max(-1, dir.dot(ref)));
    const ang = Math.acos(cosA);
    if (ang <= limit || ang < 1e-6) return;
    // spherical interpolation from ref toward dir, stopping at the cone
    const t = limit / ang;
    const sinA = Math.sin(ang);
    const a = Math.sin((1 - t) * ang) / sinA;
    const b = Math.sin(t * ang) / sinA;
    dir.set(
      ref.x * a + dir.x * b,
      ref.y * a + dir.y * b,
      ref.z * a + dir.z * b,
    ).normalize();
  }

  function buildChains(obj, cfg) {
    const bones = [];
    let skeleton = null;
    obj.traverse((o) => {
      if (o.isBone) bones.push(o);
      if (!skeleton && o.isSkinnedMesh && o.skeleton) skeleton = o.skeleton;
    });
    const byName = new Map(bones.map((b) => [b.name, b]));
    // §18.72 THE TRUE REST POSE: chains build lazily, AFTER the mixer has
    // posed some frame of the current clip — capturing bone quats then
    // froze a mid-swing baked-sim pose as "rest" (and a different one each
    // play session: the sash curled a different way every run). The
    // skeleton's INVERSE BIND MATRICES are the phase-independent truth:
    // bindLocal(bone) = inv(bindWorld(parent)) · bindWorld(bone), with
    // bindWorld = inv(boneInverse). Mesh-space conventions cancel in the
    // ratio. Falls back to captured quats when no skeleton is found.
    const bindIdx = new Map();
    if (skeleton) skeleton.bones.forEach((b, i) => bindIdx.set(b, i));
    const _m1 = new THREE.Matrix4();
    const _m2 = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _s = new THREE.Vector3();
    function bindLocal(bone) {
      const i = bindIdx.get(bone);
      const ip = bindIdx.get(bone.parent);
      if (skeleton == null || i === undefined || ip === undefined) return null;
      _m1.copy(skeleton.boneInverses[i]).invert(); // bindWorld(bone)
      _m2.copy(skeleton.boneInverses[ip]); // inv(bindWorld(parent))
      _m2.multiply(_m1); // local bind
      const q = new THREE.Quaternion();
      _m2.decompose(_p, q, _s);
      return { q, p: _p.clone() };
    }
    const pattern = new RegExp(cfg.pattern || '^bone3\\d{3}$');
    const minLen = Math.max(1, Number(cfg.minLen) || 2);

    let roots;
    if (Array.isArray(cfg.chains)) {
      roots = cfg.chains.map((n) => byName.get(String(n))).filter(Boolean);
    } else {
      roots = bones.filter((b) => pattern.test(b.name)
        && !(b.parent && b.parent.isBone && pattern.test(b.parent.name)));
    }
    const chains = [];
    for (const root of roots) {
      const chain = [root];
      let cur = root;
      for (;;) {
        const next = cur.children.find((c) => c.isBone);
        if (!next) break;
        chain.push(next);
        cur = next;
      }
      if (chain.length < minLen) continue;
      const m = chain.length + 1; // + the virtual tip
      chains.push({
        bones: chain,
        params: chainParams(cfg, root.name, m),
        pos: Array.from({ length: m }, () => new THREE.Vector3()),
        prev: Array.from({ length: m }, () => new THREE.Vector3()),
        anim: Array.from({ length: m }, () => new THREE.Vector3()),
        goal: Array.from({ length: m }, () => new THREE.Vector3()),
        lastGoal: Array.from({ length: m }, () => new THREE.Vector3()),
        // §18.71: PHYSICS OWNS THESE BONES OUTRIGHT (Austin's call). the reference action game
        // clips carry tracks for the secondary bones — the original game's
        // sim pose baked into the mots — so the mixer re-posed the sash
        // toward its authored stick-out every frame and the spring/cone
        // fought it forever. Every frame the chain is pinned back to the
        // BIND rest shape (§18.72 — from the skeleton's inverse bind
        // matrices, never a mixer-posed snapshot), carried through the
        // world by the animated body; the sim is the only thing that
        // moves it.
        restLocal: chain.map((b) => {
          const bl = bindLocal(b);
          return bl ? bl : { q: b.quaternion.clone(), p: b.position.clone() };
        }),
        seeded: false,
      });
    }
    return chains;
  }

  function step(el, obj, cfg, dt) {
    let st = states.get(el.id);
    if (!st || st.cfg !== cfg) {
      st = { cfg, acc: 0, chains: buildChains(obj, cfg) };
      states.set(el.id, st);
    }
    if (!st.chains.length || dt <= 0) return;
    el._bonePhysDebug = st; // dev inspection hook (sim state vs written pose)

    const maxAngle = ((Number(cfg.maxAngle) || 90) * Math.PI) / 180;
    const tipLength = Number(cfg.tipLength) || 0.12;
    st.acc = Math.min(st.acc + dt, H * MAX_STEPS);
    const steps = Math.floor(st.acc / H);
    st.acc -= steps * H;
    // §18.70 THE ZERO-SUBSTEP STROBE: steps may be 0 on frames where less
    // than one fixed step accumulated (any refresh rate above 60 Hz, and
    // ordinary frame-time wobble at 60). The mixer has ALREADY re-posed
    // the skeleton this frame, so returning early rendered one frame of
    // the PURE ANIMATED pose — a visible strobe between animation and
    // physics, worst where they diverge most (the ponytail tip, the
    // sash). The INTEGRATION below is gated by `steps`; the restore →
    // measure → blend → WRITE pipeline must run EVERY frame.

    for (const ch of st.chains) {
      const n = ch.bones.length;
      const m = n + 1; // node count incl the virtual tip
      const p = ch.params;

      // -- pin claimed bones to the BIND rest shape (§18.71/72) ------------ //
      // Whatever the mixer wrote this frame is discarded: physics-owned
      // bones follow the bind pose carried by the animated body, and the
      // sim below is their only source of motion. Rotation AND position —
      // the baked-sim tracks translate these bones too.
      for (let i = 0; i < n; i++) {
        ch.bones[i].quaternion.copy(ch.restLocal[i].q);
        ch.bones[i].position.copy(ch.restLocal[i].p);
      }
      ch.bones[0].parent?.updateWorldMatrix(true, false);
      for (let i = 0; i < n; i++) {
        ch.bones[i].updateWorldMatrix(false, false);
        ch.anim[i].setFromMatrixPosition(ch.bones[i].matrixWorld);
      }
      // the virtual tip continues the last real segment (KawaiiPhysics'
      // dummy bone) — a lone accessory bone becomes a pendulum
      _dirA.subVectors(ch.anim[n - 1], ch.anim[n >= 2 ? n - 2 : 0]);
      if (_dirA.lengthSq() < EPS * EPS) _dirA.set(0, -1, 0);
      else _dirA.normalize();
      ch.anim[n].copy(ch.anim[n - 1]).addScaledVector(_dirA, tipLength);

      // §18.77 RESEED ON JUMP: a teleport/spawn moves the element metres in
      // one frame; the constraints then drag the chain violently across the
      // gap and it TANGLES. A vertical-bind chain recovers (its degenerate
      // fallback is stable); an arc-bind chain collapses into a crumple
      // attractor forever (the belt's "scrunched spiral": collapsed nodes
      // rebuild spacing along the bind arc's rotating directions, coil,
      // re-collapse). Any root jump beyond a body-length starts the sim
      // fresh from the clean bind shape.
      const jumped = ch.seeded && ch.rootPrev && ch.anim[0].distanceTo(ch.rootPrev) > 0.75;
      if (!ch.seeded || jumped) {
        for (let i = 0; i < m; i++) {
          ch.pos[i].copy(ch.anim[i]);
          ch.prev[i].copy(ch.anim[i]);
          ch.lastGoal[i].copy(ch.anim[i]);
        }
        ch.seeded = true;
        ch.smoothSeeded = false;
      }
      ch.rootPrev = ch.rootPrev || new THREE.Vector3();
      ch.rootPrev.copy(ch.anim[0]);

      // -- the fixed-timestep loop (lesson 2) ------------------------------ //
      // drape mode (§18.73): no virtual tip — the last REAL bone is the
      // second anchor
      const mm = p.pinTail ? n : m;
      for (let s = 0; s < steps; s++) {
        const g = p.gravity * H * H;
        ch.pos[0].copy(ch.anim[0]);
        ch.prev[0].copy(ch.anim[0]);
        if (p.pinTail) {
          ch.pos[mm - 1].copy(ch.anim[mm - 1]);
          ch.prev[mm - 1].copy(ch.anim[mm - 1]);
        }
        for (let i = 1; i < (p.pinTail ? mm - 1 : mm); i++) {
          _a.subVectors(ch.pos[i], ch.prev[i]).multiplyScalar(p.keepArr[i]);
          // §18.68: the speed ceiling — a correction bends, never cracks
          const sp = _a.length();
          if (sp > p.maxStep) _a.multiplyScalar(p.maxStep / sp);
          ch.prev[i].copy(ch.pos[i]);
          ch.pos[i].add(_a);
          ch.pos[i].y -= g;
          ch.pos[i].lerp(ch.anim[i], p.springArr[i]);
        }
        // §18.68: SOFT-ITERATED constraints. A hard root→tip projection is
        // exact in one pass — and dumps every correction straight into the
        // tail (the whip). Early passes here are SOFT (half-way moves that
        // let the correction diffuse along the chain); the final pass is
        // hard, so the chain still never stretches.
        for (let it = 0; it < p.iters; it++) {
          const alpha = it === p.iters - 1 ? 1 : 0.5;
          const hard = it === p.iters - 1;
          // §18.69b: PARENT-RELATIVE cone reference (the Kawaii composition).
          // Anchoring the limit to the world-space ANIMATED direction was
          // wrong for chains whose authored pose must NOT hold: the sash is
          // authored horizontal, so gravity-down fought a cone pulling back
          // toward horizontal and equilibrium was an upward curl. The
          // reference for segment i is its animated direction ROTATED BY
          // THE PARENT SEGMENT'S OWN DEVIATION — a chain may hang fully
          // (every joint bending ≤ limit) while joint REVERSALS (curls)
          // stay impossible.
          _q.identity(); // parent deviation carried down the chain
          const last = p.pinTail ? mm - 1 : mm; // never move a pinned tail
          for (let i = 1; i < last; i++) {
            const rest = ch.anim[i].distanceTo(ch.anim[i - 1]);
            if (rest < 1e-4) {
              ch.pos[i].copy(ch.pos[i - 1]).add(_a.subVectors(ch.anim[i], ch.anim[i - 1]));
              continue;
            }
            _dirP.subVectors(ch.pos[i], ch.pos[i - 1]);
            const len = _dirP.length();
            if (len < EPS) _dirP.subVectors(ch.anim[i], ch.anim[i - 1]).normalize();
            else _dirP.multiplyScalar(1 / len);
            if (hard && !p.pinTail) {
              _dirA.subVectors(ch.anim[i], ch.anim[i - 1]).normalize();
              _a.copy(_dirA).applyQuaternion(_q); // the parent-relative reference
              clampDir(_dirP, _a, p.limit);
              _qi.setFromUnitVectors(_dirA, _dirP);
              _q.copy(_qi); // this segment's deviation frames the next one
            }
            _a.copy(ch.pos[i - 1]).addScaledVector(_dirP, rest); // the satisfied spot
            ch.pos[i].lerp(_a, alpha);
          }
          // §18.73: the drape's SECOND anchor pulls back — a mirrored pass
          // from the pinned tail toward the root distributes the sag both
          // ways (the two-anchor catenary; one-sided passes would stretch
          // the far half).
          if (p.pinTail) {
            for (let i = mm - 2; i >= 1; i--) {
              const rest = ch.anim[i].distanceTo(ch.anim[i + 1]);
              if (rest < 1e-4) {
                ch.pos[i].copy(ch.pos[i + 1]).add(_a.subVectors(ch.anim[i], ch.anim[i + 1]));
                continue;
              }
              _dirP.subVectors(ch.pos[i], ch.pos[i + 1]);
              const len = _dirP.length();
              if (len < EPS) _dirP.subVectors(ch.anim[i], ch.anim[i + 1]).normalize();
              else _dirP.multiplyScalar(1 / len);
              _a.copy(ch.pos[i + 1]).addScaledVector(_dirP, rest);
              ch.pos[i].lerp(_a, alpha);
            }
          }
        }
      }

      // -- blend + write rotations ----------------------------------------- //
      // §18.69: goal smoothing — an exponential low-pass over the WRITTEN
      // pose. Solver chatter (sub-frame direction flips at the tip) never
      // reaches the skeleton; slow swoop passes through unchanged.
      const simDt = steps * H;
      const sAlpha = p.smoothTime > 0 ? 1 - Math.exp(-simDt / p.smoothTime) : 1;
      for (let i = 0; i < m; i++) {
        ch.goal[i].copy(ch.anim[i]).lerp(ch.pos[i], p.weight);
        if (ch.smoothSeeded) ch.goal[i].copy(ch.lastGoal[i].lerp(ch.goal[i], sAlpha));
        else ch.lastGoal[i].copy(ch.goal[i]);
      }
      ch.smoothSeeded = true;
      // §18.75: the LAST bone aims too — at the virtual tip. Unaimed, it
      // keeps its BIND orientation (horizontal, for outstretch-rigged
      // chains) and any mesh weighted to it sticks straight out even when
      // every bone position hangs correctly (the belt's phantom arc).
      // Pinned drapes have no virtual tip; their tail bone stays put.
      // §18.76 PARALLEL TRANSPORT (the anti-corkscrew): per-bone MINIMAL
      // swings preserve each bone's BIND roll — and a chain rigged in an
      // arc carries progressively rotated rolls, so straightening it with
      // independent swings leaves those rolls staggered around the new
      // axis: the mesh tube coils into a spiral even though the bone
      // POSITIONS hang in a clean line (the belt's "scrunched knot").
      // Instead the accumulated swing is carried down the chain and each
      // child adds only the small RESIDUAL rotation on top of its
      // parent's frame — rolls stay coherent, the tube stays a tube.
      const aimCount = p.pinTail ? n - 1 : n;
      _q.identity(); // the transported (accumulated) world-space swing
      for (let i = 0; i < aimCount; i++) {
        const bone = ch.bones[i];
        _dirA.subVectors(ch.anim[i + 1], ch.anim[i]);
        _dirP.subVectors(ch.goal[i + 1], ch.goal[i]);
        if (_dirA.lengthSq() > EPS * EPS && _dirP.lengthSq() > EPS * EPS) {
          _dirA.normalize();
          _dirP.normalize();
          // §18.78 APPLY THE RESIDUAL ONLY: with fresh parent matrices
          // (§18.74) this bone's current world direction ALREADY carries
          // the parent chain's written swing (≈ transported · animDir).
          // Applying the transported TOTAL again double-counts the parent
          // swing and folds the chain back on itself — the sim hung the
          // belt perfectly while the skeleton stayed a scrunched knot.
          _a.copy(_dirA).applyQuaternion(_q); // where this segment points now
          _qi.setFromUnitVectors(_a, _dirP); // the residual to add
          const ang = 2 * Math.acos(Math.min(1, Math.abs(_qi.w)));
          if (ang > maxAngle) {
            _w.identity();
            _qi.slerpQuaternions(_w, _qi, maxAngle / ang);
          }
          bone.parent.getWorldQuaternion(_w);
          _wi.copy(_w).invert();
          // L' = (W^-1 · q_res · W) · L
          bone.quaternion.premultiply(_wi.multiply(_qi).multiply(_w));
          _q.premultiply(_qi); // transported total = residual ∘ previous
        }
        // §18.74: refresh THIS bone's world matrix before its child is
        // aimed — the child's world→local conversion must see the parent's
        // JUST-WRITTEN rotation. With a stale parent the local delta is
        // computed in the wrong frame and the error COMPOUNDS down the
        // chain: invisible on near-bind chains (small deltas), chaos on a
        // chain that needs ~90° at every level (the waist chain that
        // refused to hang under gravity 30).
        bone.updateWorldMatrix(false, false);
      }
    }
  }

  /** Forget an element's sim (unbound, deleted, scene change). */
  function drop(elId) {
    states.delete(elId);
  }

  return { step, drop };
}
