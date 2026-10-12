// gltf.cpp — GLB mesh loader. See gltf.hpp.
//
// Handles plain glTF 2.0, the pack's compressed meshes (EXT_meshopt_compression
// + KHR_mesh_quantization), AND skinning at bind pose. Static meshes bake their
// node's world transform; skinned meshes ignore the node transform (per spec)
// and place each vertex by its joint matrices — worldTransform(joint) *
// inverseBindMatrix — which also absorbs gltfpack's quantization dequant.
#include "gltf.hpp"
#include "json.hpp"
#include "meshoptimizer.h"

#include <cstring>
#include <cmath>
#include <array>

namespace ae1 {

// ---- glTF-native matrix math (column-major, column-vector, right-handed) ----
namespace {

struct GMat { double m[16]; };
GMat gident() { GMat r{}; r.m[0] = r.m[5] = r.m[10] = r.m[15] = 1.0; return r; }
GMat gmul(const GMat& a, const GMat& b) {
    GMat c{};
    for (int col = 0; col < 4; col++)
        for (int row = 0; row < 4; row++) {
            double s = 0;
            for (int k = 0; k < 4; k++) s += a.m[k * 4 + row] * b.m[col * 4 + k];
            c.m[col * 4 + row] = s;
        }
    return c;
}
GMat gFromArray(const Json& arr) {
    GMat r{}; for (int i = 0; i < 16; i++) r.m[i] = arr[(size_t)i].num(); return r;
}
GMat gTRS(const Json& t, const Json& q, const Json& s) {
    double tx=0,ty=0,tz=0, qx=0,qy=0,qz=0,qw=1, sx=1,sy=1,sz=1;
    if (t.isArray()) { tx=t[0].num(); ty=t[1].num(); tz=t[2].num(); }
    if (q.isArray()) { qx=q[0].num(); qy=q[1].num(); qz=q[2].num(); qw=q[3].num(); }
    if (s.isArray()) { sx=s[0].num(); sy=s[1].num(); sz=s[2].num(); }
    double r00=1-2*(qy*qy+qz*qz), r01=2*(qx*qy-qw*qz), r02=2*(qx*qz+qw*qy);
    double r10=2*(qx*qy+qw*qz), r11=1-2*(qx*qx+qz*qz), r12=2*(qy*qz-qw*qx);
    double r20=2*(qx*qz-qw*qy), r21=2*(qy*qz+qw*qx), r22=1-2*(qx*qx+qy*qy);
    GMat m{};
    m.m[0]=r00*sx; m.m[1]=r10*sx; m.m[2]=r20*sx; m.m[3]=0;
    m.m[4]=r01*sy; m.m[5]=r11*sy; m.m[6]=r21*sy; m.m[7]=0;
    m.m[8]=r02*sz; m.m[9]=r12*sz; m.m[10]=r22*sz; m.m[11]=0;
    m.m[12]=tx; m.m[13]=ty; m.m[14]=tz; m.m[15]=1;
    return m;
}
Vec3 gPoint(const GMat& m, Vec3 p) {
    return { (float)(m.m[0]*p.x+m.m[4]*p.y+m.m[8]*p.z +m.m[12]),
             (float)(m.m[1]*p.x+m.m[5]*p.y+m.m[9]*p.z +m.m[13]),
             (float)(m.m[2]*p.x+m.m[6]*p.y+m.m[10]*p.z+m.m[14]) };
}
Vec3 gDir(const GMat& m, Vec3 n) {
    return { (float)(m.m[0]*n.x+m.m[4]*n.y+m.m[8]*n.z),
             (float)(m.m[1]*n.x+m.m[5]*n.y+m.m[9]*n.z),
             (float)(m.m[2]*n.x+m.m[6]*n.y+m.m[10]*n.z) };
}

int compSize(int ct) {
    switch (ct) { case 5120: case 5121: return 1; case 5122: case 5123: return 2;
                  case 5125: case 5126: return 4; default: return 0; }
}
int numComps(const std::string& t) {
    if (t=="SCALAR") return 1; if (t=="VEC2") return 2; if (t=="VEC3") return 3;
    if (t=="VEC4") return 4; if (t=="MAT4") return 16; return 0;
}
float readCompN(const uint8_t* p, int ct, bool norm) {
    switch (ct) {
        case 5126: { float f; std::memcpy(&f, p, 4); return f; }
        case 5125: { uint32_t v; std::memcpy(&v, p, 4); return norm ? (float)v / 4294967295.0f : (float)v; }
        case 5123: { uint16_t v; std::memcpy(&v, p, 2); return norm ? (float)v / 65535.0f : (float)v; }
        case 5122: { int16_t v;  std::memcpy(&v, p, 2); return norm ? std::fmax((float)v / 32767.0f, -1.0f) : (float)v; }
        case 5121: return norm ? (float)p[0] / 255.0f : (float)p[0];
        case 5120: { int8_t v = (int8_t)p[0]; return norm ? std::fmax((float)v / 127.0f, -1.0f) : (float)v; }
        default: return 0.0f;
    }
}

struct DecodedBV { std::vector<uint8_t> bytes; size_t stride = 0; bool present = false; };
struct Accessor {
    const uint8_t* base = nullptr;
    size_t stride = 0, count = 0;
    int compType = 0;
    std::string type;
    bool normalized = false;
    int compSz = 0, nComp = 0;
};

} // namespace

static bool decodeMeshopt(const Json& doc, const uint8_t* bin, size_t binLen,
                          std::vector<DecodedBV>& dec, std::string& err) {
    const Json& bvs = doc["bufferViews"];
    dec.assign(bvs.size(), DecodedBV{});
    for (size_t i = 0; i < bvs.size(); i++) {
        const Json& bv = bvs[i];
        if (!(bv.has("extensions") && bv["extensions"].has("EXT_meshopt_compression"))) continue;
        const Json& e = bv["extensions"]["EXT_meshopt_compression"];
        size_t off = (size_t)e["byteOffset"].num(), blen = (size_t)e["byteLength"].num();
        size_t stride = (size_t)e["byteStride"].num(), count = (size_t)e["count"].num();
        std::string mode = e["mode"].str();
        std::string filter = e.has("filter") ? e["filter"].str() : "NONE";
        if (off + blen > binLen) { err = "meshopt source past BIN chunk"; return false; }
        std::vector<uint8_t> dst(count * stride);
        const unsigned char* src = bin + off;
        int rc = -1;
        if (mode == "ATTRIBUTES") {
            rc = meshopt_decodeVertexBuffer(dst.data(), count, stride, src, blen);
            if (rc == 0) {
                if (filter == "OCTAHEDRAL")       meshopt_decodeFilterOct(dst.data(), count, stride);
                else if (filter == "QUATERNION")  meshopt_decodeFilterQuat(dst.data(), count, stride);
                else if (filter == "EXPONENTIAL") meshopt_decodeFilterExp(dst.data(), count, stride);
            }
        } else if (mode == "TRIANGLES") {
            rc = meshopt_decodeIndexBuffer(dst.data(), count, stride, src, blen);
        } else if (mode == "INDICES") {
            rc = meshopt_decodeIndexSequence(dst.data(), count, stride, src, blen);
        } else { err = "unknown meshopt mode: " + mode; return false; }
        if (rc != 0) { err = "meshopt decode failed (mode " + mode + ")"; return false; }
        dec[i].bytes = std::move(dst); dec[i].stride = stride; dec[i].present = true;
    }
    return true;
}

static bool resolveAccessor(const Json& doc, const uint8_t* bin, size_t binLen,
                            const std::vector<DecodedBV>& dec,
                            int accIndex, Accessor& out, std::string& err) {
    const Json& acc = doc["accessors"][(size_t)accIndex];
    if (!acc.has("bufferView")) { err = "accessor without bufferView (sparse?)"; return false; }
    int bvIndex = (int)acc["bufferView"].num();
    const Json& bv = doc["bufferViews"][(size_t)bvIndex];
    out.compType = (int)acc["componentType"].num();
    out.type = acc["type"].str();
    out.count = (size_t)acc["count"].num();
    out.normalized = acc.has("normalized") && acc["normalized"].boolean();
    out.compSz = compSize(out.compType); out.nComp = numComps(out.type);
    if (out.compSz == 0 || out.nComp == 0) { err = "unsupported accessor component/type"; return false; }
    size_t accOff = acc.has("byteOffset") ? (size_t)acc["byteOffset"].num() : 0;

    if (bvIndex >= 0 && (size_t)bvIndex < dec.size() && dec[bvIndex].present) {
        const DecodedBV& d = dec[bvIndex];
        out.stride = d.stride ? d.stride : (size_t)(out.compSz * out.nComp);
        size_t need = out.count ? (out.count - 1) * out.stride + out.compSz * out.nComp : 0;
        if (accOff + need > d.bytes.size()) { err = "accessor past decoded bufferView"; return false; }
        out.base = d.bytes.data() + accOff;
    } else {
        size_t bvOff = bv.has("byteOffset") ? (size_t)bv["byteOffset"].num() : 0;
        out.stride = bv.has("byteStride") && bv["byteStride"].num() > 0
            ? (size_t)bv["byteStride"].num() : (size_t)(out.compSz * out.nComp);
        size_t start = bvOff + accOff;
        size_t need = out.count ? (out.count - 1) * out.stride + out.compSz * out.nComp : 0;
        if (start + need > binLen) { err = "accessor extends past BIN chunk"; return false; }
        out.base = bin + start;
    }
    return true;
}

// read one component c of element i from a resolved accessor
static inline float accGet(const Accessor& a, size_t i, int c) {
    return readCompN(a.base + i * a.stride + (size_t)c * a.compSz, a.compType, a.normalized);
}

// ---- per-node world transforms (bind pose) ---------------------------------
static void computeWorld(const Json& doc, int nodeIdx, const GMat& parent,
                         std::vector<GMat>& world, std::vector<char>& seen) {
    const Json& node = doc["nodes"][(size_t)nodeIdx];
    GMat local = node.has("matrix") ? gFromArray(node["matrix"])
                                    : gTRS(node["translation"], node["rotation"], node["scale"]);
    GMat w = gmul(parent, local);
    world[nodeIdx] = w; seen[nodeIdx] = 1;
    if (node.has("children")) {
        const Json& kids = node["children"];
        for (size_t k = 0; k < kids.size(); k++)
            computeWorld(doc, (int)kids[k].num(), w, world, seen);
    }
}

static void emitPrimitive(const Json& doc, const uint8_t* bin, size_t binLen,
                          const std::vector<DecodedBV>& dec, const Json& prim,
                          const GMat& nodeWorld, const std::vector<GMat>* jointMats,
                          std::vector<CpuMesh>& out, std::string& err) {
    const Json& attrs = prim["attributes"];
    if (!attrs.has("POSITION")) return;
    Accessor pos, nrm, joints, weights;
    if (!resolveAccessor(doc, bin, binLen, dec, (int)attrs["POSITION"].num(), pos, err)) return;
    bool hasN = attrs.has("NORMAL") &&
        resolveAccessor(doc, bin, binLen, dec, (int)attrs["NORMAL"].num(), nrm, err);
    if (!err.empty()) return;
    bool skinned = jointMats && attrs.has("JOINTS_0") && attrs.has("WEIGHTS_0");
    if (skinned) {
        if (!resolveAccessor(doc, bin, binLen, dec, (int)attrs["JOINTS_0"].num(), joints, err)) return;
        if (!resolveAccessor(doc, bin, binLen, dec, (int)attrs["WEIGHTS_0"].num(), weights, err)) return;
    }

    // UVs + base-color texture (KHR_texture_basisu source, KHR_texture_transform).
    Accessor uv; bool hasUV = false;
    int imgIdx = -1; bool imgKTX2 = false;
    double uo0 = 0, uo1 = 0, us0 = 1, us1 = 1;
    float cutoff = 0.0f;
    float metF = 0.0f, roughF = 0.7f;   // pbrMetallicRoughness factors (dielectric default)
    if (attrs.has("TEXCOORD_0")) {
        hasUV = resolveAccessor(doc, bin, binLen, dec, (int)attrs["TEXCOORD_0"].num(), uv, err);
        if (!err.empty()) return;
    }
    if (prim.has("material")) {
        const Json& mat = doc["materials"][(size_t)prim["material"].num()];
        const Json& bct = mat["pbrMetallicRoughness"]["baseColorTexture"];
        if (bct.isObject() && bct.has("index")) {
            const Json& tex = doc["textures"][(size_t)bct["index"].num()];
            if (tex.has("extensions") && tex["extensions"].has("KHR_texture_basisu")) {
                imgIdx = (int)tex["extensions"]["KHR_texture_basisu"]["source"].num(); imgKTX2 = true;
            } else if (tex.has("source")) { imgIdx = (int)tex["source"].num(); imgKTX2 = false; }
            if (bct.has("extensions") && bct["extensions"].has("KHR_texture_transform")) {
                const Json& tt = bct["extensions"]["KHR_texture_transform"];
                if (tt["offset"].isArray()) { uo0 = tt["offset"][0].num(); uo1 = tt["offset"][1].num(); }
                if (tt["scale"].isArray())  { us0 = tt["scale"][0].num(1.0); us1 = tt["scale"][1].num(1.0); }
            }
        }
        const Json& mr = mat["pbrMetallicRoughness"];
        if (mr.has("metallicFactor"))  metF   = (float)mr["metallicFactor"].num(1.0);
        if (mr.has("roughnessFactor")) roughF = (float)mr["roughnessFactor"].num(1.0);
        std::string am = mat["alphaMode"].str("OPAQUE");
        if (am == "MASK") cutoff = (float)mat["alphaCutoff"].num(0.5);
        else if (am == "BLEND") cutoff = 0.10f;   // no depth sort yet; low cutoff keeps soft alpha
    }
    bool textured = (imgIdx >= 0);

    CpuMesh cm;
    cm.verts.reserve(pos.count);
    for (size_t i = 0; i < pos.count; i++) {
        Vec3 p = { accGet(pos, i, 0), accGet(pos, i, 1), accGet(pos, i, 2) };
        Vec3 n = hasN ? Vec3{ accGet(nrm, i, 0), accGet(nrm, i, 1), accGet(nrm, i, 2) } : Vec3{ 0,1,0 };

        Vec3 wp, wn;
        if (skinned) {
            // skinnedPos = Σ w_k * jointMat[joint_k] * pos  (node transform ignored)
            double ax=0,ay=0,az=0, bx=0,by=0,bz=0, wsum=0;
            for (int k = 0; k < 4; k++) {
                float w = accGet(weights, i, k);
                if (w == 0) continue;
                int ji = (int)(accGet(joints, i, k) + 0.5f);
                if (ji < 0 || (size_t)ji >= jointMats->size()) continue;
                const GMat& jm = (*jointMats)[ji];
                Vec3 tp = gPoint(jm, p), tn = gDir(jm, n);
                ax += w*tp.x; ay += w*tp.y; az += w*tp.z;
                bx += w*tn.x; by += w*tn.y; bz += w*tn.z;
                wsum += w;
            }
            if (wsum <= 0) { wp = gPoint(nodeWorld, p); wn = gDir(nodeWorld, n); }
            else { wp = { (float)ax,(float)ay,(float)az }; wn = { (float)bx,(float)by,(float)bz }; }
        } else {
            wp = gPoint(nodeWorld, p);
            wn = gDir(nodeWorld, n);
        }

        Vertex v;
        v.px = wp.x; v.py = wp.y; v.pz = -wp.z;   // RH -> LH
        float nl = std::sqrt(wn.x*wn.x + wn.y*wn.y + wn.z*wn.z); if (nl < 1e-6f) nl = 1;
        v.nx = wn.x/nl; v.ny = wn.y/nl; v.nz = -wn.z/nl;
        float tu = 0, tv = 0;
        if (hasUV) { tu = accGet(uv, i, 0); tv = accGet(uv, i, 1); }
        v.u = (float)(tu * us0 + uo0);
        v.v = (float)(tv * us1 + uo1);
        if (textured) { v.r = v.g = v.b = 1.0f; }        // texture provides color
        else          { v.r = 0.80f; v.g = 0.80f; v.b = 0.82f; }
        cm.verts.push_back(v);
    }

    if (prim.has("indices")) {
        Accessor idx;
        if (!resolveAccessor(doc, bin, binLen, dec, (int)prim["indices"].num(), idx, err)) return;
        cm.indices.reserve(idx.count);
        for (size_t i = 0; i < idx.count; i++)
            cm.indices.push_back((uint32_t)readCompN(idx.base + i * idx.stride, idx.compType, false));
        for (size_t i = 0; i + 2 < cm.indices.size(); i += 3)
            std::swap(cm.indices[i + 1], cm.indices[i + 2]);   // Z flip reverses winding
    } else {
        for (uint32_t i = 0; i < (uint32_t)cm.verts.size(); i++) cm.indices.push_back(i);
    }

    // lift the base-color image bytes out of the glb for the caller to decode
    if (textured) {
        const Json& img = doc["images"][(size_t)imgIdx];
        if (img.has("bufferView")) {
            const Json& bv = doc["bufferViews"][(size_t)img["bufferView"].num()];
            size_t o = bv.has("byteOffset") ? (size_t)bv["byteOffset"].num() : 0;
            size_t l = (size_t)bv["byteLength"].num();
            if (o + l <= binLen) {
                cm.baseColorBytes.assign(bin + o, bin + o + l);
                cm.baseColorKTX2 = imgKTX2;
            }
        }
    }
    cm.alphaCutoff = cutoff;
    cm.metallic = metF; cm.roughness = roughF;
    out.push_back(std::move(cm));
}

bool loadGlbMeshes(const uint8_t* glb, size_t len,
                   std::vector<CpuMesh>& out, std::string& err,
                   const double* rootColMajor) {
    if (len < 20) { err = "GLB too small"; return false; }
    uint32_t magic, ver, total;
    std::memcpy(&magic, glb + 0, 4); std::memcpy(&ver, glb + 4, 4); std::memcpy(&total, glb + 8, 4);
    if (magic != 0x46546C67u) { err = "not a GLB (bad magic)"; return false; }

    uint32_t c0len, c0type;
    std::memcpy(&c0len, glb + 12, 4); std::memcpy(&c0type, glb + 16, 4);
    if (c0type != 0x4E4F534Au) { err = "first chunk is not JSON"; return false; }
    if (20 + c0len > len) { err = "JSON chunk past end"; return false; }
    std::string jsonTxt((const char*)(glb + 20), c0len);

    const uint8_t* bin = nullptr; size_t binLen = 0;
    size_t off = 20 + c0len;
    if (off + 8 <= len) {
        uint32_t c1len, c1type;
        std::memcpy(&c1len, glb + off, 4); std::memcpy(&c1type, glb + off + 4, 4);
        if (c1type == 0x004E4942u) { bin = glb + off + 8; binLen = c1len; }
    }
    if (!bin) { err = "no BIN chunk"; return false; }

    Json doc;
    try { doc = Json::parse(jsonTxt); }
    catch (const std::exception& ex) { err = std::string("glTF JSON: ") + ex.what(); return false; }

    std::vector<DecodedBV> dec;
    if (!decodeMeshopt(doc, bin, binLen, dec, err)) return false;

    const Json& nodes = doc["nodes"];
    size_t nnodes = nodes.size();
    std::vector<GMat> world(nnodes, gident());
    std::vector<char> seen(nnodes, 0);
    int sceneIdx = doc.has("scene") ? (int)doc["scene"].num() : 0;
    const Json& scenes = doc["scenes"];
    if (!scenes.isArray() || scenes.size() == 0) { err = "no scenes"; return false; }
    GMat rootM = gident();
    if (rootColMajor) for (int i = 0; i < 16; i++) rootM.m[i] = rootColMajor[i];
    const Json& roots = scenes[(size_t)sceneIdx]["nodes"];
    for (size_t i = 0; i < roots.size(); i++)
        computeWorld(doc, (int)roots[i].num(), rootM, world, seen);

    // precompute joint matrices for each skin: worldTransform(joint) * IBM[joint]
    std::vector<std::vector<GMat>> skinJoints;
    if (doc.has("skins")) {
        const Json& skins = doc["skins"];
        skinJoints.resize(skins.size());
        for (size_t s = 0; s < skins.size(); s++) {
            const Json& skin = skins[s];
            const Json& js = skin["joints"];
            std::vector<GMat> ibm(js.size(), gident());
            if (skin.has("inverseBindMatrices")) {
                Accessor a;
                if (resolveAccessor(doc, bin, binLen, dec, (int)skin["inverseBindMatrices"].num(), a, err)) {
                    for (size_t j = 0; j < js.size() && j < a.count; j++)
                        for (int e = 0; e < 16; e++) ibm[j].m[e] = accGet(a, j, e);
                } else err.clear();  // fall back to identity IBMs
            }
            std::vector<GMat> jm(js.size(), gident());
            for (size_t j = 0; j < js.size(); j++) {
                int jn = (int)js[j].num();
                GMat jw = (jn >= 0 && (size_t)jn < nnodes) ? world[jn] : gident();
                jm[j] = gmul(jw, ibm[j]);
            }
            skinJoints[s] = std::move(jm);
        }
    }

    for (size_t ni = 0; ni < nnodes; ni++) {
        const Json& node = nodes[ni];
        if (!node.has("mesh")) continue;
        const Json& prims = doc["meshes"][(size_t)node["mesh"].num()]["primitives"];
        const std::vector<GMat>* jm = nullptr;
        if (node.has("skin")) {
            int si = (int)node["skin"].num();
            if (si >= 0 && (size_t)si < skinJoints.size()) jm = &skinJoints[si];
        }
        for (size_t pi = 0; pi < prims.size(); pi++) {
            emitPrimitive(doc, bin, binLen, dec, prims[pi], world[ni], jm, out, err);
            if (!err.empty()) return false;
        }
    }
    if (out.empty()) { err = "no drawable mesh primitives found"; return false; }
    return true;
}

// ============================================================================
//  Animation: a posable rig (glTF TRS-channel animation + CPU skinning).
// ============================================================================
namespace {

GMat gTRSv(const double T[3], const double R[4], const double S[3]) {
    double qx=R[0],qy=R[1],qz=R[2],qw=R[3], sx=S[0],sy=S[1],sz=S[2];
    double r00=1-2*(qy*qy+qz*qz), r01=2*(qx*qy-qw*qz), r02=2*(qx*qz+qw*qy);
    double r10=2*(qx*qy+qw*qz), r11=1-2*(qx*qx+qz*qz), r12=2*(qy*qz-qw*qx);
    double r20=2*(qx*qz-qw*qy), r21=2*(qy*qz+qw*qx), r22=1-2*(qx*qx+qy*qy);
    GMat m{};
    m.m[0]=r00*sx; m.m[1]=r10*sx; m.m[2]=r20*sx; m.m[3]=0;
    m.m[4]=r01*sy; m.m[5]=r11*sy; m.m[6]=r21*sy; m.m[7]=0;
    m.m[8]=r02*sz; m.m[9]=r12*sz; m.m[10]=r22*sz; m.m[11]=0;
    m.m[12]=T[0]; m.m[13]=T[1]; m.m[14]=T[2]; m.m[15]=1;
    return m;
}

struct RigNode {
    bool hasMatrix = false; GMat matrix;
    double T[3] = {0,0,0}, R[4] = {0,0,0,1}, S[3] = {1,1,1};   // baseline TRS
    std::vector<int> children;
    int parent = -1;
    std::string name;
};
struct RigSkin { std::vector<int> joints; std::vector<GMat> ibm; };
struct RigPrim {
    int node = -1, skin = -1;
    std::vector<Vec3> pos, nrm;          // glb-local bind data
    std::vector<int>  ji;                // 4 per vertex (skinned)
    std::vector<float> jw;               // 4 per vertex
};
struct RigSampler { std::vector<float> input; std::vector<float> output; int ncomp = 0; int interp = 0; }; // 0 LINEAR,1 STEP,2 CUBIC
struct RigChannel { int node = -1, path = 0, sampler = -1; };   // path 0=T,1=R,2=S
struct RigAnim { std::string name; float duration = 0; std::vector<RigChannel> ch; std::vector<RigSampler> samp; };

} // namespace

struct GlbRig {
    std::vector<RigNode> nodes;
    std::vector<int>     roots;
    std::vector<RigSkin> skins;
    std::vector<RigPrim> prims;
    std::vector<RigAnim> anims;
};

static void decodeFloats(const Json& doc, const uint8_t* bin, size_t binLen,
                         const std::vector<DecodedBV>& dec, int accIndex,
                         std::vector<float>& out, int& ncomp) {
    Accessor a; std::string e;
    if (!resolveAccessor(doc, bin, binLen, dec, accIndex, a, e)) { ncomp = 0; return; }
    ncomp = a.nComp;
    out.resize(a.count * a.nComp);
    for (size_t i = 0; i < a.count; i++)
        for (int c = 0; c < a.nComp; c++) out[i * a.nComp + c] = accGet(a, i, c);
}

static void computeRigWorld(const GlbRig* rig, const std::vector<std::array<double,10>>& trs,
                            int node, const GMat& parent, std::vector<GMat>& world) {
    const RigNode& n = rig->nodes[node];
    GMat local;
    if (n.hasMatrix) local = n.matrix;
    else { const auto& v = trs[node]; double T[3]={v[0],v[1],v[2]}, R[4]={v[3],v[4],v[5],v[6]}, S[3]={v[7],v[8],v[9]}; local = gTRSv(T,R,S); }
    GMat w = gmul(parent, local);
    world[node] = w;
    for (int c : n.children) computeRigWorld(rig, trs, c, w, world);
}

// skin/place one primitive into an existing vertex list (pos/nrm only)
static void skinPrimInto(const RigPrim& pr, const std::vector<GMat>& world,
                         const std::vector<GMat>* jointMats, std::vector<Vertex>& verts) {
    size_t n = pr.pos.size();
    const GMat& nodeW = world[pr.node];
    for (size_t i = 0; i < n; i++) {
        Vec3 p = pr.pos[i], nn = pr.nrm[i], wp, wn;
        if (pr.skin >= 0 && jointMats) {
            double ax=0,ay=0,az=0,bx=0,by=0,bz=0,wsum=0;
            for (int k = 0; k < 4; k++) {
                float w = pr.jw[i*4+k]; if (w == 0) continue;
                int ji = pr.ji[i*4+k];
                if (ji < 0 || (size_t)ji >= jointMats->size()) continue;
                const GMat& jm = (*jointMats)[ji];
                Vec3 tp = gPoint(jm, p), tn = gDir(jm, nn);
                ax+=w*tp.x; ay+=w*tp.y; az+=w*tp.z; bx+=w*tn.x; by+=w*tn.y; bz+=w*tn.z; wsum+=w;
            }
            if (wsum <= 0) { wp = gPoint(nodeW, p); wn = gDir(nodeW, nn); }
            else { wp = {(float)ax,(float)ay,(float)az}; wn = {(float)bx,(float)by,(float)bz}; }
        } else { wp = gPoint(nodeW, p); wn = gDir(nodeW, nn); }
        Vertex& v = verts[i];
        v.px = wp.x; v.py = wp.y; v.pz = -wp.z;
        float nl = std::sqrt(wn.x*wn.x+wn.y*wn.y+wn.z*wn.z); if (nl < 1e-6f) nl = 1;
        v.nx = wn.x/nl; v.ny = wn.y/nl; v.nz = -wn.z/nl;
    }
}

GlbRig* loadGlbRig(const uint8_t* glb, size_t len, std::vector<CpuMesh>& outMeshes, std::string& err) {
    if (len < 20) { err = "GLB too small"; return nullptr; }
    uint32_t magic, c0len, c0type;
    std::memcpy(&magic, glb, 4);
    if (magic != 0x46546C67u) { err = "not a GLB"; return nullptr; }
    std::memcpy(&c0len, glb + 12, 4); std::memcpy(&c0type, glb + 16, 4);
    if (c0type != 0x4E4F534Au || 20 + c0len > len) { err = "bad JSON chunk"; return nullptr; }
    std::string jsonTxt((const char*)(glb + 20), c0len);
    const uint8_t* bin = nullptr; size_t binLen = 0; size_t off = 20 + c0len;
    if (off + 8 <= len) { uint32_t l, t; std::memcpy(&l, glb+off,4); std::memcpy(&t, glb+off+4,4); if (t == 0x004E4942u) { bin = glb+off+8; binLen = l; } }
    if (!bin) { err = "no BIN chunk"; return nullptr; }

    Json doc;
    try { doc = Json::parse(jsonTxt); } catch (const std::exception& ex) { err = std::string("glTF JSON: ") + ex.what(); return nullptr; }
    std::vector<DecodedBV> dec;
    if (!decodeMeshopt(doc, bin, binLen, dec, err)) return nullptr;

    GlbRig* rig = new GlbRig();
    const Json& nodes = doc["nodes"];
    rig->nodes.resize(nodes.size());
    for (size_t i = 0; i < nodes.size(); i++) {
        const Json& nd = nodes[i]; RigNode& rn = rig->nodes[i];
        rn.name = nd["name"].str();
        if (nd.has("matrix")) { rn.hasMatrix = true; rn.matrix = gFromArray(nd["matrix"]); }
        else {
            if (nd["translation"].isArray()) for (int k=0;k<3;k++) rn.T[k]=nd["translation"][(size_t)k].num();
            if (nd["rotation"].isArray())    for (int k=0;k<4;k++) rn.R[k]=nd["rotation"][(size_t)k].num();
            if (nd["scale"].isArray())       for (int k=0;k<3;k++) rn.S[k]=nd["scale"][(size_t)k].num(1.0);
        }
        if (nd.has("children")) for (size_t k=0;k<nd["children"].size();k++) rn.children.push_back((int)nd["children"][k].num());
    }
    for (size_t i = 0; i < rig->nodes.size(); i++)
        for (int c : rig->nodes[i].children) if (c >= 0 && (size_t)c < rig->nodes.size()) rig->nodes[c].parent = (int)i;
    int sceneIdx = doc.has("scene") ? (int)doc["scene"].num() : 0;
    const Json& roots = doc["scenes"][(size_t)sceneIdx]["nodes"];
    for (size_t i=0;i<roots.size();i++) rig->roots.push_back((int)roots[i].num());

    if (doc.has("skins")) {
        const Json& skins = doc["skins"];
        rig->skins.resize(skins.size());
        for (size_t s=0;s<skins.size();s++) {
            const Json& sk = skins[s]; RigSkin& rs = rig->skins[s];
            for (size_t j=0;j<sk["joints"].size();j++) rs.joints.push_back((int)sk["joints"][j].num());
            rs.ibm.assign(rs.joints.size(), gident());
            if (sk.has("inverseBindMatrices")) {
                Accessor a; std::string e2;
                if (resolveAccessor(doc,bin,binLen,dec,(int)sk["inverseBindMatrices"].num(),a,e2))
                    for (size_t j=0;j<rs.joints.size() && j<a.count;j++)
                        for (int k=0;k<16;k++) rs.ibm[j].m[k]=accGet(a,j,k);
            }
        }
    }

    // primitives (+ bind-pose CpuMesh, incl. UV/color/indices/baseColor)
    for (size_t ni=0; ni<nodes.size(); ni++) {
        const Json& nd = nodes[ni];
        if (!nd.has("mesh")) continue;
        int skin = nd.has("skin") ? (int)nd["skin"].num() : -1;
        const Json& prims = doc["meshes"][(size_t)nd["mesh"].num()]["primitives"];
        for (size_t pi=0; pi<prims.size(); pi++) {
            const Json& prim = prims[pi];
            const Json& attrs = prim["attributes"];
            if (!attrs.has("POSITION")) continue;
            Accessor pa, na, ua, ja, wa; std::string e2;
            if (!resolveAccessor(doc,bin,binLen,dec,(int)attrs["POSITION"].num(),pa,e2)) { err=e2; freeGlbRig(rig); return nullptr; }
            bool hasN = attrs.has("NORMAL") && resolveAccessor(doc,bin,binLen,dec,(int)attrs["NORMAL"].num(),na,e2);
            bool hasUV = attrs.has("TEXCOORD_0") && resolveAccessor(doc,bin,binLen,dec,(int)attrs["TEXCOORD_0"].num(),ua,e2);
            bool sk = (skin>=0) && attrs.has("JOINTS_0") && attrs.has("WEIGHTS_0")
                      && resolveAccessor(doc,bin,binLen,dec,(int)attrs["JOINTS_0"].num(),ja,e2)
                      && resolveAccessor(doc,bin,binLen,dec,(int)attrs["WEIGHTS_0"].num(),wa,e2);
            // base color (KHR_texture_basisu source)
            int imgIdx=-1; bool imgKTX2=false; double uo0=0,uo1=0,us0=1,us1=1; float cutoff=0.0f; bool blend=false;
            float bcf[3] = { 1,1,1 };   // baseColorFactor (material solid tint)
            float metF = 0.0f, roughF = 0.7f;   // pbrMetallicRoughness factors (dielectric default)
            if (prim.has("material")) {
                const Json& mat = doc["materials"][(size_t)prim["material"].num()];
                const Json& mr = mat["pbrMetallicRoughness"];
                const Json& fac = mr["baseColorFactor"];
                if (fac.isArray()) { bcf[0]=(float)fac[0].num(1.0); bcf[1]=(float)fac[1].num(1.0); bcf[2]=(float)fac[2].num(1.0); }
                if (mr.has("metallicFactor"))  metF   = (float)mr["metallicFactor"].num(1.0);
                if (mr.has("roughnessFactor")) roughF = (float)mr["roughnessFactor"].num(1.0);
                const Json& bct = mat["pbrMetallicRoughness"]["baseColorTexture"];
                if (bct.isObject() && bct.has("index")) {
                    const Json& tex = doc["textures"][(size_t)bct["index"].num()];
                    if (tex.has("extensions") && tex["extensions"].has("KHR_texture_basisu")) { imgIdx=(int)tex["extensions"]["KHR_texture_basisu"]["source"].num(); imgKTX2=true; }
                    else if (tex.has("source")) imgIdx=(int)tex["source"].num();
                    if (bct.has("extensions") && bct["extensions"].has("KHR_texture_transform")) {
                        const Json& tt = bct["extensions"]["KHR_texture_transform"];
                        if (tt["offset"].isArray()){uo0=tt["offset"][0].num();uo1=tt["offset"][1].num();}
                        if (tt["scale"].isArray()){us0=tt["scale"][0].num(1.0);us1=tt["scale"][1].num(1.0);}
                    }
                }
                std::string am = mat["alphaMode"].str("OPAQUE");
                if (am == "MASK") cutoff = (float)mat["alphaCutoff"].num(0.5);
                else if (am == "BLEND") blend = true;
            }
            bool textured = imgIdx>=0;

            RigPrim rp; rp.node=(int)ni; rp.skin=sk?skin:-1;
            CpuMesh cm;
            rp.pos.resize(pa.count); rp.nrm.resize(pa.count);
            cm.verts.resize(pa.count);
            for (size_t v=0; v<pa.count; v++) {
                Vec3 p{accGet(pa,v,0),accGet(pa,v,1),accGet(pa,v,2)};
                Vec3 nrm = hasN ? Vec3{accGet(na,v,0),accGet(na,v,1),accGet(na,v,2)} : Vec3{0,1,0};
                rp.pos[v]=p; rp.nrm[v]=nrm;
                Vertex& vv = cm.verts[v];
                float tu = hasUV?accGet(ua,v,0):0, tv = hasUV?accGet(ua,v,1):0;
                vv.u=(float)(tu*us0+uo0); vv.v=(float)(tv*us1+uo1);
                // baseColor = texture * factor (glTF). Untextured => the factor is
                // the solid material colour (was a hardcoded grey that blew out).
                vv.r=bcf[0]; vv.g=bcf[1]; vv.b=bcf[2];
            }
            if (sk) {
                rp.ji.resize(pa.count*4); rp.jw.resize(pa.count*4);
                for (size_t v=0; v<pa.count; v++) for (int k=0;k<4;k++){ rp.ji[v*4+k]=(int)(accGet(ja,v,k)+0.5f); rp.jw[v*4+k]=accGet(wa,v,k); }
            }
            if (prim.has("indices")) {
                Accessor ia; resolveAccessor(doc,bin,binLen,dec,(int)prim["indices"].num(),ia,e2);
                cm.indices.reserve(ia.count);
                for (size_t i=0;i<ia.count;i++) cm.indices.push_back((uint32_t)readCompN(ia.base+i*ia.stride, ia.compType, false));
                for (size_t i=0;i+2<cm.indices.size();i+=3) std::swap(cm.indices[i+1],cm.indices[i+2]);
            } else for (uint32_t i=0;i<(uint32_t)pa.count;i++) cm.indices.push_back(i);
            if (textured) {
                const Json& img = doc["images"][(size_t)imgIdx];
                if (img.has("bufferView")) { const Json& bv=doc["bufferViews"][(size_t)img["bufferView"].num()]; size_t o=bv.has("byteOffset")?(size_t)bv["byteOffset"].num():0,l=(size_t)bv["byteLength"].num(); if(o+l<=binLen){cm.baseColorBytes.assign(bin+o,bin+o+l);cm.baseColorKTX2=imgKTX2;} }
            }
            cm.alphaCutoff = cutoff;
            cm.transparent = blend;
            cm.metallic = metF; cm.roughness = roughF;
            rig->prims.push_back(std::move(rp));
            outMeshes.push_back(std::move(cm));
        }
    }

    // animations
    if (doc.has("animations")) {
        const Json& anims = doc["animations"];
        for (size_t a=0; a<anims.size(); a++) {
            const Json& an = anims[a]; RigAnim ra; ra.name = an["name"].str();
            const Json& samps = an["samplers"];
            ra.samp.resize(samps.size());
            for (size_t s=0;s<samps.size();s++) {
                int nc=0; decodeFloats(doc,bin,binLen,dec,(int)samps[s]["input"].num(), ra.samp[s].input, nc);
                decodeFloats(doc,bin,binLen,dec,(int)samps[s]["output"].num(), ra.samp[s].output, ra.samp[s].ncomp);
                std::string ip = samps[s]["interpolation"].str("LINEAR");
                ra.samp[s].interp = ip=="STEP"?1 : (ip=="CUBICSPLINE"?2:0);
                if (!ra.samp[s].input.empty()) ra.duration = std::fmax(ra.duration, ra.samp[s].input.back());
            }
            const Json& chans = an["channels"];
            for (size_t c=0;c<chans.size();c++) {
                const Json& ch = chans[c]; RigChannel rc;
                rc.sampler=(int)ch["sampler"].num(); rc.node=(int)ch["target"]["node"].num();
                std::string path=ch["target"]["path"].str();
                rc.path = path=="translation"?0 : (path=="rotation"?1 : (path=="scale"?2:-1));
                if (rc.path>=0 && rc.node>=0) ra.ch.push_back(rc);
            }
            rig->anims.push_back(std::move(ra));
        }
    }

    // bind pose into outMeshes
    poseRig(rig, -1, 0.0f, outMeshes);
    return rig;
}

void freeGlbRig(GlbRig* rig) { delete rig; }
int rigAnimCount(const GlbRig* rig) { return rig ? (int)rig->anims.size() : 0; }
std::string rigAnimName(const GlbRig* rig, int i) { return (rig && i>=0 && i<(int)rig->anims.size()) ? rig->anims[i].name : std::string(); }
float rigAnimDuration(const GlbRig* rig, int i) { return (rig && i>=0 && i<(int)rig->anims.size()) ? rig->anims[i].duration : 0.0f; }
int rigFindAnim(const GlbRig* rig, const std::string& name) {
    if (rig) for (int i=0;i<(int)rig->anims.size();i++) if (rig->anims[i].name==name) return i;
    return -1;
}

static void sampleChannel(const RigSampler& s, float t, double out[4]) {
    int nc = s.ncomp; if (nc <= 0 || s.input.empty()) return;
    size_t n = s.input.size();
    bool cubic = (s.interp == 2);
    // For CUBICSPLINE each key stores [inTangent, value, outTangent]; the value is at +nc.
    auto val = [&](size_t key, int c) -> double {
        return cubic ? s.output[key * 3 * nc + nc + c] : s.output[key * nc + c];
    };
    if (t <= s.input[0])     { for (int c=0;c<nc;c++) out[c] = val(0, c);   return; }
    if (t >= s.input[n - 1]) { for (int c=0;c<nc;c++) out[c] = val(n-1, c); return; }
    size_t i1 = 1; while (i1 < n && s.input[i1] < t) i1++;
    size_t i0 = i1 - 1;
    float t0 = s.input[i0], t1 = s.input[i1];
    float u = (t1 > t0) ? (t - t0) / (t1 - t0) : 0.0f;
    if (s.interp == 1) u = 0;   // STEP holds the left key
    for (int c = 0; c < nc; c++) { double a = val(i0, c), b = val(i1, c); out[c] = a + (b - a) * u; }
}

void poseRig(GlbRig* rig, int animIndex, float timeSec, std::vector<CpuMesh>& meshes) {
    if (!rig) return;
    size_t nn = rig->nodes.size();
    std::vector<std::array<double,10>> trs(nn);
    for (size_t i=0;i<nn;i++){ const RigNode& n=rig->nodes[i]; trs[i]={n.T[0],n.T[1],n.T[2],n.R[0],n.R[1],n.R[2],n.R[3],n.S[0],n.S[1],n.S[2]}; }

    if (animIndex>=0 && animIndex<(int)rig->anims.size()) {
        const RigAnim& an = rig->anims[animIndex];
        float t = an.duration>0 ? std::fmod(timeSec, an.duration) : 0.0f;
        for (const RigChannel& ch : an.ch) {
            double val[4]={0,0,0,1};
            sampleChannel(an.samp[ch.sampler], t, val);
            auto& v = trs[ch.node];
            if (ch.path==0){ v[0]=val[0];v[1]=val[1];v[2]=val[2]; }
            else if (ch.path==1){ // quat, normalize
                double L=std::sqrt(val[0]*val[0]+val[1]*val[1]+val[2]*val[2]+val[3]*val[3]); if(L<1e-9)L=1;
                v[3]=val[0]/L;v[4]=val[1]/L;v[5]=val[2]/L;v[6]=val[3]/L;
            } else if (ch.path==2){ v[7]=val[0];v[8]=val[1];v[9]=val[2]; }
        }
    }

    std::vector<GMat> world(nn, gident());
    for (int r : rig->roots) computeRigWorld(rig, trs, r, gident(), world);

    std::vector<std::vector<GMat>> jm(rig->skins.size());
    for (size_t s=0;s<rig->skins.size();s++){ const RigSkin& sk=rig->skins[s]; jm[s].resize(sk.joints.size()); for(size_t j=0;j<sk.joints.size();j++){ int jn=sk.joints[j]; GMat jw=(jn>=0&&(size_t)jn<nn)?world[jn]:gident(); jm[s][j]=gmul(jw, sk.ibm[j]); } }

    for (size_t p=0; p<rig->prims.size() && p<meshes.size(); p++) {
        const RigPrim& pr = rig->prims[p];
        const std::vector<GMat>* J = (pr.skin>=0 && pr.skin<(int)jm.size()) ? &jm[pr.skin] : nullptr;
        skinPrimInto(pr, world, J, meshes[p].verts);
    }
}

static void decomposeGMat(const GMat& m, double out[10]);   // defined below

void rigPoseLocals(GlbRig* rig, int animIndex, float timeSec, std::vector<double>& out) {
    if (!rig) { out.clear(); return; }
    size_t nn = rig->nodes.size();
    out.resize(nn * 10);
    for (size_t i = 0; i < nn; i++) { const RigNode& n = rig->nodes[i]; double* o = &out[i*10];
        // hasMatrix nodes (glb exports often bake the armature offset into a
        // node `matrix`) store their local transform as a matrix, not TRS — the
        // JS bone graph needs it decomposed or the world chain loses the offset.
        if (n.hasMatrix) { decomposeGMat(n.matrix, o); continue; }
        o[0]=n.T[0]; o[1]=n.T[1]; o[2]=n.T[2];
        o[3]=n.R[0]; o[4]=n.R[1]; o[5]=n.R[2]; o[6]=n.R[3];
        o[7]=n.S[0]; o[8]=n.S[1]; o[9]=n.S[2]; }
    if (animIndex >= 0 && animIndex < (int)rig->anims.size()) {
        const RigAnim& an = rig->anims[animIndex];
        float t = an.duration > 0 ? std::fmod(timeSec, an.duration) : 0.0f;
        for (const RigChannel& ch : an.ch) {
            double val[4] = {0,0,0,1};
            sampleChannel(an.samp[ch.sampler], t, val);
            double* v = &out[(size_t)ch.node * 10];
            if (ch.path == 0) { v[0]=val[0]; v[1]=val[1]; v[2]=val[2]; }
            else if (ch.path == 1) { double L=std::sqrt(val[0]*val[0]+val[1]*val[1]+val[2]*val[2]+val[3]*val[3]); if(L<1e-9)L=1;
                v[3]=val[0]/L; v[4]=val[1]/L; v[5]=val[2]/L; v[6]=val[3]/L; }
            else if (ch.path == 2) { v[7]=val[0]; v[8]=val[1]; v[9]=val[2]; }
        }
    }
    // §element-owns-the-root: the browser binds the element to the glb's top
    // node (model `node:`) and REPLACES its transform (render3d.js: "elements
    // own their transforms" — top-level nodes are excluded from the rest pose).
    // Natively the element model is applied ON TOP of the full node chain, so a
    // root node with a baked translation (this glb sits ~3.8 off in z) double-
    // counts and the character renders that far from her authored spot. Zero the
    // root translation here: because ibm still carries the original bind offset,
    // the skin matrix becomes exactly inv(offset) and the verts center on the
    // origin, so the element model alone places her. Rotation/scale stay (any
    // axis correction is preserved). bpAnim-only path — MM is untouched.
    for (size_t i = 0; i < nn; i++)
        if (rig->nodes[i].parent < 0) { out[i*10+0] = 0; out[i*10+1] = 0; out[i*10+2] = 0; }
}

// decompose a column-major matrix into pos/quat/scale (out[10])
static void decomposeGMat(const GMat& m, double out[10]) {
    double sx = std::sqrt(m.m[0]*m.m[0]+m.m[1]*m.m[1]+m.m[2]*m.m[2]);
    double sy = std::sqrt(m.m[4]*m.m[4]+m.m[5]*m.m[5]+m.m[6]*m.m[6]);
    double sz = std::sqrt(m.m[8]*m.m[8]+m.m[9]*m.m[9]+m.m[10]*m.m[10]);
    // (ignore reflection sign; rig matrices are non-reflective)
    double r00=m.m[0]/(sx?sx:1), r10=m.m[1]/(sx?sx:1), r20=m.m[2]/(sx?sx:1);
    double r01=m.m[4]/(sy?sy:1), r11=m.m[5]/(sy?sy:1), r21=m.m[6]/(sy?sy:1);
    double r02=m.m[8]/(sz?sz:1), r12=m.m[9]/(sz?sz:1), r22=m.m[10]/(sz?sz:1);
    double tr=r00+r11+r22, qx,qy,qz,qw;
    if (tr>0){ double s=0.5/std::sqrt(tr+1); qw=0.25/s; qx=(r21-r12)*s; qy=(r02-r20)*s; qz=(r10-r01)*s; }
    else if (r00>r11&&r00>r22){ double s=2*std::sqrt(1+r00-r11-r22); qw=(r21-r12)/s; qx=0.25*s; qy=(r01+r10)/s; qz=(r02+r20)/s; }
    else if (r11>r22){ double s=2*std::sqrt(1+r11-r00-r22); qw=(r02-r20)/s; qx=(r01+r10)/s; qy=0.25*s; qz=(r12+r21)/s; }
    else { double s=2*std::sqrt(1+r22-r00-r11); qw=(r10-r01)/s; qx=(r02+r20)/s; qy=(r12+r21)/s; qz=0.25*s; }
    out[0]=m.m[12]; out[1]=m.m[13]; out[2]=m.m[14];
    out[3]=qx; out[4]=qy; out[5]=qz; out[6]=qw; out[7]=sx; out[8]=sy; out[9]=sz;
}

bool rigSkinned(const GlbRig* rig) { return rig && !rig->skins.empty(); }
int  rigNodeCount(const GlbRig* rig) { return rig ? (int)rig->nodes.size() : 0; }
std::string rigNodeName(const GlbRig* rig, int i) { return (rig && i>=0 && i<(int)rig->nodes.size()) ? rig->nodes[i].name : std::string(); }
int  rigNodeParent(const GlbRig* rig, int i) { return (rig && i>=0 && i<(int)rig->nodes.size()) ? rig->nodes[i].parent : -1; }
void rigNodeBind(const GlbRig* rig, int i, double out[10]) {
    for (int k=0;k<10;k++) out[k]=0; out[6]=1; out[7]=out[8]=out[9]=1;
    if (!rig || i<0 || i>=(int)rig->nodes.size()) return;
    const RigNode& n = rig->nodes[i];
    if (n.hasMatrix) { decomposeGMat(n.matrix, out); return; }
    out[0]=n.T[0]; out[1]=n.T[1]; out[2]=n.T[2];
    out[3]=n.R[0]; out[4]=n.R[1]; out[5]=n.R[2]; out[6]=n.R[3];
    out[7]=n.S[0]; out[8]=n.S[1]; out[9]=n.S[2];
}

void poseRigFromWorlds(GlbRig* rig, const double* nodeWorlds, int nodeCount, std::vector<CpuMesh>& meshes) {
    if (!rig || !nodeWorlds) return;
    std::vector<GMat> world((size_t)nodeCount, gident());
    for (int i=0;i<nodeCount;i++) for (int k=0;k<16;k++) world[i].m[k]=nodeWorlds[i*16+k];
    std::vector<std::vector<GMat>> jm(rig->skins.size());
    for (size_t s=0;s<rig->skins.size();s++){ const RigSkin& sk=rig->skins[s]; jm[s].resize(sk.joints.size());
        for (size_t j=0;j<sk.joints.size();j++){ int jn=sk.joints[j]; GMat jw=(jn>=0&&jn<nodeCount)?world[jn]:gident(); jm[s][j]=gmul(jw, sk.ibm[j]); } }
    for (size_t p=0;p<rig->prims.size() && p<meshes.size();p++){ const RigPrim& pr=rig->prims[p];
        const std::vector<GMat>* J=(pr.skin>=0 && pr.skin<(int)jm.size())?&jm[pr.skin]:nullptr;
        skinPrimInto(pr, world, J, meshes[p].verts); }
}

void meshBounds(const std::vector<CpuMesh>& meshes, Vec3& lo, Vec3& hi) {
    bool any = false;
    for (const auto& m : meshes)
        for (const auto& v : m.verts) {
            if (!any) { lo = { v.px, v.py, v.pz }; hi = lo; any = true; }
            lo.x = v.px < lo.x ? v.px : lo.x; lo.y = v.py < lo.y ? v.py : lo.y; lo.z = v.pz < lo.z ? v.pz : lo.z;
            hi.x = v.px > hi.x ? v.px : hi.x; hi.y = v.py > hi.y ? v.py : hi.y; hi.z = v.pz > hi.z ? v.pz : hi.z;
        }
}

} // namespace ae1
