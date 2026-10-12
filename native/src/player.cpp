// player.cpp — ae1player: the Phase-A native shell.
//
// Usage: ae1player <agp-dir> [--seconds N]
//
// Opens an AE1 Game Package, stands up a native window (Platform seam) and a
// D3D11 renderer (Gfx seam), and runs a fixed-timestep loop. It does not draw
// the game's scene yet — the renderer is still coming up behind the gfx seam —
// so it renders a spinning lit cube to prove the whole path end to end: window,
// device, swapchain, depth, a compiled shader, vertex/index buffers, a camera
// matrix, and per-object transforms. The scene's meshes replace the cube once
// glTF loading from the mapped pack lands.
#include "agp.hpp"
#include "platform.hpp"
#include "gfx.hpp"
#include "gltf.hpp"
#include "tex.hpp"
#include "json.hpp"

#include <cstdio>
#include <cmath>
#include <cstdlib>
#include <string>
#include <vector>
#include <array>
#include <map>
#include <functional>

using Mat16 = std::array<double, 16>;

// Column-major (three.js) T*R*S from an AE1 element's transform fields.
static Mat16 elemLocalMatrix(const ae1::Json& el) {
    const double DEG = 3.14159265358979323846 / 180.0;
    double x = el["x"].num(), y = el["y"].num(), z = el["z"].num();
    double rx = el["rotationX"].num() * DEG, ry = el["rotationY"].num() * DEG, rz = el["rotation"].num() * DEG;
    double sx = el["scaleX"].num(1.0), sy = el["scaleY"].num(1.0), sz = el["scaleZ"].num(1.0);
    bool yxz = el["rotationOrder"].str() == "YXZ";
    double a = std::cos(rx), b = std::sin(rx), c = std::cos(ry), d = std::sin(ry), e = std::cos(rz), f = std::sin(rz);
    double t0, t1, t2, t4, t5, t6, t8, t9, t10;
    if (yxz) {
        double ce = c*e, cf = c*f, de = d*e, df = d*f;
        t0 = ce + df*b; t4 = de*b - cf; t8 = a*d;
        t1 = a*f;       t5 = a*e;       t9 = -b;
        t2 = cf*b - de; t6 = df + ce*b; t10 = a*c;
    } else { // XYZ
        double ae = a*e, af = a*f, be = b*e, bf = b*f;
        t0 = c*e;        t4 = -c*f;       t8 = d;
        t1 = af + be*d;  t5 = ae - bf*d;  t9 = -b*c;
        t2 = bf - ae*d;  t6 = be + af*d;  t10 = a*c;
    }
    return { t0*sx, t1*sx, t2*sx, 0,
             t4*sy, t5*sy, t6*sy, 0,
             t8*sz, t9*sz, t10*sz, 0,
             x, y, z, 1 };
}
// C = A * B, column-major, column-vector convention (B applied first).
static Mat16 matmulCM(const Mat16& A, const Mat16& B) {
    Mat16 C{};
    for (int col = 0; col < 4; col++)
        for (int row = 0; row < 4; row++) {
            double s = 0;
            for (int k = 0; k < 4; k++) s += A[k * 4 + row] * B[col * 4 + k];
            C[col * 4 + row] = s;
        }
    return C;
}

using namespace ae1;

// A unit cube: 6 faces, 4 verts each (per-face normal + color), 36 indices.
static void buildCube(std::vector<Vertex>& v, std::vector<uint32_t>& idx) {
    struct Face { Vec3 n; float r, g, b; Vec3 a, b2, c, d; };
    const float h = 0.5f;
    Face faces[6] = {
        {{ 0, 0, 1}, 0.90f,0.30f,0.35f, {-h,-h, h},{ h,-h, h},{ h, h, h},{-h, h, h}}, // +Z
        {{ 0, 0,-1}, 0.35f,0.75f,0.90f, { h,-h,-h},{-h,-h,-h},{-h, h,-h},{ h, h,-h}}, // -Z
        {{ 1, 0, 0}, 0.95f,0.70f,0.30f, { h,-h, h},{ h,-h,-h},{ h, h,-h},{ h, h, h}}, // +X
        {{-1, 0, 0}, 0.55f,0.85f,0.45f, {-h,-h,-h},{-h,-h, h},{-h, h, h},{-h, h,-h}}, // -X
        {{ 0, 1, 0}, 0.85f,0.85f,0.90f, {-h, h, h},{ h, h, h},{ h, h,-h},{-h, h,-h}}, // +Y
        {{ 0,-1, 0}, 0.45f,0.45f,0.55f, {-h,-h,-h},{ h,-h,-h},{ h,-h, h},{-h,-h, h}}, // -Y
    };
    for (const Face& f : faces) {
        uint32_t base = (uint32_t)v.size();
        const Vec3 pts[4] = { f.a, f.b2, f.c, f.d };
        for (const Vec3& p : pts)
            v.push_back({ p.x, p.y, p.z, f.n.x, f.n.y, f.n.z, f.r, f.g, f.b });
        idx.push_back(base + 0); idx.push_back(base + 1); idx.push_back(base + 2);
        idx.push_back(base + 0); idx.push_back(base + 2); idx.push_back(base + 3);
    }
}

int main(int argc, char** argv) {
    if (argc < 2) {
        std::printf("ae1player — AE1 native shell (Phase A)\n"
                    "usage: ae1player <agp-dir> [--seconds N]\n");
        return 2;
    }
    std::string dir = argv[1];
    double runSeconds = 0.0;
    std::string glbName;   // empty => draw the whole entry scene; a .glb arg => that one mesh
    std::string animName;  // --anim <name> to play a clip on the single glb
    for (int i = 2; i < argc; i++) {
        std::string a = argv[i];
        if (a == "--seconds" && i + 1 < argc) runSeconds = atof(argv[++i]);
        else if (a == "--anim" && i + 1 < argc) animName = argv[++i];
        else if (a.size() > 4 && a.substr(a.size() - 4) == ".glb") glbName = a;
    }
    std::string err;

    // ---- load the package ----
    AgpManifest man;
    if (!AgpManifest::load(dir + "\\manifest.json", man, err)) {
        std::printf("ERROR loading manifest: %s\n", err.c_str()); return 1;
    }
    Aepack pack;
    if (!pack.open(dir + "\\" + man.payloadFile, err)) {
        std::printf("ERROR mapping payload: %s\n", err.c_str()); return 1;
    }
    std::printf("Loaded '%s'  (%zu assets mapped, entry scene %s)\n",
                man.title.c_str(), pack.entries().size(), man.entryScene.c_str());

    // ---- window (Platform) + renderer (Gfx) ----
    Platform plat;
    std::string title = man.title + "  —  AE1 native shell";
    if (!plat.create(title, 1280, 720, err)) {
        std::printf("ERROR creating window: %s\n", err.c_str()); return 1;
    }
    Gfx gfx;
    if (!gfx.init(plat.nativeHandle(), plat.width(), plat.height(), err)) {
        std::printf("ERROR creating renderer: %s\n", err.c_str()); return 1;
    }

    std::vector<MeshHandle> meshes;
    std::vector<TexHandle>  texes;   // parallel to meshes; {} = white
    std::vector<float>      meshCutoffs;   // parallel to meshes; alpha-test threshold
    std::vector<CpuMesh> allCpu;     // kept for bounds
    std::map<std::string, TexHandle> texCache;   // dedup identical base-color images
    int transcoded = 0, texFail = 0;
    Vec3 center = { 0, 0, 0 };
    float radius = 1.0f;
    bool spinModel = false;
    GlbRig* rig = nullptr;           // single-glb animation
    int rigAnim = -1;

    auto uploadAndKeep = [&](std::vector<CpuMesh>& cpu, bool dynamic) {
        for (auto& m : cpu) {
            meshes.push_back(gfx.createMesh(m.verts.data(), m.verts.size(),
                                            m.indices.data(), m.indices.size(), dynamic));
            TexHandle th{};
            if (!m.baseColorBytes.empty()) {
                std::string key = std::to_string(m.baseColorBytes.size()) + (m.baseColorKTX2 ? "k" : "p");
                for (size_t k = 0; k < m.baseColorBytes.size(); k += 4099)
                    key.push_back((char)m.baseColorBytes[k]);
                auto it = texCache.find(key);
                if (it != texCache.end()) th = it->second;
                else {
                    Image img; std::string e2;
                    bool ok = m.baseColorKTX2 ? transcodeKTX2(m.baseColorBytes.data(), m.baseColorBytes.size(), img, e2)
                                              : decodeImage(m.baseColorBytes.data(), m.baseColorBytes.size(), img, e2);
                    if (ok) { th = gfx.createTexture(img.rgba.data(), img.w, img.h); transcoded++; }
                    else texFail++;
                    texCache[key] = th;
                }
            }
            texes.push_back(th);
            meshCutoffs.push_back(m.alphaCutoff);
            allCpu.push_back(std::move(m));
        }
    };

    if (!glbName.empty()) {
        // single-mesh mode: draw one glb in its own space (posable if it has anims)
        const AepackEntry* ge = pack.find(glbName);
        std::vector<CpuMesh> cpu; std::string e2;
        GlbRig* r = ge ? loadGlbRig(pack.data(*ge), (size_t)ge->length, cpu, e2) : nullptr;
        if (r) {
            bool anim = rigAnimCount(r) > 0;
            if (anim) {
                rigAnim = animName.empty() ? 0 : rigFindAnim(r, animName);
                if (rigAnim < 0) rigAnim = 0;
                rig = r;
            } else { freeGlbRig(r); }
            uploadAndKeep(cpu, anim);   // dynamic meshes only when animated
            if (anim) std::printf("Playing '%s' on %s  (%d clips, %.2fs). Available: ",
                                  rigAnimName(rig, rigAnim).c_str(), glbName.c_str(),
                                  rigAnimCount(rig), rigAnimDuration(rig, rigAnim));
            else std::printf("Rendering %s: %zu primitives (no animation).\n", glbName.c_str(), allCpu.size());
            if (anim) { for (int i = 0; i < rigAnimCount(rig); i++) std::printf("%s%s", i?", ":"", rigAnimName(rig,i).c_str()); std::printf("\n"); }
        } else {
            std::printf("Note: %s not drawn (%s). Showing a cube.\n",
                        glbName.c_str(), ge ? e2.c_str() : "not in pack");
            std::vector<Vertex> cv; std::vector<uint32_t> ci; buildCube(cv, ci);
            meshes.push_back(gfx.createMesh(cv.data(), cv.size(), ci.data(), ci.size()));
            texes.push_back({}); meshCutoffs.push_back(0.0f);
            spinModel = true;
        }
    } else {
        // scene mode: draw every visible element that has a model, at its transform
        std::string dataTxt;
        if (!readFile(dir + "\\data.json", dataTxt, err)) { std::printf("ERROR: %s\n", err.c_str()); return 1; }
        Json data;
        try { data = Json::parse(dataTxt); }
        catch (const std::exception& ex) { std::printf("ERROR data.json: %s\n", ex.what()); return 1; }
        const Json& scene = data["scenes"][man.entryScene];
        const Json& els = scene["elements"];

        // memoized element world matrix (composing parents)
        std::map<std::string, Mat16> worldCache;
        std::function<Mat16(const std::string&)> worldOf = [&](const std::string& id) -> Mat16 {
            auto it = worldCache.find(id);
            if (it != worldCache.end()) return it->second;
            const Json& el = els[id];
            Mat16 local = elemLocalMatrix(el);
            Mat16 w = local;
            if (el["parent"].isString()) w = matmulCM(worldOf(el["parent"].asString()), local);
            worldCache[id] = w;
            return w;
        };

        int drawn = 0, skipped = 0; size_t totalTris = 0;
        Vec3 pLo{0,0,0}, pHi{0,0,0}; bool havePos = false;
        for (const auto& kv : els.obj()) {
            const Json& el = kv.second;
            if (!el["visible"].boolean(true)) continue;
            const Json& model = el["components"]["model"];
            std::string media = model["media"].str();
            if (media.empty()) continue;
            const AepackEntry* ge = pack.find(media);
            if (!ge) { skipped++; continue; }
            Mat16 w = worldOf(kv.first);
            std::vector<CpuMesh> cpu;
            std::string e2;
            if (loadGlbMeshes(pack.data(*ge), (size_t)ge->length, cpu, e2, w.data())) {
                for (auto& m : cpu) totalTris += m.indices.size() / 3;
                uploadAndKeep(cpu, false);
                drawn++;
                // frame on element POSITIONS (render space = world with Z flipped),
                // not mesh extents — the ground plane is huge and would dominate.
                Vec3 p = { (float)w[12], (float)w[13], -(float)w[14] };
                if (!havePos) { pLo = pHi = p; havePos = true; }
                pLo.x = p.x<pLo.x?p.x:pLo.x; pLo.y=p.y<pLo.y?p.y:pLo.y; pLo.z=p.z<pLo.z?p.z:pLo.z;
                pHi.x = p.x>pHi.x?p.x:pHi.x; pHi.y=p.y>pHi.y?p.y:pHi.y; pHi.z=p.z>pHi.z?p.z:pHi.z;
            } else { skipped++; }
        }
        std::printf("Scene '%s': drew %d model elements (%zu tris), %d skipped.\n",
                    scene["name"].str(man.entryScene).c_str(), drawn, totalTris, skipped);
        if (havePos) {
            center = { (pLo.x+pHi.x)*0.5f, (pLo.y+pHi.y)*0.5f + 0.8f, (pLo.z+pHi.z)*0.5f };
            Vec3 d = pHi - pLo;
            radius = 0.5f * std::sqrt(d.x*d.x + d.y*d.y + d.z*d.z) + 4.0f;  // margin for mesh size
        } else { center = {0,0.8f,0}; radius = 5.0f; }
    }

    if (glbName.empty() == false) {
        // single-mesh mode: frame to the mesh extents
        if (!allCpu.empty()) {
            Vec3 lo, hi; meshBounds(allCpu, lo, hi);
            center = { (lo.x+hi.x)*0.5f, (lo.y+hi.y)*0.5f, (lo.z+hi.z)*0.5f };
            Vec3 d = hi - lo;
            radius = 0.5f * std::sqrt(d.x*d.x + d.y*d.y + d.z*d.z);
            if (radius < 1e-3f) radius = 1.0f;
        } else if (spinModel) { radius = 0.87f; }
    }

    if (transcoded || texFail)
        std::printf("Textures: %d KTX2 base-color maps transcoded to RGBA%s.\n",
                    transcoded, texFail ? " (some failed/skipped)" : "");

    std::printf("Renderer up (D3D11 behind the gfx seam). Drag/scroll to look, "
                "Space pauses, Esc quits.\n");

    const double kStep = 1.0 / 60.0;
    double last = plat.now(), accum = 0.0;
    double spin = 0.6, dist = radius * 1.9, pitch = 0.62;
    bool paused = false;
    double fpsTimer = 0.0; int fpsFrames = 0; long long totalFrames = 0;

    FrameInput in;
    while (plat.pump(in)) {
        if (in.down[Key::Escape]) break;
        if (runSeconds > 0.0 && plat.now() >= runSeconds) break;
        if (in.resized) gfx.resize(plat.width(), plat.height());

        double t = plat.now();
        double dt = t - last; last = t;
        if (dt > 0.25) dt = 0.25;
        accum += dt;

        if (in.pressed[Key::Space]) paused = !paused;
        if (in.mouseDown[0]) { spin += in.mouseDX * 0.01; pitch += in.mouseDY * 0.01; }
        dist -= in.wheel * radius * 0.2;
        if (dist < radius * 1.2) dist = radius * 1.2;
        if (dist > radius * 10.0) dist = radius * 10.0;
        if (pitch < -1.4) pitch = -1.4;
        if (pitch > 1.4)  pitch = 1.4;

        while (accum >= kStep) { if (!paused) spin += 0.5 * kStep; accum -= kStep; }

        // camera orbits the model center
        Vec3 eye = { center.x + (float)(std::cos(spin) * std::cos(pitch) * dist),
                     center.y + (float)(std::sin(pitch) * dist),
                     center.z + (float)(std::sin(spin) * std::cos(pitch) * dist) };
        Mat4 view = lookAtLH(eye, center, { 0, 1, 0 });
        float aspect = plat.height() ? (float)plat.width() / plat.height() : 1.7778f;
        float farZ = radius * 40.0f + 10.0f;
        Mat4 proj = perspectiveFovLH(1.05f, aspect, radius * 0.02f + 0.02f, farZ);

        Mat4 model = spinModel ? rotationY((float)spin) : identity();
        if (rig) {   // re-pose + re-skin the animated single glb
            poseRig(rig, rigAnim, (float)plat.now(), allCpu);
            for (size_t i = 0; i < meshes.size() && i < allCpu.size(); i++)
                gfx.updateMesh(meshes[i], allCpu[i].verts.data(), allCpu[i].verts.size());
        }
        gfx.beginFrame(0.10f, 0.11f, 0.13f);
        gfx.setViewProj(view, proj);
        for (size_t i = 0; i < meshes.size(); i++)
            gfx.drawMesh(meshes[i], model, texes[i], i < meshCutoffs.size() ? meshCutoffs[i] : 0.0f);
        gfx.endFrame();

        totalFrames++; fpsFrames++; fpsTimer += dt;
        if (fpsTimer >= 0.25) {
            char buf[256];
            std::snprintf(buf, sizeof buf,
                "%s  —  AE1 native shell   |   %.0f fps   frame %lld   %zu assets%s",
                man.title.c_str(), fpsFrames / fpsTimer, totalFrames,
                pack.entries().size(), paused ? "   [paused]" : "");
            plat.setTitle(buf);
            fpsTimer = 0.0; fpsFrames = 0;
        }
    }

    if (rig) freeGlbRig(rig);
    gfx.shutdown();
    std::printf("Shell exited cleanly after %lld frames.\n", totalFrames);
    return 0;
}
