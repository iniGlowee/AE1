// gfx.hpp — the native renderer seam.
//
// The interface docs/engine/20 calls the render backend. The decision (2026-09-04):
// implement it on D3D11 now (zero new deps — the Windows SDK), keeping bgfx as
// the documented future backend that drops in behind THIS header unchanged. The
// engine's `env3d.*` contract is the higher-level renderer interface scripts see;
// this is the low-level RHI beneath it, the layer a bgfx port would replace.
//
// Deliberately small at first: create a mesh, set a camera, draw meshes with a
// model transform and simple lighting. It grows toward three.js material/lighting
// semantics as the renderer takes over the stubbed element types.
#pragma once
#include "mat.hpp"
#include <string>
#include <cstdint>
#include <vector>

namespace ae1 {

struct Vertex {
    float px, py, pz;   // position
    float nx, ny, nz;   // normal
    float u, v;         // texcoord0
    float r, g, b;      // vertex color (tints the sampled base color)
};

struct MeshHandle { uint32_t id = 0; bool valid() const { return id != 0; } };
struct TexHandle  { uint32_t id = 0; bool valid() const { return id != 0; } };  // 0 = white

class Gfx {
public:
    Gfx();
    ~Gfx();
    Gfx(const Gfx&) = delete;
    Gfx& operator=(const Gfx&) = delete;

    // Create device + swapchain for an existing OS window (HWND on Win32),
    // passed as an opaque handle so callers need no windows.h.
    bool init(void* nativeWindowHandle, int width, int height, std::string& err);
    void shutdown();
    void resize(int width, int height);

    // `dynamic` meshes can be re-posed each frame with updateMesh (for skinning).
    MeshHandle createMesh(const Vertex* verts, size_t vcount,
                          const uint32_t* indices, size_t icount, bool dynamic = false);
    // Overwrite a dynamic mesh's vertices (count must not exceed the original).
    void updateMesh(MeshHandle mesh, const Vertex* verts, size_t vcount);
    // Release a mesh's GPU buffers (scene teardown). The handle slot is recycled
    // by a later createMesh. Safe to call with an invalid/0 handle (no-op).
    void destroyMesh(MeshHandle mesh);
    // PBR material factors for this mesh (glTF pbrMetallicRoughness).
    void setMeshMaterial(MeshHandle mesh, float metallic, float roughness);
    // Diagnostics: `total` = mesh slots ever allocated, `free` = recycled/idle
    // slots. `total - free` is the LIVE mesh count — it must stay bounded across
    // scene changes (proof that teardown frees and createMesh recycles).
    void meshStats(int& total, int& free) const;
    // RGBA8 texture (row-major, w*h*4 bytes). Returns an invalid handle on failure.
    TexHandle createTexture(const uint8_t* rgba, int width, int height);

    void beginFrame(float r, float g, float b);   // clear color + depth
    void setViewProj(const Mat4& view, const Mat4& proj);
    // Directional light: travel direction, color, and a flat ambient term.
    void setLight(Vec3 dir, float r, float g, float b, float ambient);
    // Equirect HDR environment: the skybox background AND (envColor) the
    // image-based ambient tint. rgb is width*height*3 float32 (Radiance .hdr).
    // opacity dims the background; rotation (radians) spins it about Y;
    // envIntensity scales the ambient the sky contributes to lit surfaces.
    void setEnvMap(const float* rgb, int width, int height,
                   float opacity, float rotation, float envIntensity);
    // Depth-of-field: sharp within `range` of `focus` metres from the camera,
    // blurring out to `maxBlur` (fraction of screen height). maxBlur 0 disables.
    void setDOF(float focus, float range, float maxBlur);
    // Enable sun shadows: the fitted ortho frustum centered on the scene.
    // radius <= 0 disables shadows.
    void setShadowBounds(Vec3 center, float radius);
    // Shadow depth pass (from the sun's view). Call before beginFrame each frame:
    // beginShadowPass(), drawMeshShadow() for every opaque mesh, endShadowPass().
    void beginShadowPass();
    void drawMeshShadow(MeshHandle mesh, const Mat4& model);
    void endShadowPass();
    // `blended` = alpha-blend this draw (transparent pass, depth-test no-write);
    // otherwise opaque (blend off, depth write). tex.id 0 => white.
    void drawMesh(MeshHandle mesh, const Mat4& model, TexHandle tex = {}, float alphaCutoff = 0.0f, bool blended = false);
    // Instanced: one draw call renders `count` copies of `mesh`, each at its own
    // model matrix (scatter dressing). Opaque only. The shadow variant fills the
    // sun depth for the same instances (call inside the shadow pass).
    void drawMeshInstanced(MeshHandle mesh, const Mat4* models, size_t count, TexHandle tex = {}, float alphaCutoff = 0.0f);
    void drawMeshInstancedShadow(MeshHandle mesh, const Mat4* models, size_t count);
    void endFrame();                               // tonemap composite -> backbuffer (no present)
    void present();                                // vsync swap (call after any overlay)
    // 2D screen-space overlay (UI): pixel-space quads, alpha-blended, no depth,
    // drawn on the backbuffer after endFrame. One vertex = pos(px) + uv + rgba.
    struct Overlay2DVert { float x, y, u, v, r, g, b, a; };
    void drawOverlay(const Overlay2DVert* verts, size_t count, TexHandle tex);
    // Particle FX: world-space, camera-facing billboards. One vertex = world
    // position + uv + premultiplied-ish rgba. Drawn into the HDR scene target
    // after the opaque/transparent passes, with depth TEST (occluded by geometry)
    // but no depth WRITE; `additive` picks additive (glows) vs alpha (smoke)
    // blending. The soft radial sprite is built into the renderer.
    struct ParticleVert { float x, y, z, u, v, r, g, b, a; };
    void drawParticles(const ParticleVert* verts, size_t count, bool additive);
    // Read the current backbuffer into tightly-packed RGBA8 (top-down). For
    // headless visual verification — dump to an image and look at the pose.
    bool screenshot(std::vector<uint8_t>& rgba, int& w, int& h);

private:
    struct Impl;
    Impl* p_ = nullptr;
};

} // namespace ae1
