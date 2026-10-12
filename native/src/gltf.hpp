// gltf.hpp — load mesh geometry from a GLB straight out of the mapped pack.
//
// Reads glTF 2.0 binary (GLB): the JSON chunk + the BIN chunk, walks the node
// hierarchy, and bakes each mesh primitive's positions/normals into WORLD space
// (glTF's right-handed Y-up converted to the renderer's left-handed space by a
// Z flip). Output is CPU meshes the caller uploads via Gfx::createMesh.
//
// Scope right now: the UNCOMPRESSED path (float POSITION/NORMAL, u16/u32
// indices) — the small props in the pack. Meshes using EXT_meshopt_compression
// or quantized (KHR_mesh_quantization) accessors are reported as unsupported;
// decoding those is the next increment.
#pragma once
#include "gfx.hpp"   // Vertex, Vec3
#include <vector>
#include <string>
#include <cstdint>

namespace ae1 {

struct CpuMesh {
    std::vector<Vertex>   verts;
    std::vector<uint32_t> indices;
    // Raw base-color image bytes lifted from the glb (empty if the primitive has
    // no base-color texture). `baseColorKTX2` marks a KHR_texture_basisu / KTX2
    // image (the caller transcodes it); other encodings (e.g. PNG) are left for
    // the caller to decode or skip. UVs are already baked into verts (incl. any
    // KHR_texture_transform).
    std::vector<uint8_t>  baseColorBytes;
    bool                  baseColorKTX2 = false;
    // >0 => alpha-test: discard fragments whose sampled alpha is below this
    // (glTF MASK cutoff). BLEND prims set `transparent` instead and are drawn
    // in a sorted back-to-front pass with alpha blending.
    float                 alphaCutoff = 0.0f;
    bool                  transparent = false;   // glTF alphaMode BLEND
    // pbrMetallicRoughness FACTORS (the devroom models use factors, not MR
    // textures). Defaults are the dielectric case, not glTF's metal=1/rough=1,
    // so an untextured/material-less mesh doesn't render as chrome.
    float                 metallic = 0.0f;
    float                 roughness = 0.7f;
};

// Parse a GLB. On success fills `out` and returns true. On an unsupported
// feature or malformed data, returns false with `err`.
//
// `rootColMajor`, when non-null, is a 4x4 column-major right-handed matrix
// (three.js convention) applied as the parent of the glTF scene — i.e. the
// AE1 element's world transform (position/rotation/scale). Meshes bake through
// it before the right-handed -> left-handed Z flip, so a scene of elements
// lands where the game places them. Pass null for the glb in its own space.
bool loadGlbMeshes(const uint8_t* glb, size_t len,
                   std::vector<CpuMesh>& out, std::string& err,
                   const double* rootColMajor = nullptr);

// Combined AABB over all meshes (for framing the camera). lo/hi untouched if empty.
void meshBounds(const std::vector<CpuMesh>& meshes, Vec3& lo, Vec3& hi);

// ---- animation -------------------------------------------------------------
// A posable rig: the glb kept in a form that can be re-posed and re-skinned each
// frame from its glTF animation channels. Opaque; created/destroyed explicitly.
struct GlbRig;

// Load a glb as a rig. Also fills `outMeshes` with the bind-pose meshes (verts,
// indices, base-color) — the caller uploads these as DYNAMIC meshes and then
// calls poseRig each frame to refresh their verts. Returns null + err on failure.
GlbRig* loadGlbRig(const uint8_t* glb, size_t len,
                   std::vector<CpuMesh>& outMeshes, std::string& err);
void freeGlbRig(GlbRig* rig);

int         rigAnimCount(const GlbRig* rig);
std::string rigAnimName(const GlbRig* rig, int i);
float       rigAnimDuration(const GlbRig* rig, int i);   // seconds
int         rigFindAnim(const GlbRig* rig, const std::string& name);  // -1 if absent

// Pose the rig at `timeSec` of animation `animIndex` (looped) and rewrite the
// vertex positions/normals of `meshes` in place (same order/count as load).
void poseRig(GlbRig* rig, int animIndex, float timeSec, std::vector<CpuMesh>& meshes);

// Sample a clip into per-node LOCAL TRS (10 doubles/node: px,py,pz, qx,qy,qz,qw,
// sx,sy,sz), in rig->nodes order. Used to drive a JS bone graph for bone physics
// without skinning here. `out` is resized to nodeCount*10.
void rigPoseLocals(GlbRig* rig, int animIndex, float timeSec, std::vector<double>& out);

// --- motion-matching skeleton bridge: expose the node hierarchy so JS can build a
// bone graph the matcher poses, then skin from that graph's world matrices. ---
bool        rigSkinned(const GlbRig* rig);       // has at least one skin
int         rigNodeCount(const GlbRig* rig);
std::string rigNodeName(const GlbRig* rig, int i);
int         rigNodeParent(const GlbRig* rig, int i);   // -1 for roots
// bind-pose local TRS: [px,py,pz, qx,qy,qz,qw, sx,sy,sz]
void        rigNodeBind(const GlbRig* rig, int i, double out[10]);

// Skin `meshes` from externally-supplied node WORLD matrices (column-major, 16
// per node, `nodeCount` of them) — used when the motion-matching matcher poses the
// bone graph in JS and we read its world matrices back here.
void poseRigFromWorlds(GlbRig* rig, const double* nodeWorlds, int nodeCount,
                       std::vector<CpuMesh>& meshes);

} // namespace ae1
