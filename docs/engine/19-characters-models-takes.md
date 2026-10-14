# 19 — Character models, the 008 head, mocap takes, and hair (§18.84–§18.86)

The last pre-cleanup era (Aug 31) rebuilt the player character's head for facial animation,
built a repeatable mocap-take pipeline, and settled hair transparency. All of
it ships in `projects/devroom`.

## The canonical the player character — version 008

Skeleton: **UE5_Manny_DEFORM** — UE5-mannequin family fitted to the reference action game
proportions, A-pose rest, faces −Y, authored in CENTIMETERS (pelvis
translations ~100; import versioned glbs into Blender at scale 0.01). The
versioned files also carry decoy control rigs — the authoritative armature
is whatever the skinned mesh's ARMATURE modifier targets.

**008 is the authored-head build**: 007's body with the old merged head cut
away (by MATERIAL purge + a tilted planar bisect — never by weight
threshold: neck skin and choker carry head weights up to 0.6, so a weight
cut tears ragged holes), adopting the game's own separate face / eyes /
eyelash / hair meshes with their original weight painting, plus the blindfold
and hairband recovered from the outfit extract. 25 the reference action game face bones
(bone2816 jaw, 2817/2818 eyes, 315x–317x hair strands) are grafted under
canonical `head` and KEEP their the reference action game names so facial mots drive them by
name. The body's neck is the visible neck up to the jawline; the face's
thinner tube hides inside it.

Traps that cost real time:
- Edit-bone matrices are ARMATURE-LOCAL — assigning world matrices parks
  every grafted bone at the floor. Rest pose looks perfect (skinning is
  identity at rest); only a displacement-magnitude test catches it.
- **Count-only deform tests lie.** Verify max displacement AND mean distance
  from the pivot; when Blender harnesses disagree, read JOINTS_0/WEIGHTS_0
  straight from the glb binary.
- glTF exports 4 influences per vertex, silently dropping the rest; skin
  joint lists are not weight lists.

## The character-glb swap checklist

Any time a character model is exported from Blender and swapped into a
project's media, run all three patches or you get a known failure:

1. **Alpha** — Blender 4.2 exports every material `alphaMode: BLEND`
   (ghosting, vanishing parts). Patch: hair/eyelash → `MASK` with a cut
   value (0.4 shipped), everything else → `OPAQUE`.
2. **PBR sanitize** — raw materials extracted from the reference action game carry `metallicFactor 1` +
   a garbage MR texture (renders black), and meshes carry all-black
   `COLOR_0` vertex colors (multiply the textures to black). Zero the
   metals, strip the vertex colors.
3. **Node name** — the scene's model component attaches by exact node name
   (`"node": "UE5_Manny_DEFORM"`). A Blender `.001` suffix means an
   invisible player with **no console error**.

## Hair (§18.84 → §18.86)

§18.84 hashed all hair because hard alpha-test chews the reference game's feathered
strands into triangular holes. The authored 008 head flipped the trade: its
textures sit heavily in the soft mid-alpha band and stack two hair shells,
so the hash dither read as visible static. Revision (§18.86, in
`conditionGltf`): **hair that ARRIVES masked keeps its authored cut value**
(crisp cutout); hair arriving BLEND still gets hashed. The per-frame
alphaTest=0 invariant only fires on hashed materials. Practical split: the player character
ships MASK; the companion character/Commander/the operator ship BLEND and keep their hashed look.

## The mocap take pipeline

Takes arrive from the capture pipeline as .blend files on the merged
105-bone rig at 30 fps — body, 30 finger channels, and (since the 008 head)
the face bones. To ship one as a dialogue performance:

1. **Export** armature-only with the clip named for its socket (the lucky
   handler plays `mocap_luckyN.glb#lucky`). A raw full-character export
   works too — the strip tool rebuilds it to a bone-only library
   (~190 MB → ~20 MB) and renames the clip.
2. **Ground** it: the element owns the root node transform at runtime
   (armature-object channels are discarded), so height reaches the game only
   through the PELVIS bone channel. Shift it by the 5th-percentile
   stance-floor of per-frame lowest-foot heights, along the pelvis local
   axis whose analytic rest-matrix column maps to world height (the rig is
   in cm — rates near 0.01 are correct).
3. **Sync**: trigger the clip and `voiceLine` in the same statement. For a
   looped performance, equal periods keep every cycle aligned — trim the
   longer of clip/audio to the shorter, or accept drift after cycle one and
   say so in a comment.
4. Scripted-take state: `_mmAction='attack'`, `_mmActionT=-100000`,
   `_attackHit=true`; talking to the performer again releases.

## FIRST_PERSON (§18.85)

A wired debug-wall flag. The orbit camera's rotation comes from
`_yaw/_pitch` independent of position, so first person is the boom distance
going **negative** (`fpAhead`, default 0.3 m): the camera parks ahead of the
face looking the character's own forward — head and hair land behind the
near plane, nothing hidden, mouse look untouched. Shoulder framing zeroes
and the chase-lag snaps every frame while active. Follows possession.
