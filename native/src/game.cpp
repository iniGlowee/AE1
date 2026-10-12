// game.cpp — ae1game: the Phase-A capstone. Tick + draw in one native loop.
//
// Usage: ae1game <agp-dir> <engine-dir>
//
// This joins the two halves proven separately: it hosts the REAL engine
// scheduler in QuickJS (compileAll/rehydrate/buildSchedule/dispatch on the real
// scene, as ae1run does) AND renders that scene with the D3D11 gfx seam (as
// ae1player does). Each frame it dispatches onTick in JS, then reads every drawn
// element's LIVE transform back from the JS scene and draws its meshes there —
// so whatever the game logic moves, moves on screen. The rendering element types
// are still stubbed (no env3d yet), so scripts that reach for the renderer are
// caught; transforms scripts set directly on the element already follow.
//
// This is the honest definition of "the native runtime runs the game": one loop,
// the engine's own model ticking, drawing itself.
#include "qjs_host.hpp"
#include "agp.hpp"
#include "json.hpp"
#include "platform.hpp"
#include "gfx.hpp"
#include "gltf.hpp"
#include "tex.hpp"
#include "audio.hpp"

#include <cstdio>
#include <cstring>
#include <cmath>
#include <string>
#include <vector>
#include <array>
#include <map>
#include <set>
#include <cstdlib>
#include <fstream>
#include <algorithm>  // std::sort (transparent back-to-front)
#include <direct.h>   // _mkdir (gait warm-cache dir)

using namespace ae1;
using Mat16 = std::array<double, 16>;

static std::string g_dataJson, g_entryScene;
static JSValue js_dataJSON(JSContext* c, JSValueConst, int, JSValueConst*) { return JS_NewStringLen(c, g_dataJson.data(), g_dataJson.size()); }
static JSValue js_entryScene(JSContext* c, JSValueConst, int, JSValueConst*) { return JS_NewStringLen(c, g_entryScene.data(), g_entryScene.size()); }

// ---- input3d native backing: KeyboardEvent.code / Mouse<N> -> live key state -
static FrameInput g_in;   // refreshed each frame before ticking

// ---- gamepad (XInput) ------------------------------------------------------
// The AE1 controller binds Pad* codes (PadA/PadLT/PadLS...) and reads the left
// stick via input3d.stick() + right stick via lookStick(). We poll XInput each
// frame and expose that state through those same seams.
enum { PAD_A, PAD_B, PAD_X, PAD_Y, PAD_LB, PAD_RB, PAD_LT, PAD_RT,
       PAD_START, PAD_SELECT, PAD_LS, PAD_RS, PAD_UP, PAD_DOWN, PAD_LEFT, PAD_RIGHT, PAD_N };
static bool  g_padCur[PAD_N] = {}, g_padPrev[PAD_N] = {};
static float g_padLX = 0, g_padLY = 0, g_padRX = 0, g_padRY = 0;
static bool  g_padConnected = false;
static int padIndex(const char* c) {
    if (std::strncmp(c, "Pad", 3) != 0) return -1;
    const char* s = c + 3;
    struct { const char* n; int i; } m[] = {
        {"A",PAD_A},{"B",PAD_B},{"X",PAD_X},{"Y",PAD_Y},{"LB",PAD_LB},{"RB",PAD_RB},
        {"LT",PAD_LT},{"RT",PAD_RT},{"Start",PAD_START},{"Select",PAD_SELECT},
        {"LS",PAD_LS},{"RS",PAD_RS},{"Up",PAD_UP},{"Down",PAD_DOWN},{"Left",PAD_LEFT},{"Right",PAD_RIGHT} };
    for (auto& e : m) if (!std::strcmp(s, e.n)) return e.i;
    return -1;
}
static JSValue js_lookStickX(JSContext* ctx, JSValueConst, int, JSValueConst*) { return JS_NewFloat64(ctx, g_padRX); }
static JSValue js_lookStickY(JSContext* ctx, JSValueConst, int, JSValueConst*) { return JS_NewFloat64(ctx, g_padRY); }

// Map a KeyboardEvent.code / mouse name (the AE1 controller's binding strings)
// to a virtual-key index, or -1. Negative sentinels -2/-3/-4 mean mouse L/R/M.
static int codeToVK(const char* c) {
    if (!c || !c[0]) return -1;
    size_t n = std::strlen(c);
    if (n == 4 && std::strncmp(c, "Key", 3) == 0) return (unsigned char)c[3];          // KeyW -> 'W'
    if (n == 6 && std::strncmp(c, "Digit", 5) == 0) return (unsigned char)c[5];         // Digit5 -> '5'
    if (!std::strcmp(c, "Space")) return 0x20;
    if (!std::strcmp(c, "Enter")) return 0x0D;
    if (!std::strcmp(c, "Tab")) return 0x09;
    if (!std::strcmp(c, "Escape")) return 0x1B;
    if (!std::strcmp(c, "ArrowUp")) return 0x26;
    if (!std::strcmp(c, "ArrowDown")) return 0x28;
    if (!std::strcmp(c, "ArrowLeft")) return 0x25;
    if (!std::strcmp(c, "ArrowRight")) return 0x27;
    if (!std::strcmp(c, "ShiftLeft") || !std::strcmp(c, "ShiftRight")) return 0x10;
    if (!std::strcmp(c, "ControlLeft") || !std::strcmp(c, "ControlRight")) return 0x11;
    if (!std::strcmp(c, "Mouse0")) return -2;
    if (!std::strcmp(c, "Mouse2")) return -3;
    if (!std::strcmp(c, "Mouse1")) return -4;
    return -1;   // gamepad (Pad*) and everything else: not bound natively yet
}
static JSValue js_keyDown(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1) return JS_FALSE;
    const char* s = JS_ToCString(ctx, argv[0]); if (!s) return JS_FALSE;
    int pad = padIndex(s);
    int vk = pad < 0 ? codeToVK(s) : -1; JS_FreeCString(ctx, s);
    if (pad >= 0) return g_padCur[pad] ? JS_TRUE : JS_FALSE;
    bool d = false;
    if (vk == -2) d = g_in.mouseDown[0]; else if (vk == -3) d = g_in.mouseDown[1];
    else if (vk == -4) d = g_in.mouseDown[2]; else if (vk >= 0 && vk < 256) d = g_in.down[vk];
    return d ? JS_TRUE : JS_FALSE;
}
static JSValue js_keyPressed(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1) return JS_FALSE;
    const char* s = JS_ToCString(ctx, argv[0]); if (!s) return JS_FALSE;
    int pad = padIndex(s);
    int vk = pad < 0 ? codeToVK(s) : -1; JS_FreeCString(ctx, s);
    if (pad >= 0) return (g_padCur[pad] && !g_padPrev[pad]) ? JS_TRUE : JS_FALSE;
    bool p = (vk >= 0 && vk < 256) ? g_in.pressed[vk] : false;
    return p ? JS_TRUE : JS_FALSE;
}
static float g_stickX = 0, g_stickY = 0;   // analog left stick (0..1 deflection)
static JSValue js_stickX(JSContext* ctx, JSValueConst, int, JSValueConst*) { return JS_NewFloat64(ctx, g_stickX); }
static JSValue js_stickY(JSContext* ctx, JSValueConst, int, JSValueConst*) { return JS_NewFloat64(ctx, g_stickY); }
// Mouse-look: the real AE1ThirdPersonCamera reads input.looking + consumeLook()
// ({dx,dy} px since last read). We accumulate the frame's mouse delta while the
// look button is held and hand it over on consume.
static double g_lookDX = 0, g_lookDY = 0; static bool g_looking = false;
static JSValue js_lookActive(JSContext* ctx, JSValueConst, int, JSValueConst*) { return g_looking ? JS_TRUE : JS_FALSE; }
static JSValue js_consumeLook(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    JSValue a = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, a, 0, JS_NewFloat64(ctx, g_lookDX));
    JS_SetPropertyUint32(ctx, a, 1, JS_NewFloat64(ctx, g_lookDY));
    g_lookDX = g_lookDY = 0;   // consumed
    return a;
}

// ---- audio facade backing: play a named pack asset ------------------------
static Aepack* g_pack = nullptr;
static Audio*  g_audio = nullptr;
static GlyphAtlas g_font;          // native UI text (PS2 Helvetica)
static TexHandle  g_fontTex;
static bool       g_fontOK = false;
static JSValue playNamed(JSContext* ctx, int argc, JSValueConst* argv, bool loop) {
    if (!g_audio || !g_pack || argc < 1) return JS_UNDEFINED;
    const char* n = JS_ToCString(ctx, argv[0]); if (!n) return JS_UNDEFINED;
    std::string nm = n; JS_FreeCString(ctx, n);
    const AepackEntry* e = g_pack->find(nm);
    if (!e) e = g_pack->find(nm + ".mp3");
    if (e) g_audio->play(g_pack->data(*e), (size_t)e->length, loop);
    return JS_UNDEFINED;
}
static JSValue js_playSound(JSContext* c, JSValueConst, int n, JSValueConst* a) { return playNamed(c, n, a, false); }
static JSValue js_playMusic(JSContext* c, JSValueConst, int n, JSValueConst* a) { return playNamed(c, n, a, true); }
// settings.js → world.audio: drive the miniaudio music/sfx buses + master mute.
static JSValue js_setMusicVolume(JSContext* c, JSValueConst, int n, JSValueConst* a) {
    double v = 1; if (n > 0) JS_ToFloat64(c, &v, a[0]); if (g_audio) g_audio->setMusicVolume((float)v); return JS_UNDEFINED; }
static JSValue js_setSoundVolume(JSContext* c, JSValueConst, int n, JSValueConst* a) {
    double v = 1; if (n > 0) JS_ToFloat64(c, &v, a[0]); if (g_audio) g_audio->setSoundVolume((float)v); return JS_UNDEFINED; }
static JSValue js_setMuted(JSContext* c, JSValueConst, int n, JSValueConst* a) {
    int m = (n > 0) ? JS_ToBool(c, a[0]) : 0; if (g_audio) g_audio->setMuted(m > 0); return JS_UNDEFINED; }

// ---- asset access for the motion-matching fetch shim --------------------------
static const AepackEntry* findAsset(const std::string& nm) {
    if (!g_pack) return nullptr;
    const AepackEntry* e = g_pack->find(nm);
    if (!e) e = g_pack->find(std::string("__") + nm);   // reserved-name assets
    return e;
}
static JSValue js_asset(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1) return JS_NULL;
    const char* n = JS_ToCString(ctx, argv[0]); if (!n) return JS_NULL;
    const AepackEntry* e = findAsset(n); JS_FreeCString(ctx, n);
    if (!e) return JS_NULL;
    return JS_NewArrayBufferCopy(ctx, g_pack->data(*e), (size_t)e->length);
}
static JSValue js_assetText(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1) return JS_NULL;
    const char* n = JS_ToCString(ctx, argv[0]); if (!n) return JS_NULL;
    const AepackEntry* e = findAsset(n); JS_FreeCString(ctx, n);
    if (!e) return JS_NULL;
    return JS_NewStringLen(ctx, (const char*)g_pack->data(*e), (size_t)e->length);
}
// Dequantize a motion-matching _poses.bin/_features.bin (int16 + per-column scales
// from its _motions.json) to float32 NATIVELY — this is the 20s load cost the
// interpreted matcher paid; here it's milliseconds. Returns a float32 ArrayBuffer.
static bool endsWith(const std::string& s, const char* suf) {
    size_t n = std::strlen(suf); return s.size() >= n && s.compare(s.size()-n, n, suf) == 0;
}
static JSValue js_dequantAsset(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1 || !g_pack) return JS_NULL;
    const char* n = JS_ToCString(ctx, argv[0]); if (!n) return JS_NULL;
    std::string nm = n; JS_FreeCString(ctx, n);
    const AepackEntry* e = findAsset(nm); if (!e) return JS_NULL;
    bool isPoses = endsWith(nm, "_poses.bin"), isFeat = endsWith(nm, "_features.bin");
    if (!isPoses && !isFeat) return JS_NewArrayBufferCopy(ctx, g_pack->data(*e), (size_t)e->length);
    std::string base = nm.substr(0, nm.size() - (isPoses ? 10 : 13));
    const AepackEntry* me = findAsset(base + "_motions.json");
    std::vector<double> scales;
    if (me) {
        try {
            Json j = Json::parse((const char*)g_pack->data(*me), (size_t)me->length);
            const Json& q = j["quant"][isPoses ? "poses" : "features"]["scales"];
            if (q.isArray()) for (size_t i = 0; i < q.size(); i++) scales.push_back(q[i].num());
        } catch (...) {}
    }
    if (scales.empty()) return JS_NewArrayBufferCopy(ctx, g_pack->data(*e), (size_t)e->length);  // already float
    const int16_t* i16 = (const int16_t*)g_pack->data(*e);
    size_t n16 = (size_t)e->length / 2, S = scales.size();
    std::vector<float> out(n16);
    std::vector<double> inv(S); for (size_t c = 0; c < S; c++) inv[c] = scales[c] / 32767.0;
    for (size_t i = 0, c = 0; i < n16; i++, c++) { if (c == S) c = 0; out[i] = (float)(i16[i] * inv[c]); }
    return JS_NewArrayBufferCopy(ctx, (const uint8_t*)out.data(), out.size() * 4);
}

// ---- import parsing (to stub runtime.js's rendering modules) ----------------
struct ImportLine { std::string path; std::vector<std::string> names; };
static std::vector<ImportLine> parseImports(const std::string& src) {
    std::vector<ImportLine> out; size_t i = 0;
    while (i < src.size()) {
        size_t nl = src.find('\n', i); if (nl == std::string::npos) nl = src.size();
        std::string line = src.substr(i, nl - i); i = nl + 1;
        size_t imp = line.find("import"), br0 = line.find('{'), br1 = line.find('}'), from = line.find("from");
        if (imp == std::string::npos || br0 == std::string::npos || br1 == std::string::npos || from == std::string::npos || br1 < br0) continue;
        size_t q0 = line.find_first_of("'\"", from); if (q0 == std::string::npos) continue;
        size_t q1 = line.find_first_of("'\"", q0 + 1); if (q1 == std::string::npos) continue;
        ImportLine il; il.path = line.substr(q0 + 1, q1 - q0 - 1);
        std::string names = line.substr(br0 + 1, br1 - br0 - 1); size_t p = 0;
        while (p < names.size()) {
            size_t c = names.find(',', p); if (c == std::string::npos) c = names.size();
            std::string nm = names.substr(p, c - p);
            size_t a = nm.find_first_not_of(" \t\r"), b = nm.find_last_not_of(" \t\r");
            if (a != std::string::npos) { nm = nm.substr(a, b - a + 1); if (!nm.empty()) il.names.push_back(nm); }
            p = c + 1;
        }
        if (!il.names.empty()) out.push_back(std::move(il));
    }
    return out;
}

// ---- element transform -> gfx model matrix ---------------------------------
// three.js column-major RH T*R*S from raw transform values.
static Mat16 buildRH(const double v[10]) {
    const double DEG = 3.14159265358979323846 / 180.0;
    double x=v[0],y=v[1],z=v[2], rx=v[3]*DEG,ry=v[4]*DEG,rz=v[5]*DEG, sx=v[6],sy=v[7],sz=v[8];
    bool yxz = v[9] != 0.0;
    double a=std::cos(rx),b=std::sin(rx),c=std::cos(ry),d=std::sin(ry),e=std::cos(rz),f=std::sin(rz);
    double t0,t1,t2,t4,t5,t6,t8,t9,t10;
    if (yxz) { double ce=c*e,cf=c*f,de=d*e,df=d*f;
        t0=ce+df*b; t4=de*b-cf; t8=a*d; t1=a*f; t5=a*e; t9=-b; t2=cf*b-de; t6=df+ce*b; t10=a*c;
    } else { double ae=a*e,af=a*f,be=b*e,bf=b*f;
        t0=c*e; t4=-c*f; t8=d; t1=af+be*d; t5=ae-bf*d; t9=-b*c; t2=bf-ae*d; t6=be+af*d; t10=a*c; }
    return { t0*sx,t1*sx,t2*sx,0, t4*sy,t5*sy,t6*sy,0, t8*sz,t9*sz,t10*sz,0, x,y,z,1 };
}
// Convert the RH element transform to the gfx (left-handed) model matrix. The
// mesh verts are glb-local left-handed (loader flips Z with no root), so the
// model matrix must be F*M_rh*F (F = diag(1,1,-1)); with the col-major<->row-major
// storage flip that transpose implies, the result copies straight into Mat4.m.
static Mat4 elemModelLH(const double v[10]) {
    Mat16 A = buildRH(v);
    Mat4 g;
    for (int k = 0; k < 16; k++) { int col = k/4, row = k%4; double s = ((row==2)!=(col==2)) ? -1.0 : 1.0; g.m[k] = (float)(A[k]*s); }
    return g;
}

// A pure-JS shim for the ONLY parts of three.js the engine's non-render modules
// use: the math classes (the motion-matching core (not in the public build): Vector2/Vector3/Quaternion). No WebGL,
// so it loads in QuickJS and un-stubs the motion-matching character (the player character's locomotion).
static const char* kThreeShim = R"JS(
export class Vector3 {
  constructor(x=0,y=0,z=0){ this.x=x; this.y=y; this.z=z; }
  set(x,y,z){ this.x=x; this.y=y; this.z=z; return this; }
  setScalar(s){ this.x=this.y=this.z=s; return this; }
  copy(v){ this.x=v.x; this.y=v.y; this.z=v.z; return this; }
  clone(){ return new Vector3(this.x,this.y,this.z); }
  add(v){ this.x+=v.x; this.y+=v.y; this.z+=v.z; return this; }
  addVectors(a,b){ this.x=a.x+b.x; this.y=a.y+b.y; this.z=a.z+b.z; return this; }
  addScaledVector(v,s){ this.x+=v.x*s; this.y+=v.y*s; this.z+=v.z*s; return this; }
  sub(v){ this.x-=v.x; this.y-=v.y; this.z-=v.z; return this; }
  subVectors(a,b){ this.x=a.x-b.x; this.y=a.y-b.y; this.z=a.z-b.z; return this; }
  multiplyScalar(s){ this.x*=s; this.y*=s; this.z*=s; return this; }
  divideScalar(s){ return this.multiplyScalar(s?1/s:0); }
  negate(){ this.x=-this.x; this.y=-this.y; this.z=-this.z; return this; }
  dot(v){ return this.x*v.x+this.y*v.y+this.z*v.z; }
  cross(v){ return this.crossVectors(this,v); }
  crossVectors(a,b){ const ax=a.x,ay=a.y,az=a.z,bx=b.x,by=b.y,bz=b.z;
    this.x=ay*bz-az*by; this.y=az*bx-ax*bz; this.z=ax*by-ay*bx; return this; }
  lengthSq(){ return this.x*this.x+this.y*this.y+this.z*this.z; }
  length(){ return Math.sqrt(this.lengthSq()); }
  normalize(){ return this.divideScalar(this.length()||1); }
  setLength(l){ return this.normalize().multiplyScalar(l); }
  setFromMatrixPosition(m){ const e=m.elements; return this.set(e[12],e[13],e[14]); }
  distanceToSquared(v){ const dx=this.x-v.x,dy=this.y-v.y,dz=this.z-v.z; return dx*dx+dy*dy+dz*dz; }
  distanceTo(v){ return Math.sqrt(this.distanceToSquared(v)); }
  lerp(v,a){ this.x+=(v.x-this.x)*a; this.y+=(v.y-this.y)*a; this.z+=(v.z-this.z)*a; return this; }
  applyQuaternion(q){ const {x,y,z}=this, qx=q.x,qy=q.y,qz=q.z,qw=q.w;
    const ix=qw*x+qy*z-qz*y, iy=qw*y+qz*x-qx*z, iz=qw*z+qx*y-qy*x, iw=-qx*x-qy*y-qz*z;
    this.x=ix*qw+iw*-qx+iy*-qz-iz*-qy; this.y=iy*qw+iw*-qy+iz*-qx-ix*-qz; this.z=iz*qw+iw*-qz+ix*-qy-iy*-qx; return this; }
  equals(v){ return v.x===this.x&&v.y===this.y&&v.z===this.z; }
  toArray(a=[],o=0){ a[o]=this.x; a[o+1]=this.y; a[o+2]=this.z; return a; }
  fromArray(a,o=0){ this.x=a[o]; this.y=a[o+1]; this.z=a[o+2]; return this; }
}
export class Vector2 {
  constructor(x=0,y=0){ this.x=x; this.y=y; }
  set(x,y){ this.x=x; this.y=y; return this; }
  copy(v){ this.x=v.x; this.y=v.y; return this; }
  clone(){ return new Vector2(this.x,this.y); }
  add(v){ this.x+=v.x; this.y+=v.y; return this; }
  sub(v){ this.x-=v.x; this.y-=v.y; return this; }
  multiplyScalar(s){ this.x*=s; this.y*=s; return this; }
  dot(v){ return this.x*v.x+this.y*v.y; }
  lengthSq(){ return this.x*this.x+this.y*this.y; }
  length(){ return Math.sqrt(this.lengthSq()); }
  normalize(){ const l=this.length()||1; this.x/=l; this.y/=l; return this; }
  lerp(v,a){ this.x+=(v.x-this.x)*a; this.y+=(v.y-this.y)*a; return this; }
  toArray(a=[],o=0){ a[o]=this.x; a[o+1]=this.y; return a; }
  fromArray(a,o=0){ this.x=a[o]; this.y=a[o+1]; return this; }
}
export class Quaternion {
  constructor(x=0,y=0,z=0,w=1){ this.x=x; this.y=y; this.z=z; this.w=w; }
  set(x,y,z,w){ this.x=x; this.y=y; this.z=z; this.w=w; return this; }
  identity(){ this.x=0; this.y=0; this.z=0; this.w=1; return this; }
  copy(q){ this.x=q.x; this.y=q.y; this.z=q.z; this.w=q.w; return this; }
  clone(){ return new Quaternion(this.x,this.y,this.z,this.w); }
  setFromAxisAngle(axis,angle){ const h=angle/2, s=Math.sin(h);
    this.x=axis.x*s; this.y=axis.y*s; this.z=axis.z*s; this.w=Math.cos(h); return this; }
  setFromUnitVectors(a,b){ let r=a.x*b.x+a.y*b.y+a.z*b.z+1;
    if(r<1e-8){ r=0; if(Math.abs(a.x)>Math.abs(a.z)){ this.x=-a.y; this.y=a.x; this.z=0; } else { this.x=0; this.y=-a.z; this.z=a.y; } }
    else { this.x=a.y*b.z-a.z*b.y; this.y=a.z*b.x-a.x*b.z; this.z=a.x*b.y-a.y*b.x; }
    this.w=r; return this.normalize(); }
  setFromEuler(e){ const x=e.x||e._x||0,y=e.y||e._y||0,z=e.z||e._z||0;
    const c1=Math.cos(x/2),c2=Math.cos(y/2),c3=Math.cos(z/2),s1=Math.sin(x/2),s2=Math.sin(y/2),s3=Math.sin(z/2);
    this.x=s1*c2*c3+c1*s2*s3; this.y=c1*s2*c3-s1*c2*s3; this.z=c1*c2*s3+s1*s2*c3; this.w=c1*c2*c3-s1*s2*s3; return this; }
  multiply(q){ return this.multiplyQuaternions(this,q); }
  premultiply(q){ return this.multiplyQuaternions(q,this); }
  multiplyQuaternions(a,b){ const ax=a.x,ay=a.y,az=a.z,aw=a.w,bx=b.x,by=b.y,bz=b.z,bw=b.w;
    this.x=ax*bw+aw*bx+ay*bz-az*by; this.y=ay*bw+aw*by+az*bx-ax*bz;
    this.z=az*bw+aw*bz+ax*by-ay*bx; this.w=aw*bw-ax*bx-ay*by-az*bz; return this; }
  conjugate(){ this.x*=-1; this.y*=-1; this.z*=-1; return this; }
  invert(){ return this.conjugate(); }
  dot(q){ return this.x*q.x+this.y*q.y+this.z*q.z+this.w*q.w; }
  lengthSq(){ return this.dot(this); }
  length(){ return Math.sqrt(this.lengthSq()); }
  normalize(){ let l=this.length(); if(l===0){ this.x=this.y=this.z=0; this.w=1; } else { l=1/l; this.x*=l; this.y*=l; this.z*=l; this.w*=l; } return this; }
  slerpQuaternions(a,b,t){ return this.copy(a).slerp(b,t); }
  slerp(q,t){ if(t===0) return this; if(t===1) return this.copy(q);
    let cos=this.dot(q); let q2=q;
    if(cos<0){ cos=-cos; q2={x:-q.x,y:-q.y,z:-q.z,w:-q.w}; }
    if(cos>0.9995){ this.x+=(q2.x-this.x)*t; this.y+=(q2.y-this.y)*t; this.z+=(q2.z-this.z)*t; this.w+=(q2.w-this.w)*t; return this.normalize(); }
    const s=Math.sqrt(1-cos*cos), th=Math.atan2(s,cos), a=Math.sin((1-t)*th)/s, b=Math.sin(t*th)/s;
    this.x=this.x*a+q2.x*b; this.y=this.y*a+q2.y*b; this.z=this.z*a+q2.z*b; this.w=this.w*a+q2.w*b; return this; }
  toArray(a=[],o=0){ a[o]=this.x; a[o+1]=this.y; a[o+2]=this.z; a[o+3]=this.w; return a; }
  fromArray(a,o=0){ this.x=a[o]; this.y=a[o+1]; this.z=a[o+2]; this.w=a[o+3]; return this; }
}
export const MathUtils = { clamp:(v,a,b)=>Math.max(a,Math.min(b,v)), DEG2RAD:Math.PI/180, RAD2DEG:180/Math.PI, lerp:(a,b,t)=>a+(b-a)*t };

// Matrix4 + Object3D/Bone — the scene-graph surface the motion-matching matcher
// poses (bones with position/quaternion, getWorldPosition, traverse). Column-
// major like three.js so native readback (world matrices) maps 1:1.
export class Matrix4 {
  constructor(){ this.elements=[1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }
  copy(m){ const e=this.elements,s=m.elements; for(let i=0;i<16;i++) e[i]=s[i]; return this; }
  compose(p,q,s){ const te=this.elements, x=q.x,y=q.y,z=q.z,w=q.w;
    const x2=x+x,y2=y+y,z2=z+z, xx=x*x2,xy=x*y2,xz=x*z2, yy=y*y2,yz=y*z2,zz=z*z2, wx=w*x2,wy=w*y2,wz=w*z2, sx=s.x,sy=s.y,sz=s.z;
    te[0]=(1-(yy+zz))*sx; te[1]=(xy+wz)*sx; te[2]=(xz-wy)*sx; te[3]=0;
    te[4]=(xy-wz)*sy; te[5]=(1-(xx+zz))*sy; te[6]=(yz+wx)*sy; te[7]=0;
    te[8]=(xz+wy)*sz; te[9]=(yz-wx)*sz; te[10]=(1-(xx+yy))*sz; te[11]=0;
    te[12]=p.x; te[13]=p.y; te[14]=p.z; te[15]=1; return this; }
  multiplyMatrices(a,b){ const ae=a.elements,be=b.elements,te=this.elements;
    const a11=ae[0],a12=ae[4],a13=ae[8],a14=ae[12],a21=ae[1],a22=ae[5],a23=ae[9],a24=ae[13],a31=ae[2],a32=ae[6],a33=ae[10],a34=ae[14],a41=ae[3],a42=ae[7],a43=ae[11],a44=ae[15];
    const b11=be[0],b12=be[4],b13=be[8],b14=be[12],b21=be[1],b22=be[5],b23=be[9],b24=be[13],b31=be[2],b32=be[6],b33=be[10],b34=be[14],b41=be[3],b42=be[7],b43=be[11],b44=be[15];
    te[0]=a11*b11+a12*b21+a13*b31+a14*b41; te[4]=a11*b12+a12*b22+a13*b32+a14*b42; te[8]=a11*b13+a12*b23+a13*b33+a14*b43; te[12]=a11*b14+a12*b24+a13*b34+a14*b44;
    te[1]=a21*b11+a22*b21+a23*b31+a24*b41; te[5]=a21*b12+a22*b22+a23*b32+a24*b42; te[9]=a21*b13+a22*b23+a23*b33+a24*b43; te[13]=a21*b14+a22*b24+a23*b34+a24*b44;
    te[2]=a31*b11+a32*b21+a33*b31+a34*b41; te[6]=a31*b12+a32*b22+a33*b32+a34*b42; te[10]=a31*b13+a32*b23+a33*b33+a34*b43; te[14]=a31*b14+a32*b24+a33*b34+a34*b44;
    te[3]=a41*b11+a42*b21+a43*b31+a44*b41; te[7]=a41*b12+a42*b22+a43*b32+a44*b42; te[11]=a41*b13+a42*b23+a43*b33+a44*b43; te[15]=a41*b14+a42*b24+a43*b34+a44*b44; return this; }
}
export class Object3D {
  constructor(){ this.name=''; this.parent=null; this.children=[]; this.position=new Vector3(); this.quaternion=new Quaternion(); this.scale=new Vector3(1,1,1); this.matrix=new Matrix4(); this.matrixWorld=new Matrix4(); this.userData={}; this.visible=true; this.isObject3D=true; }
  add(o){ o.parent=this; this.children.push(o); return this; }
  traverse(cb){ cb(this); const c=this.children; for(let i=0;i<c.length;i++) c[i].traverse(cb); }
  getObjectByName(n){ if(this.name===n) return this; const c=this.children; for(let i=0;i<c.length;i++){ const r=c[i].getObjectByName(n); if(r) return r; } return null; }
  updateMatrix(){ this.matrix.compose(this.position,this.quaternion,this.scale); return this; }
  updateMatrixWorld(){ this.updateMatrix(); if(this.parent) this.matrixWorld.multiplyMatrices(this.parent.matrixWorld,this.matrix); else this.matrixWorld.copy(this.matrix); const c=this.children; for(let i=0;i<c.length;i++) c[i].updateMatrixWorld(true); }
  updateWorldMatrix(up,down){ if(up&&this.parent) this.parent.updateWorldMatrix(true,false); this.updateMatrix(); if(this.parent) this.matrixWorld.multiplyMatrices(this.parent.matrixWorld,this.matrix); else this.matrixWorld.copy(this.matrix); if(down){ const c=this.children; for(let i=0;i<c.length;i++) c[i].updateWorldMatrix(false,true); } }
  getWorldPosition(v){ this.updateWorldMatrix(true,false); const e=this.matrixWorld.elements; return v.set(e[12],e[13],e[14]); }
  getWorldQuaternion(q){ this.updateWorldMatrix(true,false); const te=this.matrixWorld.elements;
    let sx=Math.hypot(te[0],te[1],te[2])||1, sy=Math.hypot(te[4],te[5],te[6])||1, sz=Math.hypot(te[8],te[9],te[10])||1;
    const m00=te[0]/sx,m01=te[4]/sy,m02=te[8]/sz, m10=te[1]/sx,m11=te[5]/sy,m12=te[9]/sz, m20=te[2]/sx,m21=te[6]/sy,m22=te[10]/sz;
    const tr=m00+m11+m22;
    if(tr>0){ const s=0.5/Math.sqrt(tr+1); q.w=0.25/s; q.x=(m21-m12)*s; q.y=(m02-m20)*s; q.z=(m10-m01)*s; }
    else if(m00>m11&&m00>m22){ const s=2*Math.sqrt(1+m00-m11-m22); q.w=(m21-m12)/s; q.x=0.25*s; q.y=(m01+m10)/s; q.z=(m02+m20)/s; }
    else if(m11>m22){ const s=2*Math.sqrt(1+m11-m00-m22); q.w=(m02-m20)/s; q.x=(m01+m10)/s; q.y=0.25*s; q.z=(m12+m21)/s; }
    else { const s=2*Math.sqrt(1+m22-m00-m11); q.w=(m10-m01)/s; q.x=(m02+m20)/s; q.y=(m12+m21)/s; q.z=0.25*s; }
    return q; }
  getWorldScale(v){ this.updateWorldMatrix(true,false); const e=this.matrixWorld.elements;
    return v.set(Math.hypot(e[0],e[1],e[2]), Math.hypot(e[4],e[5],e[6]), Math.hypot(e[8],e[9],e[10])); }
}
export class Bone extends Object3D { constructor(){ super(); this.isBone=true; this.type='Bone'; } }
)JS";

// The engine harness: real scene + scheduler + NATIVE platform bindings.
// input3d is backed by the native keyboard; env3d is the query surface with
// sensible native-less defaults; `world` is lenient (a deep no-op for fields we
// don't implement) so the real element modules run without crashing.
static const char* kGame = R"JS(
import { AE1Scene } from './scene.js';
import { compileAll, rehydrate, buildSchedule, dispatch } from './ags/runtime.js';
import * as THREE from 'three';
import { Object3D, Bone } from 'three';
import { AE1ThirdPersonCamera } from './thirdperson.js';
import { createBonePhys } from './three3d/bonephys.js';
import { AE1Save, SAVE_EXT } from './save.js';
import { AE1Settings } from './settings.js';
const data = JSON.parse(__dataJSON());
const sceneData = data.scenes[__entryScene()];
let scene = new AE1Scene(sceneData);   // `let`: goToScene replaces it with the target scene

// ---- the real seams (docs/engine/20) ----
const input3d = {
  // a binding may name space-separated alternatives ("KeyW ArrowUp") — any held fires.
  down:    (c) => String(c == null ? '' : c).split(/\s+/).some(k => k && !!__keyDown(k)),
  pressed: (c) => String(c == null ? '' : c).split(/\s+/).some(k => k && !!__keyPressed(k)),
  released:()  => false,
  stick:   ()  => ({ x: __stickX(), y: __stickY() }),
  lookStick:() => ({ x: __lookStickX(), y: __lookStickY() }),   // right stick (gamepad)
  get looking() { return __lookActive(); },          // live: true while the look button is held OR a pad is present
  consumeLook:() => { const a = __consumeLook(); return { dx: a[0], dy: a[1] }; },
  any:()=>false, endFrame:()=>{}, remove:()=>{}, attach:()=>{},
  addEventListener:()=>{}, removeEventListener:()=>{}, click:()=>false,
};
const env3d = {
  groundAt:   (el, x, z, from) => __groundAt(x||0, z||0, from==null?1e18:from),
  groundInfo: (el, x, z, from) => ({ y: __groundAt(x||0, z||0, from==null?1e18:from), normal: { x:0, y:1, z:0 }, hit: true, slope: 0 }),
  boundsOf:   () => ({ min:{x:-0.5,y:0,z:-0.5}, max:{x:0.5,y:1.8,z:0.5} }),
  blocked:    () => false,
  clipTime:   () => 0, setClipTime: () => {},
  setLodFar:  () => {}, setPaused: () => {}, setPostFxOff: () => {},
  nodePos:  (el)    => ({ x: el&&el.x||0, y: el&&el.y||0, z: el&&el.z||0 }),
  aimPoint: (el, d) => ({ x: el&&el.x||0, y: (el&&el.y||0)+1, z: (el&&el.z||0)+(d||10) }),
  objectFor: () => null, materialsOf: () => [],
};
// A deep no-op: any property access or call returns itself, so world.<unknown>...
// never throws while the real fields below resolve for real.
const deep = new Proxy(function(){}, {
  get(t,k){
    if (k===Symbol.toPrimitive) return ()=>0;   // coerce to 0 in arithmetic
    if (k==='valueOf') return ()=>0;
    if (k==='toString') return ()=>'';
    if (k===Symbol.iterator) return function*(){};   // empty for-of
    return deep;
  },
  apply:()=>deep, construct:()=>deep,
});
// ---- native localStorage: the engine's save.js/settings.js "continue" and
// settings slots persist through this. Backed by ONE JSON blob in the saves
// dir (atomic write via the platform seam), loaded once, write-through on set.
// The durable save FILES are separate (save.js `write` → __saveWrite a slot).
const localStorage = (() => {
  const FILE = '.localstore.json';
  let map = {};
  try { const raw = __saveRead(FILE); if (raw) map = JSON.parse(raw) || {}; } catch (e) { map = {}; }
  const flush = () => { try { __saveWrite(FILE, JSON.stringify(map)); } catch (e) {} };
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
    setItem: (k, v) => { map[String(k)] = String(v); flush(); },
    removeItem: (k) => { delete map[String(k)]; flush(); },
    clear: () => { map = {}; flush(); },
    key: (i) => Object.keys(map)[i] ?? null,
    get length() { return Object.keys(map).length; },
  };
})();
globalThis.localStorage = localStorage;

const base = { scene, input3d, env3d, input: input3d, env: env3d,
               // save/settings surface the engine's save.js + settings.js read:
               saveData:{}, saveMeta:{}, pendingSceneState:{}, saveHandler:null,
               // world.audio: settings.js apply() writes .musicVolume/.soundVolume
               // and calls setMuted() — drive the native miniaudio buses. (_music
               // is left undefined so apply's live-music tweak branch skips.)
               audio:{ _mv:0.6, _sv:1,
                 get musicVolume(){ return this._mv; }, set musicVolume(v){ this._mv=v; __setMusicVolume(v); },
                 get soundVolume(){ return this._sv; }, set soundVolume(v){ this._sv=v; __setSoundVolume(v); },
                 setMuted(m){ __setMuted(!!m); } },
               sceneFile:String(__entryScene()),
               // Resolve a scene name/file to its data.scenes key (mirrors world.js).
               resolveScene:(nameOrFile)=>{
                 if (nameOrFile == null) return null;
                 if (data.scenes[nameOrFile]) return nameOrFile;
                 const w = String(nameOrFile).toLowerCase();
                 for (const k of Object.keys(data.scenes)) {
                   const d = data.scenes[k];
                   if (d && d.name && String(d.name).toLowerCase() === w) return k;
                   if (k.toLowerCase().replace(/\.json$/, '') === w) return k;
                 }
                 return null;
               },
               // Multi-scene loader (mirrors world.js goToScene, minus inventory-
               // carry): unload the old scene, build the target, rehydrate, rebuild
               // the tick schedule, fire onLoad, and bump the epoch/instGen the
               // native renderer watches to rebuild its instances + scene visuals.
               goToScene:(nameOrFile)=>{
                 const file = base.resolveScene(nameOrFile);
                 if (!file) { console.log('[native] goToScene: no scene "' + nameOrFile + '"'); return false; }
                 if (file === base.sceneFile) return true;
                 try { dispatch(buildSchedule(scene.all()), 'onUnload'); } catch (e) {}
                 scene = new AE1Scene(data.scenes[file]);
                 scene.setWorld(world);
                 rehydrate(scene, classes);
                 scene.setWorld(world);   // rehydrate replaced instances — re-attach the world
                 base.sceneFile = file;
                 for (const el of scene.all())
                   if (el.mmPacks && !(el.autopilot === true || el.autopilot === 'true')) el.pivotAssist = 'true';
                 tables = buildSchedule(scene.all());
                 try { dispatch(buildSchedule(scene.all()), 'onLoad'); } catch (e) {}
                 globalThis.__sceneEpoch = (globalThis.__sceneEpoch | 0) + 1;
                 globalThis.__instGen = (globalThis.__instGen | 0) + 1;
                 return true;
               },
               // voices is SPREAD as an iterable ([...world.voices]) in the
               // voice-cleanup path — a plain {} is truthy but not iterable and
               // throws there, so it must be a real (empty) Set.
               voices:new Set(), js:{}, settings:{}, carried:[], carriedAux:[], uiLock:false,
               inventory:null,   // no inventory HUD natively — real null, not the truthy proxy
               // Real (empty/null) so member reads are FALSY — the deep proxy makes any
               // unknown world.X truthy, which silently fires code gated on it:
               //  · debugFlags.NOCLIP → player free-flies (§ native locomotion bug)
               //  · _camCurveActive   → camera thinks a cutscene curve owns it, pins to (0,0,0)
               //  · debugFlag(name)   → pause-menu's "default OFF" guard collapses,
               //    the menu goes live every frame and bricks on the first Esc
               //    (debugmenu.js, which installs this fn, is stubbed natively)
               debugFlags:{}, _camCurveActive:null,
               debugFlag:(n)=>!!base.debugFlags[String(n)],
               // element.find() tries `this.world.find(name)` FIRST (element.js),
               // so an absent world.find resolved to the truthy deep proxy and
               // EVERY find() in the engine returned the proxy, not the element —
               // this.find("DialogueUI") among them, which silently killed NPC
               // interaction. Provide the real lookup, and a null `hud` so the
               // engine's `?? this.world.hud?.findByName` fallthrough yields null
               // (not the proxy) for names that genuinely don't exist.
               find:(n)=>scene.findByName(String(n)) ?? null, hud:null,
               // §lost-in-translation: the browser's loop.dispatchTo routes a
               // mode to ONE element's handler — the trigger for onInteract
               // (talk to an NPC → openDialogue), onHit, onCall, onClick,
               // pickups. It was a no-op natively, so NPC dialogue could never
               // start (the DialogueUI's own tick already drives nav/confirm via
               // input3d, and thirdperson reads _ccSample for the cinematic
               // camera — only the trigger was missing). Mirror engine/loop.js
               // dispatchTo, reading the same schedule the native tick uses.
               loop:{ dispatchTo(element, mode, ...args) {
                 const entries = (typeof tables !== 'undefined') && tables[mode];
                 if (!entries) return [];
                 const out = [];
                 for (const entry of entries) {
                   if (entry.element !== element) continue;
                   try { out.push(element[entry.method](...args)); }
                   catch (e) { console.error(e); }
                 }
                 return out;
               },
                 // §rescan: the engine calls this after scene.add/remove (a fired
                 // round, an enemy wave, a spawned prop). Rebuild the tick schedule
                 // so the new element's onTick runs, and bump a generation the
                 // native renderer watches to add/drop its draw instance.
                 rescan() {
                   tables = buildSchedule(scene.all());
                   globalThis.__instGen = (globalThis.__instGen | 0) + 1;
                 } },
               mediaBase:'', mediaUrlFor:(n)=>'ae1://'+n,
               playSound:(n)=>__playSound(String(n)), playMusic:(n)=>__playMusic(String(n)),
               voiceLine:(n)=>__playSound(String(n)), playAudio:(n)=>__playSound(String(n)) };
const world = new Proxy(base, { get(t,k){ return (k in t) ? t[k] : deep; } });
)JS" /* split: keep each raw literal under MSVC's ~16 KB cap */ R"JS(
// ---- SAVE / SETTINGS: the real engine save.js + settings.js, run natively ---
// Same envelope + validation code as the browser (doctrine: never forked). The
// two host-specific pieces are provided behind the seam: durable slot files via
// __saveWrite (atomic), and localStorage (above) for the "continue" + settings
// slots. save.download()/pick() (DOM file I/O) are never reached — native
// saveGame writes the slot file directly.
const gameMeta = { id: data.gameId ?? data.id ?? null, title: data.title ?? null,
                   version: data.version ?? null, engine: "Angel's Egg", engineVersion: data.engine ?? null };
const _save = new AE1Save(world, { game: gameMeta,
  write: (d, name) => { __saveWrite(name, JSON.stringify(d, null, 2)); return Promise.resolve(); } });
const _settings = new AE1Settings(world, { game: gameMeta });
Object.defineProperty(base, 'settings', { get: () => _settings.values, configurable: true });
base.setSetting   = (k, v) => _settings.set(k, v);
base.resetSettings= () => _settings.reset();

// A save SLOT is a durable file: <slug-or-slot>.ae1save.json. The "continue"
// slot also mirrors to localStorage so it survives with the settings blob.
base.saveGame = (extra = {}) => {           // element.saveGame → autosave/quick slot + continue
  const slot = (extra && extra.slot) ? String(extra.slot) : 'quicksave';
  return base.saveToSlot(slot, extra);
};
base.saveToSlot = (slot, extra = {}) => {
  const data2 = _save.capture(extra);
  const name = String(slot).replace(/[^a-z0-9_\-]+/gi, '-') + SAVE_EXT;
  const ok = __saveWrite(name, JSON.stringify(data2, null, 2));   // atomic durable write
  _save.toLocal(data2);                                           // "continue" mirror
  return { ok: !!ok, name, slot: String(slot) };
};
base.loadSlot = (slot) => {
  const name = String(slot).replace(/[^a-z0-9_\-]+/gi, '-') + SAVE_EXT;
  let raw; try { raw = __saveRead(name); } catch (e) { raw = null; }
  if (!raw) return { ok: false, error: 'No save in slot "' + slot + '".' };
  let d; try { d = JSON.parse(raw); } catch (e) { return { ok: false, error: 'Save is not valid JSON.' }; }
  return _save.apply(d);
};
base.deleteSlot = (slot) => __saveDelete(String(slot).replace(/[^a-z0-9_\-]+/gi, '-') + SAVE_EXT);
base.listSaves = () => (__saveList() || []).map(f => ({
  slot: f.name.replace(/\.ae1save\.json$/i, ''), name: f.name, size: f.size, mtime: f.mtime }));
base.continueGame = () => { const d = _save.fromLocal(); return d ? _save.apply(d) : { ok: false, error: 'No save to continue from.' }; };
base.hasSavedGame = () => _save.hasLocal() || (__saveList() || []).length > 0;
base.loadGame = () => base.continueGame();   // no native file picker — Continue is the load path
globalThis.__save = _save; globalThis.__settings = _settings;   // debug/self-test reach

// ---- native save/load menu bridge (rendered by the C++ overlay) ------------
globalThis.__uiLock = (b) => { base.uiLock = !!b; };
// Rows for the menu as TSV ("slot\tsubtitle\n…"), so the C++ overlay needs no
// JSON parser. Subtitle parsed from each slot's envelope (time · scene · chapter).
globalThis.__saveMenuList = () => {
  return (base.listSaves() || []).map(s => {
    let sub = '';
    try {
      const d = JSON.parse(__saveRead(s.name) || '{}');
      const t  = d.saved ? String(d.saved).replace('T',' ').slice(0,16) : '';
      const sc = d.sceneName || '';
      const ch = (d.data && d.data.chapter != null) ? ('ch' + d.data.chapter) : '';
      sub = [t, sc, ch].filter(Boolean).join('  ·  ');
    } catch (e) {}
    return s.slot + '\t' + sub;
  }).join('\n');
};
// Perform a menu/quick action; returns a short toast string for the overlay.
globalThis.__saveAction = (verb, slot) => {
  try {
    if (verb === 'save')      { const r = base.saveToSlot(slot);      return r.ok ? ('Saved  ' + r.slot) : 'Save failed'; }
    if (verb === 'load')      { const r = base.loadSlot(slot);        return r.ok ? ('Loaded  ' + slot) : ('Load failed: ' + (r.error||'')); }
    if (verb === 'delete')    { return base.deleteSlot(slot) ? ('Deleted  ' + slot) : 'Delete failed'; }
    if (verb === 'quicksave') { const r = base.saveToSlot('quicksave'); return r.ok ? 'Quicksaved' : 'Quicksave failed'; }
    if (verb === 'quickload') { const r = base.loadSlot('quicksave');   return r.ok ? 'Quickloaded' : (r.error || 'No quicksave'); }
  } catch (e) { return 'Error: ' + (e && e.message || e); }
  return '';
};
)JS" /* split: MSVC caps a single string literal at ~16 KB; adjacent literals concatenate */ R"JS(
// fetch shim: resolve ae1:// URLs to pack bytes (the motion-matching matcher fetches
// its _motions.json / _poses.bin / _features.bin this way).
globalThis.fetch = (url) => {
  const nm = String(url).replace(/^ae1:\/\//, '');
  const NATIVE_DEQUANT = true;    // verified byte-correct vs JS dequant
  const bin = NATIVE_DEQUANT && (nm.endsWith('_poses.bin') || nm.endsWith('_features.bin'));
  return Promise.resolve({
    ok: true,
    arrayBuffer: () => Promise.resolve(bin ? __dequantAsset(nm) : __asset(nm)),
    json: () => { const j = JSON.parse(__assetText(nm));
      // Native dequant already produced float32 bins, so the matcher's JS
      // dequant() MUST see no `quant` metadata or it re-processes them (a 10s
      // double-dequant, and wrong bytes). `bin` is false here (this is the
      // .json, not a .bin), so gate on NATIVE_DEQUANT itself.
      if (NATIVE_DEQUANT && nm.endsWith('_motions.json')) delete j.quant;
      return Promise.resolve(j); },
    text: () => Promise.resolve(__assetText(nm)),
  });
};

// ---- the motion-matching skeleton bridge ----
// objectFor(el) hands the matcher a real bone graph (mirroring the glb nodes);
// the matcher poses it each tick; __rigWorldsArr reads the posed world matrices
// back so the native renderer can skin from them.
const __rigGraphs = new Map();
function buildBoneGraph(elId) {
  const nodes = __rigNodes(elId);
  if (!nodes || !nodes.length) return null;
  const objs = nodes.map(n => { const o = new Bone(); o.name = n.name;
    o.position.set(n.px, n.py, n.pz); o.quaternion.set(n.qx, n.qy, n.qz, n.qw); o.scale.set(n.sx, n.sy, n.sz); return o; });
  const roots = [];
  nodes.forEach((n, i) => { if (n.parent >= 0) objs[n.parent].add(objs[i]); else roots.push(objs[i]); });
  let root; if (roots.length === 1) root = roots[0];
  else { root = new Object3D(); root.name = '__rigRoot'; roots.forEach(r => root.add(r)); }
  root.__nodes = objs;   // node-order for readback
  return root;
}
globalThis.__objForCalls = 0; globalThis.__lastRigN = -1; globalThis.__lastRigId = '';
env3d.objectFor = (el) => {
  globalThis.__objForCalls++;
  if (!el || !el.id) return null;
  let g = __rigGraphs.get(el.id);
  if (!g) {                              // cache only SUCCESS — retry until instances exist
    g = buildBoneGraph(el.id);
    globalThis.__lastRigId = el.id; globalThis.__lastRigN = g ? g.__nodes.length : 0;
    if (g) __rigGraphs.set(el.id, g);
  }
  return g || null;
};
globalThis.__rigWorldsArr = (elId) => {
  const g = __rigGraphs.get(elId); if (!g) return null;
  g.updateMatrixWorld(true);
  const ns = g.__nodes; const out = new Array(ns.length * 16);
  for (let i = 0; i < ns.length; i++) { const e = ns[i].matrixWorld.elements; for (let k = 0; k < 16; k++) out[i*16+k] = e[k]; }
  return out;
};

// ---- bone physics (the browser's real bonephys.js, driven natively) ----
// glTF-anim NPCs (e.g. the Commander's sword sash) carry a components.model.
// bonePhys config but are skinned in C++ with no JS graph. Here we give them a
// JS bone graph, pose its LOCAL TRS from the native clip sample (__bonePhysStep
// gets it as a Float64Array), run the verlet spring sim, and the native side
// reads the physicked world matrices back to skin. Same sim as the browser.
const bonePhys = createBonePhys(THREE);
globalThis.__hasBonePhys = (elId) => {
  const el = scene.all().find(e => e.id === elId);
  return !!(el && el.components && el.components.model && el.components.model.bonePhys);
};
globalThis.__bonePhysStep = (elId, buf, dt) => {
  const el = scene.all().find(e => e.id === elId); if (!el) return false;
  const bp = el.components && el.components.model && el.components.model.bonePhys; if (!bp) return false;
  const g = env3d.objectFor(el); if (!g || !g.__nodes) return false;
  const L = new Float64Array(buf), ns = g.__nodes, n = Math.min(ns.length, L.length / 10);
  for (let i = 0; i < n; i++) { const o = i * 10;
    ns[i].position.set(L[o], L[o+1], L[o+2]);
    ns[i].quaternion.set(L[o+3], L[o+4], L[o+5], L[o+6]);
    ns[i].scale.set(L[o+7], L[o+8], L[o+9]); }
  bonePhys.step(el, g, bp, Math.min(dt, 0.05));
  return true;
};

const { classes } = compileAll(data.scripts);
rehydrate(scene, classes);
scene.setWorld(world);   // scene.world + every element's _world — so scene.add(round) at
                          // runtime hands the fresh element a real world too (spawned ammo, FX)
// §18.84: the player character's pack has no standing-turn frames — enable pivotAssist so the
// player can rotate to the wish-direction at rest (else she takes one step and
// jams). Harmless for packs that don't need it.
for (const el of scene.all())
  if (el.mmPacks && !(el.autopilot === true || el.autopilot === 'true')) el.pivotAssist = 'true';
let tables = buildSchedule(scene.all());   // `let`: loop.rescan rebuilds it when elements spawn/despawn

)JS" /* split: keep each raw literal under MSVC's ~16 KB cap */ R"JS(
// §rescan bridge: the native renderer watches __instGen and, when it changes,
// reconciles its draw list against __modelElements() — id\tmedia for every
// visible model-bearing element live in the scene (spawned rounds/props included).
globalThis.__instGen = 0;
globalThis.__instGenGet = () => globalThis.__instGen | 0;
globalThis.__modelElements = () => scene.all()
  .filter(e => e && e.visible !== false && e.components && e.components.model && e.components.model.media)
  .map(e => e.id + '\t' + e.components.model.media).join('\n');

// Particle FX: the native renderer owns the sim (as render3d does in the browser).
// Each row is the fx element's live config + a resolved WORLD anchor (element or
// host-element position + offset — the host node/bone frame is a later increment).
// id \t kind \t loop(0/1) \t burst \t scale \t colorHex \t anchored(0/1) \t ax \t ay \t az
globalThis.__fxElements = () => {
  const rows = [];
  for (const e of scene.all()) {
    const b = e && e.components && e.components.fx; if (!b) continue;
    const ox = +b.ox||0, oy = +b.oy||0, oz = +b.oz||0;
    let ax = 0, ay = 0, az = 0, anchored = 1;
    if (b.host) {
      const h = scene.all().find(x => x.name === b.host);
      if (!h || h.visible === false) anchored = 0;
      else {
        // ride a NODE/BONE of the host's rig (a weapon muzzle socket, a thruster
        // node) when named — else the host's origin. The host's bone graph:
        // MM chars pose it in WORLD space; a bpAnim/glTF char poses it glb-LOCAL
        // (so add the host's element position). Offset is in world axes (MVP).
        let placed = false;
        const g = (b.node && env3d.objectFor) ? env3d.objectFor(h) : null;
        if (g && g.__nodes) {
          try { g.updateMatrixWorld(true);
            const node = g.getObjectByName(String(b.node));
            if (node && node.getWorldPosition) {
              const wp = node.getWorldPosition(new THREE.Vector3());
              // offset in the NODE's frame (a muzzle's +Z points out the barrel)
              const wq = node.getWorldQuaternion(new THREE.Quaternion());
              const off = new THREE.Vector3(ox, oy, oz).applyQuaternion(wq);
              const world = !!h.mmPacks;   // MM graph is world-space; else glb-local
              const bx = world ? 0 : (+h.x||0), by = world ? 0 : (+h.y||0), bz = world ? 0 : (+h.z||0);
              ax = bx + wp.x + off.x; ay = by + wp.y + off.y; az = bz + wp.z + off.z; placed = true;
            }
          } catch (err) {}
        }
        if (!placed) { ax = (+h.x||0)+ox; ay = (+h.y||0)+oy; az = (+h.z||0)+oz; }
      }
    } else { ax = (+e.x||0)+ox; ay = (+e.y||0)+oy; az = (+e.z||0)+oz; }
    if (e.visible === false) anchored = 0;   // hidden emitter idles (particles fade out)
    rows.push([e.id, String(b.kind||'smoke'), (b.loop!==false)?1:0, (+b.burst||0),
               (+b.scale||1), String(b.color||''), anchored, ax, ay, az].join('\t'));
  }
  return rows.join('\n');
};
// Scatter (§18.23): one archetype element, many static render copies. Each row
// is "id \t snap(0/1) \t x,y,z,yaw,scale;..." — the archetype's own transform is
// read natively via jsXform(id); these are the per-copy offsets. The native
// renderer draws the archetype's meshes at each copy transform.
globalThis.__scatterElements = () => {
  const rows = [];
  for (const e of scene.all()) {
    if (!e || e.visible === false) continue;
    if (typeof e.spawnList !== 'function') continue;
    if (!(e.components && e.components.model && e.components.model.media)) continue;
    const list = e.spawnList(); if (!list || !list.length) continue;
    const snap = (e.spawnSnap === true || e.spawnSnap === 'true') ? 1 : 0;
    rows.push(e.id + '\t' + snap + '\t' + list.map(r => r.join(',')).join(';'));
  }
  return rows.join('\n');
};
// Debug (--scattertest): make the Commander a scatter archetype — a ring of
// render copies around her, to prove the native instancing path.
globalThis.__addScatterTest = () => {
  const c = scene.all().find(e => e.name === 'Commander'); if (!c) return 'no Commander';
  const rows = [];
  for (let i = 0; i < 16; i++) { const a = i/16*Math.PI*2;
    rows.push([Math.cos(a)*3.2, 0, Math.sin(a)*3.2 - 3, i*23, 0.55]); }
  c.spawns = rows; c.spawnList = () => rows; c.spawnSnap = false;
  return 'scattered ' + rows.length + ' copies around the Commander';
};
// Multi-scene: the native renderer watches __sceneEpoch and, on change, rebuilds
// its per-scene visuals (lighting, skybox, ground, camera, ids); the instances
// reconcile through __instGen (bumped by goToScene) like any spawn/despawn.
globalThis.__sceneEpoch = 0;
globalThis.__sceneEpochGet = () => globalThis.__sceneEpoch | 0;
globalThis.__sceneFileKey = () => String(base.sceneFile || '');
// Debug (--gotoscene): synthesize a small second scene at runtime (no re-export)
// — Skybox (brighter) + SunLight + the Commander moved — and register it so
// goToScene has a real target to switch to.
globalThis.__addTestScene = () => {
  const src = data.scenes[__entryScene()];
  const pick = (nm) => { for (const id of Object.keys(src.elements)) if (src.elements[id].name === nm)
                            return JSON.parse(JSON.stringify(src.elements[id])); return null; };
  const els = {};
  const add = (e, nid) => { if (!e) return; e.id = nid; e.parent = null; els[nid] = e; };
  add(pick('Skybox'), 's2-sky');
  add(pick('SunLight'), 's2-sun');
  const cmd = pick('Commander'); if (cmd) { cmd.x = 0; cmd.y = 0.2; cmd.z = -2; add(cmd, 's2-cmd'); }
  if (els['s2-sky']) els['s2-sky'].skyOpacity = 0.8;
  data.scenes['scene-test.json'] = { name: 'Bunker Hangar', elements: els };
  return 'scene-test.json';
};
globalThis.__gotoTestScene = () => {
  // toggle between the entry scene and the synthesized test scene, so a repeated
  // call stress-tests teardown/rebuild (GPU slot recycling)
  __addTestScene();
  const target = (base.sceneFile === 'scene-test.json') ? __entryScene() : 'scene-test.json';
  const ok = world.goToScene(target);
  return 'goToScene("' + target + '") -> ' + ok + '  now="' + base.sceneFile + '"  elems=' + scene.all().length;
};

let loaded = false;
globalThis.__errSeen = new Set();
globalThis.__errLog = [];
globalThis.__tick = (dt) => {
  const re = console.error;
  // §errscan: don't just drop tick errors — dedupe and keep the first of each,
  // so a silently-throwing feature (the bonephys.js:407 class of bug) surfaces
  // via __dumpErrs instead of vanishing. Cheap; the Set caps growth.
  console.error = (...a) => {
    const m = a.map(x => (x && x.stack) ? String(x.stack) : (x && x.message) ? x.message : String(x)).join(' ');
    if (!globalThis.__errSeen.has(m)) { globalThis.__errSeen.add(m); globalThis.__errLog.push(m); }
  };
  try {
    if (!loaded) { dispatch(tables, 'onLoad'); loaded = true; }
    dispatch(tables, 'onTick', dt);
  } finally { console.error = re; }
};
globalThis.__dumpErrs = () => globalThis.__errLog.join('\n---\n');
globalThis.__xform = (id) => {
  const e = scene.get(id);
  if (!e) return null;
  return [e.x||0, e.y||0, e.z||0, e.rotationX||0, e.rotationY||0, e.rotation||0,
          (e.scaleX==null?1:e.scaleX), (e.scaleY==null?1:e.scaleY), (e.scaleZ==null?1:e.scaleZ),
          e.rotationOrder === 'YXZ' ? 1 : 0];
};
// one-shot: how many onTick handlers run cleanly (proof the real modules execute)
globalThis.__diag = () => {
  let threw = 0; const msgs = []; const re = console.error;
  console.error = (...a) => { threw++; if (msgs.length < 4) msgs.push(a.map(x => (x && x.message) ? x.message : String(x)).join(' ')); };
  let ran = 0; try { ran = dispatch(tables, 'onTick', 1/60).length; } finally { console.error = re; }
  return ran + '/' + ((tables.onTick||[]).length) + ' onTick ran, ' + threw + ' threw'
       + (msgs.length ? '  ::  ' + msgs.join('  |  ') : '');
};
globalThis.__mmDump = () => scene.all().filter(e => e.mmPacks).map(e =>
  e.name + '(auto=' + e.autopilot + ') @(' + (e.x||0).toFixed(2) + ',' + (e.z||0).toFixed(2) + ') mm=' +
  (e._mm ? 'Y' : (e._mmError ? 'ERR' : '-'))).join('  |  ');
globalThis.__ctrlDump = () => {
  const p = scene.all().find(e => e.mmPacks && !(e.autopilot === true || e.autopilot === 'true'));
  const cam = scene.all().find(e => e instanceof AE1ThirdPersonCamera);
  const mm = p && p._mm;
  return 'player=' + (p && p.name) + ' KeyW=' + input3d.down('KeyW') + ' camYaw=' + (cam ? (cam._yaw||0).toFixed(1) : '?')
       + ' @(' + (p ? (p.x||0).toFixed(2) + ',' + (p.z||0).toFixed(2) : '?') + ')'
       + (mm ? ' state=' + mm.state + ' speed=' + mm.speed.toFixed(2) + ' clip=' + (mm.clip && mm.clip.name) + '@' + (mm.clip && mm.clip.frame) + ' req=' + (mm.reqDebug ? (mm.reqDebug.req||0).toFixed(2) : '?') : ' mm=-');
};
globalThis.__moverId = () => {   // the MM char currently farthest from origin (the one walking)
  let best = null, bd = -1;
  for (const e of scene.all()) { if (!e.mmPacks) continue; const d = (e.x||0)*(e.x||0) + (e.z||0)*(e.z||0); if (d > bd) { bd = d; best = e; } }
  return best ? best.id : '';
};
globalThis.__lightInfo = () => {   // the scene's directional light -> travel dir + color*intensity + ambient
  const L = scene.all().find(e => e.color && e.intensity != null && (e.lightType === undefined || e.lightType === 'sun' || e.lightType === 'directional'));
  if (!L) return null;
  const y = L.y || 0;
  let dx = -3, dy = -y, dz = -4;                 // render3d aims pos -> (x-3,0,z-4)
  const len = Math.hypot(dx, dy, dz) || 1; dx /= len; dy /= len; dz /= len;
  let c = String(L.color || '#ffffff').replace('#', ''); if (c.length === 3) c = c.split('').map(h => h + h).join('');
  const r = parseInt(c.slice(0,2),16)/255, g = parseInt(c.slice(2,4),16)/255, b = parseInt(c.slice(4,6),16)/255;
  const k = Math.min(1.0, ((Number(L.intensity) || 2.2) / 2.2) * 0.9);
  const fill = Number(L.fill) || 0;
  return [dx, dy, dz, r*k, g*k, b*k, 0.32 + fill*0.4];
};
// Debug (--savetest <write|read|full>): exercise the durable save path.
//  write → set a saveData bag + save the 'demo' slot (proves atomic file write)
//  read  → load the 'demo' slot into a wiped world (proves cross-process durability)
//  full  → both in one process
globalThis.__saveSelfTest = (mode) => {
  mode = String(mode || 'full');
  const out = { mode };
  if (mode === 'write' || mode === 'full') {
    world.saveData = { chapter: 7, checkpoint: 'bunker-uplink', pos: [3, 0.2, -3],
                       flags: { metNines: true, sashFixed: true }, note: 'beast save' };
    out.write = base.saveToSlot('demo', { playtimeSec: 123 });
    out.list  = base.listSaves();
    base.setSetting('musicVolume', 0.33);        // settings are separate from saves
    base.setSetting('difficulty', 'beast');
  }
  if (mode === 'read' || mode === 'full') {
    world.saveData = {};                          // wipe in-memory before loading from disk
    out.load = base.loadSlot('demo');
    out.restored = world.saveData;
    out.settings = { musicVolume: base.settings.musicVolume, difficulty: base.settings.difficulty };
    out.hasContinue = base.hasSavedGame();
  }
  return JSON.stringify(out);
};
// Debug (--spawntest <name>): clone a model element at runtime and scene.add +
// rescan it — the same path a fired round / spawned prop takes. Proves the
// native renderer picks up runtime spawns (tick via rescan, draw via reconcile).
globalThis.__spawnTest = (srcName, dx) => {
  const src = scene.all().find(e => e.name === srcName);
  if (!src || !src.serialize) return 'no serializable element named ' + srcName;
  const d = src.serialize(); delete d.id; d.name = srcName + ' clone';
  d.x = (Number(src.x) || 0) + (Number(dx) || 2);
  const clone = new src.constructor(d);
  clone._spawned = true;
  scene.add(clone);
  if (world.loop && world.loop.rescan) world.loop.rescan();
  const ticks = (tables.onTick || []).some(e => e.element === clone);
  return 'spawned ' + clone.id + ' at x=' + clone.x + '  inTickTable=' + ticks + '  sceneN=' + scene.all().length;
};
// Debug (--fxtest <kind>): spawn a visible LOOPING particle emitter at a fixed
// spot (no host → anchors to its own position), to prove the native particle sim.
)JS" /* split: keep each raw literal under MSVC's ~16 KB cap */ R"JS(
globalThis.__fxTest = (kind) => {
  const proto = scene.all().find(e => e.components && e.components.fx);
  if (!proto) return 'no Particles element to clone';
  const d = proto.serialize(); delete d.id; d.name = 'FxTest';
  d.x = 0; d.y = 0.6; d.z = 2;
  const el = new proto.constructor(d);
  el.visible = true;
  scene.add(el);
  el.setComponent('fx', 'kind', String(kind || 'flame'));
  el.setComponent('fx', 'loop', true);
  el.setComponent('fx', 'host', '');
  el.setComponent('fx', 'scale', 1);
  if (world.loop && world.loop.rescan) world.loop.rescan();
  return 'fx emitter spawned kind=' + (kind||'flame') + ' at (0,0.6,2)';
};
// Debug (--fxbonetest): anchor a looping flame to a BONE of the Commander (her
// highest bone — head) to prove host-node/bone anchoring (the flame rides the
// bone, not the element origin).
globalThis.__addFxBoneTest = () => {
  const c = scene.all().find(e => e.name === 'Commander'); if (!c) return 'no Commander';
  const g = env3d.objectFor(c); if (!g || !g.__nodes) return 'no rig graph for Commander (bonephys not stepped yet?)';
  g.updateMatrixWorld(true);
  let best = null, bestY = -1e9;
  for (const n of g.__nodes) { const wp = n.getWorldPosition(new THREE.Vector3()); if (wp.y > bestY) { bestY = wp.y; best = n; } }
  if (!best) return 'no bone';
  const proto = scene.all().find(e => e.components && e.components.fx); if (!proto) return 'no Particles proto';
  const d = proto.serialize(); delete d.id; d.name = 'FxBoneTest';
  const el = new proto.constructor(d); el.visible = true; scene.add(el);
  el.setComponent('fx', 'kind', 'flame'); el.setComponent('fx', 'loop', true);
  el.setComponent('fx', 'host', c.name); el.setComponent('fx', 'node', best.name);
  el.setComponent('fx', 'scale', 1.4);
  if (world.loop && world.loop.rescan) world.loop.rescan();
  return 'fx on Commander bone "' + best.name + '" (localY=' + bestY.toFixed(2) + ')';
};
// The DialogueUI's current state, or null: { speaker, text, options:[label...], sel }.
// The DialogueUI element runs natively (its DOM render no-ops), so _dlg is live.
globalThis.__dlgInfo = () => {
  const ui = scene.all().find(e => e._dlg && e._dlg.tree);
  const d = ui && ui._dlg; if (!d) return null;
  const node = d.tree[d.node]; if (!node) return null;
  return { speaker: d.npc ? String(d.npc.displayName || d.npc.name || '') : '',
           text: String(node.text || ''),
           options: (node.options || []).map(o => String(o.label || '...')),
           sel: d.sel | 0 };
};
// Debug (--talk): simulate the player interacting with a named element, the
// same path the E key drives (thirdperson → world.loop.dispatchTo onInteract).
// Returns a short status so the harness can confirm the dialogue opened.
globalThis.__debugTalk = (nm) => {
  const target = scene.all().find(e => e.name === nm);
  if (!target) return 'no target named ' + nm;
  const player = scene.all().find(e => e.mmPacks && !(e.autopilot === true || e.autopilot === 'true'))
              || scene.all().find(e => e.name === 'the player character');
  if (!player) return 'no player';
  try { world.loop.dispatchTo(target, 'onInteract', player); }
  catch (e) { return 'onInteract threw: ' + (e && e.stack || e); }
  const info = __dlgInfo();
  return info ? ('dlg OPEN speaker="' + info.speaker + '" opts=' + info.options.length) : 'no _dlg after onInteract';
};
// The scene's Skybox element: [equirect media name, opacity, rotationRad, envIntensity].
globalThis.__skyInfo = () => {
  const s = scene.all().find(e => e.sky || e.name === 'Skybox');
  if (!s || !s.sky) return null;
  return [String(s.sky), Number(s.skyOpacity) || 0.45,
          (Number(s.skyRotation) || 0) * Math.PI / 180, Number(s.envIntensity) || 0.3];
};
globalThis.__camId = () => { const c = scene.all().find(e => e instanceof AE1ThirdPersonCamera); return c ? c.id : ''; };
// The REAL third-person camera's live transform: eye (its own damped position),
// a forward unit vector from its _yaw/_pitch (the AE1 orbit convention: eye sits
// at look + (sinYaw·cosPitch, sinPitch, cosYaw·cosPitch)·d, so forward = -that),
// and vertical fov in degrees. The native renderer builds its view from THIS
// instead of a hand-rolled orbit — same camera the character steers against.
globalThis.__camView = () => {
  const c = scene.all().find(e => e instanceof AE1ThirdPersonCamera);
  if (!c || c.x == null) return null;
  const D = Math.PI / 180, yaw = (c._yaw || 0) * D, pitch = (c._pitch || 0) * D;
  const cp = Math.cos(pitch);
  return [c.x, c.y, c.z,
          -Math.sin(yaw) * cp, -Math.sin(pitch), -Math.cos(yaw) * cp,
          Number(c.fov) || Number(c.fovBase) || 48];
};
globalThis.__playerId = () => {
  const p = scene.all().find(e => (e.name === 'the player character' || e.name === 'Player') && e.mmPacks);
  if (p) return p.id;
  const m = scene.all().find(e => e.mmPacks && !(e.autopilot === true || e.autopilot === 'true'));
  return m ? m.id : '';
};
// every MM character has finished building (its matcher OR a hard error) — the
// warm-cache pass ticks until this, so it exits the instant the caches are written.
globalThis.__mmAllReady = () => { const cs = scene.all().filter(e => e.mmPacks); return cs.length > 0 && cs.every(e => e._mm || e._mmError); };
globalThis.__mmStatus = () => {
  const info = ' [objectFor calls=' + globalThis.__objForCalls + ', last rig ' + globalThis.__lastRigId + ' nodes=' + globalThis.__lastRigN + ']';
  const c = globalThis.__mmChar;
  if (!c) return 'no MM char (objectFor never gave a rig / _mmInit not reached)' + info;
  if (c._mmError) return 'MM ERROR: ' + (c._mmError && c._mmError.message ? c._mmError.message : c._mmError);
  if (c._mm) return 'MM BUILT — matcher ready, driving ' + (c.name || '?');
  if (c._mmLoading) return 'MM loading (async build in flight)';
  return 'MM char present, init not started';
};
console.log('engine hosted (real element modules): ' + scene.size + ' elements, ' + classes.size + ' classes');
)JS";

// ---- calling into JS --------------------------------------------------------
static void jsTick(JSContext* ctx, JSRuntime* rt, double dt) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue fn = JS_GetPropertyStr(ctx, g, "__tick");
    JSValue arg = JS_NewFloat64(ctx, dt);
    JSValue r = JS_Call(ctx, fn, g, 1, &arg);
    JS_FreeValue(ctx, r); JS_FreeValue(ctx, arg); JS_FreeValue(ctx, fn); JS_FreeValue(ctx, g);
    JSContext* c1; while (JS_ExecutePendingJob(rt, &c1) > 0) {}
}
static std::string jsCallStr(JSContext* ctx, const char* fn) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue f = JS_GetPropertyStr(ctx, g, fn);
    JSValue r = JS_Call(ctx, f, g, 0, nullptr);
    std::string out; const char* s = JS_ToCString(ctx, r);
    if (s) { out = s; JS_FreeCString(ctx, s); }
    JS_FreeValue(ctx, r); JS_FreeValue(ctx, f); JS_FreeValue(ctx, g);
    return out;
}
static bool jsXform(JSContext* ctx, const std::string& id, double out[10]) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue fn = JS_GetPropertyStr(ctx, g, "__xform");
    JSValue idv = JS_NewString(ctx, id.c_str());
    JSValue arr = JS_Call(ctx, fn, g, 1, &idv);
    bool ok = JS_IsObject(arr);
    if (ok) for (int k = 0; k < 10; k++) {
        JSValue e = JS_GetPropertyUint32(ctx, arr, k);
        double d = 0; JS_ToFloat64(ctx, &d, e); out[k] = d; JS_FreeValue(ctx, e);
    }
    JS_FreeValue(ctx, arr); JS_FreeValue(ctx, idv); JS_FreeValue(ctx, fn); JS_FreeValue(ctx, g);
    return ok;
}

struct Instance {
    std::string id;
    std::vector<MeshHandle> meshes;
    std::vector<TexHandle> texes;
    std::vector<float> cutoffs;     // parallel to meshes: alpha-test threshold
    GlbRig* rig = nullptr;          // non-null => posable (animated or skinned)
    int anim = -1;                  // glTF clip index, or -1
    std::vector<CpuMesh> cpu;       // kept for re-posing
    float bindH = 0.0f;             // bind-pose height (glb-local), for the scale rule
    bool bpAnim = false;            // glTF-anim char with bone physics (JS-graph route)
    bool hidden = false;            // reconcile: element left the scene — skip it, keep the slot
    bool shared = false;            // static mesh handles owned by the media cache, not this inst
    std::string media;              // media name (shared insts) — for cache ref-counting on teardown
    std::vector<bool> transparent;  // parallel to meshes (reconcile insts have no cpu to read it from)
};

// element id -> instance, so the motion-matching skeleton bridge can find a rig.
static std::vector<Instance>* g_insts = nullptr;
static Instance* instById(const std::string& id) {
    if (!g_insts) return nullptr;
    for (auto& in : *g_insts) if (in.id == id) return &in;
    return nullptr;
}
// __rigNodes(id) -> [{name,parent,px..sz}] : the bone hierarchy JS builds a graph from.
static JSValue js_rigNodes(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1) return JS_NULL;
    const char* n = JS_ToCString(ctx, argv[0]); if (!n) return JS_NULL;
    Instance* inst = instById(n); JS_FreeCString(ctx, n);
    if (!inst || !inst->rig) return JS_NULL;
    int nc = rigNodeCount(inst->rig);
    JSValue arr = JS_NewArray(ctx);
    const char* keys[10] = { "px","py","pz","qx","qy","qz","qw","sx","sy","sz" };
    for (int i = 0; i < nc; i++) {
        double b[10]; rigNodeBind(inst->rig, i, b);
        JSValue o = JS_NewObject(ctx);
        std::string nm = rigNodeName(inst->rig, i);
        JS_SetPropertyStr(ctx, o, "name", JS_NewString(ctx, nm.c_str()));
        JS_SetPropertyStr(ctx, o, "parent", JS_NewInt32(ctx, rigNodeParent(inst->rig, i)));
        for (int k = 0; k < 10; k++) JS_SetPropertyStr(ctx, o, keys[k], JS_NewFloat64(ctx, b[k]));
        JS_SetPropertyUint32(ctx, arr, (uint32_t)i, o);
    }
    return arr;
}
// Ground raycast: world-space (render) triangles of the static meshes, and a
// vertical ray-down query. Real terrain instead of the flat-0 stub.
static std::vector<float> g_groundTris;   // 9 floats/tri (render space)
// Ray-down ground height at engine (x,z): the highest static tri below `from`.
// Shared by the groundAt seam and the scatter snap. Returns 0 (flat) on a miss.
static double groundAtXZ(double x, double z, double from) {
    float rx = (float)x, rz = -(float)z;   // engine -> render (Z flip)
    float best = 0.0f; bool hit = false;
    const std::vector<float>& T = g_groundTris;
    for (size_t i = 0; i + 8 < T.size(); i += 9) {
        float ax=T[i],ay=T[i+1],az=T[i+2], bx=T[i+3],by=T[i+4],bz=T[i+5], cx=T[i+6],cy=T[i+7],cz=T[i+8];
        float d = (bz-cz)*(ax-cx) + (cx-bx)*(az-cz);
        if (std::fabs(d) < 1e-9f) continue;
        float w1 = ((bz-cz)*(rx-cx) + (cx-bx)*(rz-cz)) / d;
        float w2 = ((cz-az)*(rx-cx) + (ax-cx)*(rz-cz)) / d;
        float w3 = 1 - w1 - w2;
        if (w1 < -1e-3f || w2 < -1e-3f || w3 < -1e-3f) continue;   // outside triangle (XZ)
        float y = w1*ay + w2*by + w3*cy;
        if (y <= from + 0.05f && (!hit || y > best)) { best = y; hit = true; }
    }
    return hit ? best : 0.0;
}
static JSValue js_groundAt(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    double x = 0, z = 0, from = 1e18;
    if (argc > 0) JS_ToFloat64(ctx, &x, argv[0]);
    if (argc > 1) JS_ToFloat64(ctx, &z, argv[1]);
    if (argc > 2) JS_ToFloat64(ctx, &from, argv[2]);
    return JS_NewFloat64(ctx, groundAtXZ(x, z, from));
}

// ---- durable save store: JS ↔ the platform's atomic file storage -----------
// g_savesDir is <agp>/saves. Names passed from JS are single path segments
// (a slot file or the localStorage blob); we never let one escape the dir.
static std::string g_savesDir;
static bool safeSaveName(const char* n, std::string& out) {
    if (!n || !*n) return false;
    out = n;
    if (out.find("..") != std::string::npos || out.find('/') != std::string::npos
        || out.find('\\') != std::string::npos || out.find(':') != std::string::npos) return false;
    return true;
}
static JSValue js_saveWrite(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 2 || g_savesDir.empty()) return JS_FALSE;
    const char* n = JS_ToCString(ctx, argv[0]); std::string name;
    bool okn = safeSaveName(n, name); if (n) JS_FreeCString(ctx, n);
    if (!okn) return JS_FALSE;
    size_t len = 0; const char* body = JS_ToCStringLen(ctx, &len, argv[1]);
    if (!body) return JS_FALSE;
    bool ok = ae1::storeWriteAtomic(g_savesDir + "/" + name, std::string(body, len));
    JS_FreeCString(ctx, body);
    return ok ? JS_TRUE : JS_FALSE;
}
static JSValue js_saveRead(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1 || g_savesDir.empty()) return JS_NULL;
    const char* n = JS_ToCString(ctx, argv[0]); std::string name;
    bool okn = safeSaveName(n, name); if (n) JS_FreeCString(ctx, n);
    if (!okn) return JS_NULL;
    std::string body;
    if (!ae1::storeRead(g_savesDir + "/" + name, body)) return JS_NULL;
    return JS_NewStringLen(ctx, body.data(), body.size());
}
static JSValue js_saveDelete(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1 || g_savesDir.empty()) return JS_FALSE;
    const char* n = JS_ToCString(ctx, argv[0]); std::string name;
    bool okn = safeSaveName(n, name); if (n) JS_FreeCString(ctx, n);
    if (!okn) return JS_FALSE;
    return ae1::storeDelete(g_savesDir + "/" + name) ? JS_TRUE : JS_FALSE;
}
static JSValue js_saveList(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    JSValue arr = JS_NewArray(ctx);
    if (g_savesDir.empty()) return arr;
    auto files = ae1::storeList(g_savesDir, ".ae1save.json");
    for (uint32_t i = 0; i < files.size(); i++) {
        JSValue o = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, o, "name", JS_NewString(ctx, files[i].name.c_str()));
        JS_SetPropertyStr(ctx, o, "size", JS_NewInt64(ctx, (int64_t)files[i].size));
        JS_SetPropertyStr(ctx, o, "mtime", JS_NewFloat64(ctx, files[i].mtimeMs));
        JS_SetPropertyUint32(ctx, arr, i, o);
    }
    return arr;
}

// Save/load menu: call the JS bridges. List returns TSV rows (slot\tsub\n…).
static std::string jsSaveMenuList(JSContext* ctx) {
    JSValue g = JS_GetGlobalObject(ctx), fn = JS_GetPropertyStr(ctx, g, "__saveMenuList");
    JSValue r = JS_Call(ctx, fn, g, 0, nullptr); const char* s = JS_ToCString(ctx, r);
    std::string out = s ? s : ""; if (s) JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, r); JS_FreeValue(ctx, fn); JS_FreeValue(ctx, g); return out;
}
static std::string jsSaveAction(JSContext* ctx, const char* verb, const std::string& slot) {
    JSValue g = JS_GetGlobalObject(ctx), fn = JS_GetPropertyStr(ctx, g, "__saveAction");
    JSValue a[2] = { JS_NewString(ctx, verb), JS_NewString(ctx, slot.c_str()) };
    JSValue r = JS_Call(ctx, fn, g, 2, a); const char* s = JS_ToCString(ctx, r);
    std::string out = s ? s : ""; if (s) JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, r); JS_FreeValue(ctx, a[0]); JS_FreeValue(ctx, a[1]);
    JS_FreeValue(ctx, fn); JS_FreeValue(ctx, g); return out;
}
static void jsSetUiLock(JSContext* ctx, bool b) {
    JSValue g = JS_GetGlobalObject(ctx), fn = JS_GetPropertyStr(ctx, g, "__uiLock");
    JSValue a = JS_NewBool(ctx, b); JSValue r = JS_Call(ctx, fn, g, 1, &a);
    JS_FreeValue(ctx, r); JS_FreeValue(ctx, a); JS_FreeValue(ctx, fn); JS_FreeValue(ctx, g);
}

// Call JS __rigWorldsArr(id); read the posed node world matrices into `out`.
static bool jsRigWorlds(JSContext* ctx, const std::string& id, std::vector<double>& out) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue fn = JS_GetPropertyStr(ctx, g, "__rigWorldsArr");
    JSValue idv = JS_NewString(ctx, id.c_str());
    JSValue arr = JS_Call(ctx, fn, g, 1, &idv);
    bool ok = JS_IsObject(arr);
    if (ok) {
        JSValue lenv = JS_GetPropertyStr(ctx, arr, "length");
        uint32_t len = 0; JS_ToUint32(ctx, &len, lenv); JS_FreeValue(ctx, lenv);
        out.resize(len);
        for (uint32_t i = 0; i < len; i++) {
            JSValue e = JS_GetPropertyUint32(ctx, arr, i);
            double d = 0; JS_ToFloat64(ctx, &d, e); out[i] = d; JS_FreeValue(ctx, e);
        }
    }
    JS_FreeValue(ctx, arr); JS_FreeValue(ctx, idv); JS_FreeValue(ctx, fn); JS_FreeValue(ctx, g);
    return ok && !out.empty();
}
// Does the element carry a components.model.bonePhys config?
static bool jsHasBonePhys(JSContext* ctx, const std::string& id) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue fn = JS_GetPropertyStr(ctx, g, "__hasBonePhys");
    JSValue idv = JS_NewString(ctx, id.c_str());
    JSValue r = JS_Call(ctx, fn, g, 1, &idv);
    bool ok = JS_ToBool(ctx, r) > 0;
    JS_FreeValue(ctx, r); JS_FreeValue(ctx, idv); JS_FreeValue(ctx, fn); JS_FreeValue(ctx, g);
    return ok;
}
// Push animated local TRS into the element's JS bone graph and run the verlet
// bone-physics sim on it (leaves the graph posed for a jsRigWorlds readback).
static void jsBonePhysStep(JSContext* ctx, const std::string& id, const std::vector<double>& locals, double dt) {
    JSValue g = JS_GetGlobalObject(ctx);
    JSValue fn = JS_GetPropertyStr(ctx, g, "__bonePhysStep");
    JSValue buf = JS_NewArrayBufferCopy(ctx, (const uint8_t*)locals.data(), locals.size() * sizeof(double));
    JSValue idv = JS_NewString(ctx, id.c_str());
    JSValue dtv = JS_NewFloat64(ctx, dt);
    JSValue argv[3] = { idv, buf, dtv };
    JSValue r = JS_Call(ctx, fn, g, 3, argv);
    JS_FreeValue(ctx, r); JS_FreeValue(ctx, dtv); JS_FreeValue(ctx, idv); JS_FreeValue(ctx, buf); JS_FreeValue(ctx, fn); JS_FreeValue(ctx, g);
}

static bool fileExists(const std::string& p) { std::ifstream f(p); return (bool)f; }
static std::string slashes(std::string s) { for (auto& c : s) if (c == '\\') c = '/'; while (!s.empty() && s.back() == '/') s.pop_back(); return s; }

// ---- native UI text (glyph-quad emitters over the 2D overlay) --------------
using OV = Gfx::Overlay2DVert;
static void emitRect(std::vector<OV>& v, float x, float y, float w, float h,
                     float r, float g, float b, float a) {
    OV q[6] = { {x,y,0,0,r,g,b,a}, {x+w,y,1,0,r,g,b,a}, {x,y+h,0,1,r,g,b,a},
                {x+w,y,1,0,r,g,b,a}, {x+w,y+h,1,1,r,g,b,a}, {x,y+h,0,1,r,g,b,a} };
    for (auto& e : q) v.push_back(e);
}
static float textWidth(const GlyphAtlas& f, const std::string& s, float scale) {
    float w = 0; for (unsigned char c : s) if (c >= 32 && c < 127) w += f.glyph[c-32].xadv * scale;
    return w;
}
// Emit `s` with top-left at (x,y). Returns the pen x after the string.
static float emitText(std::vector<OV>& v, const GlyphAtlas& f, float x, float y, float scale,
                      const std::string& s, float r, float g, float b, float a) {
    float px = x, baseY = y + f.ascent * scale;
    for (unsigned char c : s) {
        if (c < 32 || c >= 127) { px += f.glyph['n'-32].xadv * scale * 0.4f; continue; }
        const GlyphAtlas::G& gl = f.glyph[c-32];
        float x0 = px + gl.xoff*scale, y0 = baseY + gl.yoff*scale, x1 = x0 + gl.w*scale, y1 = y0 + gl.h*scale;
        OV q[6] = { {x0,y0,gl.u0,gl.v0,r,g,b,a}, {x1,y0,gl.u1,gl.v0,r,g,b,a}, {x0,y1,gl.u0,gl.v1,r,g,b,a},
                    {x1,y0,gl.u1,gl.v0,r,g,b,a}, {x1,y1,gl.u1,gl.v1,r,g,b,a}, {x0,y1,gl.u0,gl.v1,r,g,b,a} };
        for (auto& e : q) v.push_back(e);
        px += gl.xadv * scale;
    }
    return px;
}
// Greedy word-wrap `s` to `maxW`, emitting each line; returns the y after.
static float emitWrapped(std::vector<OV>& v, const GlyphAtlas& f, float x, float y, float scale,
                         const std::string& s, float maxW, float lineH, float r, float g, float b, float a) {
    std::string line, word;
    auto flush = [&](){ emitText(v, f, x, y, scale, line, r, g, b, a); y += lineH; line.clear(); };
    for (size_t i = 0; i <= s.size(); i++) {
        char c = i < s.size() ? s[i] : ' ';
        if (c == ' ' || c == '\n') {
            std::string trial = line.empty() ? word : line + " " + word;
            if (textWidth(f, trial, scale) > maxW && !line.empty()) { flush(); line = word; }
            else line = trial;
            word.clear();
            if (c == '\n') flush();
        } else word += c;
    }
    if (!line.empty()) { emitText(v, f, x, y, scale, line, r, g, b, a); y += lineH; }
    return y;
}

// ---- minimal PNG writer (RGBA8, stored/uncompressed zlib) — headless capture --
static void pngU32(std::vector<uint8_t>& v, uint32_t x){ v.push_back((uint8_t)(x>>24)); v.push_back((uint8_t)(x>>16)); v.push_back((uint8_t)(x>>8)); v.push_back((uint8_t)x); }
static uint32_t pngCrc(const uint8_t* d, size_t n){ uint32_t c=0xFFFFFFFFu; for(size_t i=0;i<n;i++){ c^=d[i]; for(int k=0;k<8;k++) c=(c&1)?(c>>1)^0xEDB88320u:(c>>1); } return c^0xFFFFFFFFu; }
static void pngChunk(std::vector<uint8_t>& out, const char* t, const std::vector<uint8_t>& data){
    pngU32(out,(uint32_t)data.size()); size_t s=out.size();
    out.push_back(t[0]);out.push_back(t[1]);out.push_back(t[2]);out.push_back(t[3]);
    out.insert(out.end(),data.begin(),data.end());
    pngU32(out, pngCrc(&out[s], out.size()-s));
}
static bool writePng(const std::string& path, const uint8_t* rgba, int w, int h){
    std::vector<uint8_t> out={137,80,78,71,13,10,26,10}, ihdr;
    pngU32(ihdr,(uint32_t)w); pngU32(ihdr,(uint32_t)h); ihdr.push_back(8); ihdr.push_back(6); ihdr.push_back(0); ihdr.push_back(0); ihdr.push_back(0);
    pngChunk(out,"IHDR",ihdr);
    std::vector<uint8_t> raw; raw.reserve((size_t)h*(1+(size_t)w*4));
    for(int y=0;y<h;y++){ raw.push_back(0); raw.insert(raw.end(), rgba+(size_t)y*w*4, rgba+(size_t)(y+1)*w*4); }
    std::vector<uint8_t> z={0x78,0x01}; size_t off=0;
    while(off<raw.size()){ size_t n=raw.size()-off; if(n>65535) n=65535; bool last=(off+n>=raw.size());
        z.push_back(last?1:0); z.push_back((uint8_t)(n&0xff)); z.push_back((uint8_t)((n>>8)&0xff));
        uint16_t nl=(uint16_t)~n; z.push_back((uint8_t)(nl&0xff)); z.push_back((uint8_t)((nl>>8)&0xff));
        z.insert(z.end(), raw.begin()+off, raw.begin()+off+n); off+=n; }
    uint32_t a=1,b=0; for(size_t i=0;i<raw.size();i++){ a=(a+raw[i])%65521; b=(b+a)%65521; } pngU32(z,(b<<16)|a);
    pngChunk(out,"IDAT",z); pngChunk(out,"IEND",{});
    FILE* f=fopen(path.c_str(),"wb"); if(!f) return false;
    fwrite(out.data(),1,out.size(),f); fclose(f); return true;
}

// ---- motion-matching gait-table warm cache -------------------------------------
// The matcher's LOOKAHEAD gait tables (8 typed arrays per locomotion table) cost
// ~6s to precompute in QuickJS and are deterministic from the pack set. Cache
// them on disk keyed by pack identity: first run computes+writes, later runs
// read. The browser has no __gait* globals, so it always computes (the hook in
// the motion-matching core (not in the public build) is a no-op there). The matcher stays the source of truth — the
// cached bytes are exactly what its own loop produced.
static std::string g_gaitDir;
static FILE* g_gaitFile = nullptr;
static int g_gaitMode = 0;              // 0 none, 1 read, 2 write
static std::string g_gaitFinal, g_gaitTmp;
static uint64_t fnv1a(const std::string& s) {
    uint64_t h = 1469598103934665603ULL;
    for (unsigned char c : s) { h ^= c; h *= 1099511628211ULL; }
    return h;
}
// raw bytes of a JS TypedArray arg (nullptr on failure)
static uint8_t* taBytes(JSContext* ctx, JSValueConst v, size_t* outLen) {
    size_t off = 0, len = 0, bpe = 0;
    JSValue ab = JS_GetTypedArrayBuffer(ctx, v, &off, &len, &bpe);
    if (JS_IsException(ab)) { JS_FreeValue(ctx, ab); return nullptr; }
    size_t absz = 0; uint8_t* p = JS_GetArrayBuffer(ctx, &absz, ab);
    JS_FreeValue(ctx, ab);
    if (!p) return nullptr;
    *outLen = len; return p + off;
}
static JSValue js_gaitOpen(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (g_gaitFile) { fclose(g_gaitFile); g_gaitFile = nullptr; } g_gaitMode = 0;
    if (argc < 1 || g_gaitDir.empty()) return JS_FALSE;
    const char* key = JS_ToCString(ctx, argv[0]); if (!key) return JS_FALSE;
    std::string ks(key); JS_FreeCString(ctx, key);
    char nm[40]; std::snprintf(nm, sizeof nm, "%016llx.gait", (unsigned long long)fnv1a(ks));
    g_gaitFinal = g_gaitDir + "/" + nm;
    FILE* f = fopen(g_gaitFinal.c_str(), "rb");
    if (f) {                                  // read path: verify header holds the exact key
        char magic[4]; uint32_t klen = 0;
        if (fread(magic, 1, 4, f) == 4 && std::memcmp(magic, "GAI1", 4) == 0
            && fread(&klen, 4, 1, f) == 1 && klen == ks.size()) {
            std::string fk(klen, '\0');
            if (klen == 0 || (fread(&fk[0], 1, klen, f) == klen && fk == ks)) {
                g_gaitFile = f; g_gaitMode = 1; return JS_TRUE;
            }
        }
        fclose(f);
    }
    g_gaitTmp = g_gaitFinal + ".tmp";         // miss: write path
    f = fopen(g_gaitTmp.c_str(), "wb");
    if (!f) return JS_FALSE;                   // cache unwritable → compute, no save
    uint32_t klen = (uint32_t)ks.size();
    fwrite("GAI1", 1, 4, f); fwrite(&klen, 4, 1, f); if (klen) fwrite(ks.data(), 1, klen, f);
    g_gaitFile = f; g_gaitMode = 2;
    return JS_FALSE;
}
static JSValue js_gaitRW(JSContext* ctx, int argc, JSValueConst* argv, bool write) {
    if (!g_gaitFile) return JS_UNDEFINED;
    for (int i = 0; i < argc; i++) {
        size_t len = 0; uint8_t* p = taBytes(ctx, argv[i], &len);
        if (!p || !len) continue;
        if (write) fwrite(p, 1, len, g_gaitFile);
        else if (fread(p, 1, len, g_gaitFile) != len) { /* short read: leaves zeros */ }
    }
    return JS_UNDEFINED;
}
static JSValue js_gaitRead(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) { return js_gaitRW(ctx, argc, argv, false); }
static JSValue js_gaitWrite(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) { return js_gaitRW(ctx, argc, argv, true); }
static JSValue js_gaitClose(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (!g_gaitFile) return JS_UNDEFINED;
    bool commit = argc > 0 && JS_ToBool(ctx, argv[0]) > 0;
    fclose(g_gaitFile); g_gaitFile = nullptr;
    int mode = g_gaitMode; g_gaitMode = 0;
    if (mode == 2) {
        if (commit) { std::remove(g_gaitFinal.c_str()); std::rename(g_gaitTmp.c_str(), g_gaitFinal.c_str()); }
        else std::remove(g_gaitTmp.c_str());
    }
    return JS_UNDEFINED;
}

// ---- native particle FX (the renderer owns the sim, mirroring render3d) ----
struct FxPreset { int count; float lifeMin, lifeMax, sizeMin, sizeMax, grow, spdMin, spdMax,
                  spread, lift, gravity, cr, cg, cb, maxAlpha; bool add; };
static FxPreset fxPreset(const std::string& k) {
    if (k=="flame")     return {60, .35f,.8f, .20f,.40f, 1.4f, .40f,1.0f, .18f, 1.4f, 0.f, 1.00f,.75f,.47f, 1.0f, true};
    if (k=="splash")    return {64, .35f,.7f, .06f,.14f, 0.5f, 1.6f,3.2f, .80f, 0.f, -9.f, .74f,.85f,1.00f, 0.9f, false};
    if (k=="explosion") return {90, .25f,.7f, .25f,.55f, 3.2f, 1.5f,4.5f, 1.00f, 0.f, 0.f, 1.00f,.80f,.47f, 1.0f, true};
    return                     {36, 1.0f,2.2f, .25f,.50f, 2.4f, .25f,.60f, .35f, 0.8f, 0.f, .67f,.67f,.67f, 0.45f, false}; // smoke
}
struct FxParticle { float px,py,pz, vx,vy,vz, age, life, size0; };
struct FxEmitter { std::string kind; FxPreset p; std::vector<FxParticle> pool; int lastBurst = 0; float cr=1,cg=1,cb=1; };
static float fxRand() { return (float)std::rand() / (float)RAND_MAX; }
static float fxRange(float a, float b) { return a + fxRand() * (b - a); }
static void fxParseHexColor(const std::string& hex, float& r, float& g, float& b) {
    std::string h = hex; if (!h.empty() && h[0]=='#') h = h.substr(1);
    if (h.size()==3) { h = std::string()+h[0]+h[0]+h[1]+h[1]+h[2]+h[2]; }
    if (h.size()>=6) { auto hx=[&](int i){ int c=h[i]; c = c<='9'?c-'0':(c|32)-'a'+10; return c<0?0:(c>15?15:c); };
        r=(hx(0)*16+hx(1))/255.f; g=(hx(2)*16+hx(3))/255.f; b=(hx(4)*16+hx(5))/255.f; }
}
static void fxSpawn(FxEmitter& em, FxParticle& q, float ax, float ay, float az, float stagger) {
    const FxPreset& p = em.p;
    q.age = -stagger; q.life = fxRange(p.lifeMin, p.lifeMax); q.size0 = fxRange(p.sizeMin, p.sizeMax);
    q.px = ax + (fxRand()-.5f)*.06f; q.py = ay + (fxRand()-.5f)*.06f; q.pz = az + (fxRand()-.5f)*.06f;
    float s = fxRange(p.spdMin, p.spdMax);
    float dx = (fxRand()*2-1)*p.spread, dy = p.spread>=1 ? (fxRand()*2-1) : 1.f, dz = (fxRand()*2-1)*p.spread;
    float len = std::sqrt(dx*dx+dy*dy+dz*dz); if (len<1e-6f) len=1;
    q.vx = dx/len*s; q.vy = dy/len*s; q.vz = dz/len*s;
}

int main(int argc, char** argv) {
    // Positional args: [agp-dir] [engine-dir]; both optional when co-located with
    // the exe (a shipped player.exe + pack + engine/ beside it). Flags anywhere.
    std::string exeDir = QjsHost::dirOf(slashes(argv[0]));
    std::vector<std::string> pos;
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        if (a == "--seconds" || a == "--shot" || a == "--shot-at" || a == "--freecam" || a == "--talk" || a == "--spawntest" || a == "--fxtest") { i++; continue; }  // skip flag + its value (--gotoscene/--scattertest take none)
        if (a.size() >= 2 && a[0] == '-' && a[1] == '-') continue;  // other flags
        pos.push_back(a);
    }
    std::string agpDir = pos.size() > 0 ? slashes(pos[0]) : exeDir;
    g_gaitDir = agpDir + "/.mmcache";        // MM gait warm-cache lives beside the pack
    g_savesDir = agpDir + "/saves";          // durable save slots + settings/continue KV
    ae1::storeEnsureDir(g_savesDir);
    _mkdir(g_gaitDir.c_str());               // best effort; open falls back to compute if unwritable
    std::string engineDir = pos.size() > 1 ? slashes(pos[1]) : "";
    if (engineDir.empty()) {   // auto-locate the engine JS tree
        const char* cand[] = { "/engine", "/../engine", "/source/engine" };
        std::string bases[] = { exeDir, agpDir, agpDir };
        for (int i = 0; i < 3; i++) { std::string e = bases[i] + cand[i]; if (fileExists(e + "/ags/runtime.js")) { engineDir = e; break; } }
        if (engineDir.empty() && fileExists(exeDir + "/../../engine/ags/runtime.js")) engineDir = exeDir + "/../../engine";
    }
    if (!fileExists(agpDir + "/manifest.json")) {
        std::printf("ae1game — the AE1 native player\nusage: ae1game [agp-dir] [engine-dir] [--walk] [--follow] [--seconds N]\n"
                    "  (with no args, looks for a package + engine/ beside the exe)\n"
                    "  no manifest.json found at: %s\n", agpDir.c_str());
        return 2;
    }
    if (engineDir.empty()) { std::printf("ERROR: engine JS not found (expected engine/ beside the exe or package)\n"); return 1; }
    std::string err;

    // ---- package ----
    AgpManifest man;
    if (!AgpManifest::load(agpDir + "\\manifest.json", man, err)) { std::printf("ERROR manifest: %s\n", err.c_str()); return 1; }
    Aepack pack;
    if (!pack.open(agpDir + "\\" + man.payloadFile, err)) { std::printf("ERROR payload: %s\n", err.c_str()); return 1; }
    if (!readFile(agpDir + "\\data.json", g_dataJson, err)) { std::printf("ERROR data.json: %s\n", err.c_str()); return 1; }
    Json data;
    try { data = Json::parse(g_dataJson); g_entryScene = data["entryScene"].str(); }
    catch (const std::exception& ex) { std::printf("ERROR parse data.json: %s\n", ex.what()); return 1; }

    // ---- engine (QuickJS) ----
    QjsHost host;
    if (!host.init(err)) { std::printf("ERROR host: %s\n", err.c_str()); return 1; }
    host.addGlobalFunction("__dataJSON", js_dataJSON, 0);
    host.addGlobalFunction("__entryScene", js_entryScene, 0);
    host.addGlobalFunction("__keyDown", js_keyDown, 1);
    host.addGlobalFunction("__keyPressed", js_keyPressed, 1);
    host.addGlobalFunction("__stickX", js_stickX, 0);
    host.addGlobalFunction("__stickY", js_stickY, 0);
    host.addGlobalFunction("__lookStickX", js_lookStickX, 0);
    host.addGlobalFunction("__lookStickY", js_lookStickY, 0);
    host.addGlobalFunction("__lookActive", js_lookActive, 0);
    host.addGlobalFunction("__consumeLook", js_consumeLook, 0);
    host.addGlobalFunction("__gaitOpen", js_gaitOpen, 1);
    host.addGlobalFunction("__gaitRead", js_gaitRead, 8);
    host.addGlobalFunction("__gaitWrite", js_gaitWrite, 8);
    host.addGlobalFunction("__gaitClose", js_gaitClose, 1);
    host.addGlobalFunction("__playSound", js_playSound, 1);
    host.addGlobalFunction("__playMusic", js_playMusic, 1);
    host.addGlobalFunction("__setMusicVolume", js_setMusicVolume, 1);
    host.addGlobalFunction("__setSoundVolume", js_setSoundVolume, 1);
    host.addGlobalFunction("__setMuted", js_setMuted, 1);
    host.addGlobalFunction("__asset", js_asset, 1);
    host.addGlobalFunction("__assetText", js_assetText, 1);
    host.addGlobalFunction("__dequantAsset", js_dequantAsset, 1);
    host.addGlobalFunction("__rigNodes", js_rigNodes, 1);
    host.addGlobalFunction("__groundAt", js_groundAt, 3);
    host.addGlobalFunction("__saveWrite", js_saveWrite, 2);
    host.addGlobalFunction("__saveRead", js_saveRead, 1);
    host.addGlobalFunction("__saveDelete", js_saveDelete, 1);
    host.addGlobalFunction("__saveList", js_saveList, 0);

    // ---- audio (miniaudio) ----
    Audio audio;
    std::string aerr;
    if (audio.init(aerr)) { g_audio = &audio; std::printf("Audio: device ready.\n"); }
    else std::printf("Audio: %s (silent).\n", aerr.c_str());
    g_pack = &pack;
    bool testAudio = false;
    for (int i = 1; i < argc; i++) if (std::string(argv[i]) == "--testaudio") testAudio = true;
    if (testAudio && g_audio) {
        const AepackEntry* e = pack.find("footsteps_grass.mp3");
        if (!e) for (const auto& en : pack.entries())
            if (en.name.size() > 4 && en.name.substr(en.name.size() - 4) == ".mp3") { e = &en; break; }
        if (e) std::printf("Audio test: %s '%s' (%llu bytes) looping.\n",
                           g_audio->play(pack.data(*e), (size_t)e->length, true) ? "PLAYING" : "FAILED",
                           e->name.c_str(), (unsigned long long)e->length);
    }
    std::string runtimeSrc;
    if (!readFile(engineDir + "/ags/runtime.js", runtimeSrc, err)) { std::printf("ERROR runtime.js: %s\n", err.c_str()); return 1; }
    // three.js math shim: satisfies `import * as THREE from 'three'` in
    // the motion-matching core (not in the public build) (Vector2/Vector3/Quaternion) so the motion-matching character
    // loads. Registered under the bare specifier "three".
    host.addStubModule("three", kThreeShim);

    // Only the DOM modules stay stubbed now; the THREE-math shim un-stubs
    // the motion-matching driver (not in the public build) (the player character's locomotion) and light loads as-is.
    auto basename = [](const std::string& p){ size_t s=p.find_last_of('/'); return s==std::string::npos?p:p.substr(s+1); };
    const char* blocked[] = { "debugmenu.js", "video.js" };
    const std::string elementAbs = engineDir + "/element.js";
    int stubbed = 0;
    for (const auto& imp : parseImports(runtimeSrc)) {
        std::string bn = basename(imp.path); bool isBlocked = false;
        for (const char* b : blocked) if (bn == b) isBlocked = true;
        if (!isBlocked) continue;
        std::string abs = QjsHost::resolvePath(engineDir + "/ags", imp.path);
        std::string stub = "import { AE1Element } from '" + elementAbs + "';\n";
        for (const auto& n : imp.names) stub += "export class " + n + " extends AE1Element {}\n";
        host.addStubModule(abs, std::move(stub));
        stubbed++;
    }
    if (!host.runModule(kGame, engineDir + "/__ae1_game.js", err)) { std::printf("ERROR engine: %s\n", err.c_str()); return 1; }
    std::printf("(%d modules stubbed [three/DOM]; the rest run for real)\n", stubbed);
    {   // report how much real element logic now runs
        JSContext* c = host.ctx(); JSValue g = JS_GetGlobalObject(c);
        JSValue fn = JS_GetPropertyStr(c, g, "__diag");
        JSValue r = JS_Call(c, fn, g, 0, nullptr);
        const char* s = JS_ToCString(c, r);
        if (s) { std::printf("  first onTick: %s\n", s); JS_FreeCString(c, s); }
        JS_FreeValue(c, r); JS_FreeValue(c, fn); JS_FreeValue(c, g);
    }

    // ---- window + renderer ----
    Platform plat;
    if (!plat.create(man.title + "  —  AE1 native (tick+draw)", 1280, 720, err)) { std::printf("ERROR window: %s\n", err.c_str()); return 1; }
    Gfx gfx;
    if (!gfx.init(plat.nativeHandle(), plat.width(), plat.height(), err)) { std::printf("ERROR gfx: %s\n", err.c_str()); return 1; }

    // ---- build render instances (glb-local meshes; per-frame transform) ----
    std::vector<Instance> insts;
    std::map<std::string, TexHandle> texCache;
    int transcoded = 0;
    const Json& els = data["scenes"][man.entryScene]["elements"];
    for (const auto& kv : els.obj()) {
        const Json& el = kv.second;
        if (!el["visible"].boolean(true)) continue;
        std::string media = el["components"]["model"]["media"].str();
        if (media.empty()) continue;
        const AepackEntry* ge = pack.find(media);
        if (!ge) continue;
        std::vector<CpuMesh> cpu; std::string e2;
        GlbRig* rig = loadGlbRig(pack.data(*ge), (size_t)ge->length, cpu, e2);  // glb-local, posable
        if (!rig) continue;
        bool animated = rigAnimCount(rig) > 0;
        bool skinned = rigSkinned(rig);
        bool dyn = animated || skinned;   // posable each frame (glTF anim or motion-matching)
        int anim = -1;
        if (animated) {  // prefer an idle-ish clip, else the first
            anim = rigFindAnim(rig, "Idle"); if (anim < 0) anim = rigFindAnim(rig, "idle");
            if (anim < 0) anim = rigFindAnim(rig, "IdleArms"); if (anim < 0) anim = 0;
        }
        Instance inst; inst.id = kv.first; inst.rig = dyn ? rig : nullptr; inst.anim = anim;
        auto texFor = [&](const CpuMesh& m) -> TexHandle {
            if (m.baseColorBytes.empty()) return {};
            std::string key = std::to_string(m.baseColorBytes.size()) + (m.baseColorKTX2 ? "k" : "p");
            for (size_t k = 0; k < m.baseColorBytes.size(); k += 4099) key.push_back((char)m.baseColorBytes[k]);
            auto it = texCache.find(key); if (it != texCache.end()) return it->second;
            Image img; std::string e3;
            bool ok = m.baseColorKTX2 ? transcodeKTX2(m.baseColorBytes.data(), m.baseColorBytes.size(), img, e3)
                                      : decodeImage(m.baseColorBytes.data(), m.baseColorBytes.size(), img, e3);
            TexHandle th{}; if (ok) { th = gfx.createTexture(img.rgba.data(), img.w, img.h); transcoded++; }
            texCache[key] = th; return th;
        };
        for (auto& m : cpu) {
            inst.meshes.push_back(gfx.createMesh(m.verts.data(), m.verts.size(),
                                                 m.indices.data(), m.indices.size(), dyn));  // dyn (anim OR MM-skinned), not just animated — else MM chars freeze at bind
            gfx.setMeshMaterial(inst.meshes.back(), m.metallic, m.roughness);
            inst.texes.push_back(texFor(m));
            inst.cutoffs.push_back(m.alphaCutoff);
        }
        { Vec3 lo, hi; meshBounds(cpu, lo, hi); inst.bindH = hi.y - lo.y; }
        inst.cpu = std::move(cpu);         // kept: dynamic re-pose AND static ground tris
        if (!dyn) freeGlbRig(rig);
        insts.push_back(std::move(inst));
    }
    g_insts = &insts;   // the skeleton bridge resolves rigs by element id
    int rigCount = 0; for (auto& in : insts) if (in.rig) rigCount++;
    std::printf("Rendering %zu model elements (%d posable), %d textures. Ticking the engine each frame.\n",
                insts.size(), rigCount, transcoded);

    // ---- runtime spawn support (§rescan): build a draw instance for an element
    // that appeared live in the JS scene (a fired round, a spawned prop). Static
    // media of the same name SHARES one GPU upload — a hail of identical rounds
    // costs one mesh, drawn at N transforms. Dynamic (skinned/anim) spawns build
    // fresh. These insts carry no `cpu` (no ground tris, no re-pose for statics).
    struct MeshSet { std::vector<MeshHandle> meshes; std::vector<TexHandle> texes;
                     std::vector<float> cutoffs; std::vector<bool> transparent; float bindH = 0; };
    std::map<std::string, MeshSet> staticMeshCache;
    auto texForBytes = [&](const CpuMesh& m) -> TexHandle {
        if (m.baseColorBytes.empty()) return {};
        std::string key = std::to_string(m.baseColorBytes.size()) + (m.baseColorKTX2 ? "k" : "p");
        for (size_t k = 0; k < m.baseColorBytes.size(); k += 4099) key.push_back((char)m.baseColorBytes[k]);
        auto it = texCache.find(key); if (it != texCache.end()) return it->second;
        Image img; std::string e3;
        bool ok = m.baseColorKTX2 ? transcodeKTX2(m.baseColorBytes.data(), m.baseColorBytes.size(), img, e3)
                                  : decodeImage(m.baseColorBytes.data(), m.baseColorBytes.size(), img, e3);
        TexHandle th{}; if (ok) th = gfx.createTexture(img.rgba.data(), img.w, img.h);
        texCache[key] = th; return th;
    };
    auto buildSpawned = [&](const std::string& id, const std::string& media) {
        const AepackEntry* ge = pack.find(media); if (!ge) return;
        auto sc = staticMeshCache.find(media);
        if (sc != staticMeshCache.end()) {   // share the cached static upload
            Instance in; in.id = id; in.shared = true; in.media = media;
            in.meshes = sc->second.meshes; in.texes = sc->second.texes;
            in.cutoffs = sc->second.cutoffs; in.transparent = sc->second.transparent; in.bindH = sc->second.bindH;
            insts.push_back(std::move(in)); return;
        }
        std::vector<CpuMesh> cpu; std::string e2;
        GlbRig* rig = loadGlbRig(pack.data(*ge), (size_t)ge->length, cpu, e2); if (!rig) return;
        bool animated = rigAnimCount(rig) > 0, skinned = rigSkinned(rig), dyn = animated || skinned;
        int anim = -1; if (animated) { anim = rigFindAnim(rig,"Idle"); if(anim<0)anim=rigFindAnim(rig,"idle");
                                       if(anim<0)anim=rigFindAnim(rig,"IdleArms"); if(anim<0)anim=0; }
        Instance in; in.id = id; in.rig = dyn ? rig : nullptr; in.anim = anim;
        for (auto& m : cpu) {
            in.meshes.push_back(gfx.createMesh(m.verts.data(), m.verts.size(), m.indices.data(), m.indices.size(), dyn));
            gfx.setMeshMaterial(in.meshes.back(), m.metallic, m.roughness);
            in.texes.push_back(texForBytes(m)); in.cutoffs.push_back(m.alphaCutoff); in.transparent.push_back(m.transparent);
        }
        { Vec3 lo, hi; meshBounds(cpu, lo, hi); in.bindH = hi.y - lo.y; }
        in.cpu = std::move(cpu);   // kept for re-pose (dyn) AND ground tris (the first static of a media)
        if (!dyn) { MeshSet ms{ in.meshes, in.texes, in.cutoffs, in.transparent, in.bindH };
                    staticMeshCache[media] = std::move(ms); in.shared = true; in.media = media; freeGlbRig(rig); }
        insts.push_back(std::move(in));
    };
    int lastInstGen = 0, lastSceneEpoch = 0;
    // Reconcile insts against the live JS model elements (id\tmedia TSV).
    auto reconcileInstances = [&]() {
        std::string list = jsCallStr(host.ctx(), "__modelElements");
        // present ids -> media
        std::vector<std::pair<std::string,std::string>> present;
        size_t p = 0;
        while (p < list.size()) {
            size_t nl = list.find('\n', p);
            std::string line = list.substr(p, nl==std::string::npos?std::string::npos:nl-p);
            if (!line.empty()) { size_t tab = line.find('\t');
                if (tab != std::string::npos) present.push_back({ line.substr(0,tab), line.substr(tab+1) }); }
            if (nl==std::string::npos) break; p = nl+1;
        }
        // add any present id we don't have
        for (auto& pr : present) {
            bool found = false;
            for (auto& in : insts) if (in.id == pr.first) { in.hidden = false; found = true; break; }
            if (!found) buildSpawned(pr.first, pr.second);
        }
        // erase insts whose element left the scene (a spent round, or a whole
        // scene on goToScene) — free the dynamic rig AND, unless the mesh handles
        // are pooled in staticMeshCache (shared statics), release their GPU
        // buffers. Shared media buffers are freed by the cache sweep on scene
        // change, once no live inst references them.
        for (size_t i = 0; i < insts.size(); ) {
            bool still = false; for (auto& pr : present) if (pr.first == insts[i].id) { still = true; break; }
            if (!still) {
                if (insts[i].rig) freeGlbRig(insts[i].rig);
                if (!insts[i].shared) for (auto mh : insts[i].meshes) gfx.destroyMesh(mh);
                insts[i] = std::move(insts.back()); insts.pop_back();
            } else ++i;
        }
        g_insts = &insts;   // vector may have reallocated
    };

    // ---- per-scene visuals (camera framing, camera/player ids, ground raycast
    // tris, directional light, shadow bounds, skybox HDR). Run once at startup and
    // again on every goToScene, so a scene change re-lights, re-skies, re-grounds
    // and re-frames. Instances themselves reconcile through __instGen. ----
    Vec3 center{0, 0.8f, 0}; float radius = 6.0f;
    std::string camId, playerId;
    auto applySceneVisuals = [&]() {
        // camera framing from the scene's element positions (render space)
        Vec3 pLo{0,0,0}, pHi{0,0,0}; bool havePos = false;
        for (auto& inst : insts) {
            if (inst.hidden) continue;
            double v[10]; if (!jsXform(host.ctx(), inst.id, v)) continue;
            Vec3 p = { (float)v[0], (float)v[1], -(float)v[2] };
            if (!havePos) { pLo = pHi = p; havePos = true; }
            pLo.x=p.x<pLo.x?p.x:pLo.x; pLo.y=p.y<pLo.y?p.y:pLo.y; pLo.z=p.z<pLo.z?p.z:pLo.z;
            pHi.x=p.x>pHi.x?p.x:pHi.x; pHi.y=p.y>pHi.y?p.y:pHi.y; pHi.z=p.z>pHi.z?p.z:pHi.z;
        }
        center = havePos ? Vec3{ (pLo.x+pHi.x)*0.5f, (pLo.y+pHi.y)*0.5f + 0.8f, (pLo.z+pHi.z)*0.5f } : Vec3{0,0.8f,0};
        Vec3 dsp = pHi - pLo;
        radius = havePos ? 0.5f*std::sqrt(dsp.x*dsp.x+dsp.y*dsp.y+dsp.z*dsp.z) + 4.0f : 6.0f;
        camId = jsCallStr(host.ctx(), "__camId");
        playerId = jsCallStr(host.ctx(), "__playerId");

        // ground raycast tris: world-space (render) triangles of the STATIC meshes
        g_groundTris.clear();
        for (auto& inst : insts) {
            if (inst.rig || inst.hidden) continue;   // static, visible
            double v[10]; if (!jsXform(host.ctx(), inst.id, v)) continue;
            if (std::fabs(v[6]) < 0.05 && inst.bindH > 0.5) { v[6] = v[7] = v[8] = 1.0; }
            Mat4 m = elemModelLH(v);
            for (auto& cm : inst.cpu)
                for (size_t k = 0; k + 2 < cm.indices.size(); k += 3)
                    for (int t = 0; t < 3; t++) {
                        const Vertex& vv = cm.verts[cm.indices[k + t]];
                        g_groundTris.push_back(vv.px*m.m[0] + vv.py*m.m[4] + vv.pz*m.m[8]  + m.m[12]);
                        g_groundTris.push_back(vv.px*m.m[1] + vv.py*m.m[5] + vv.pz*m.m[9]  + m.m[13]);
                        g_groundTris.push_back(vv.px*m.m[2] + vv.py*m.m[6] + vv.pz*m.m[10] + m.m[14]);
                    }
        }

        // directional light
        { JSContext* c = host.ctx(); JSValue g = JS_GetGlobalObject(c);
          JSValue fn = JS_GetPropertyStr(c, g, "__lightInfo");
          JSValue arr = JS_Call(c, fn, g, 0, nullptr);
          if (JS_IsObject(arr)) {
              double L[7] = {-0.4,-1,-0.5, 0.7,0.7,0.7, 0.32};
              for (int i = 0; i < 7; i++) { JSValue e = JS_GetPropertyUint32(c, arr, i); JS_ToFloat64(c, &L[i], e); JS_FreeValue(c, e); }
              gfx.setLight({ (float)L[0], (float)L[1], -(float)L[2] }, (float)L[3], (float)L[4], (float)L[5], (float)L[6]);
          }
          JS_FreeValue(c, arr); JS_FreeValue(c, fn); JS_FreeValue(c, g); }
        gfx.setShadowBounds(center, radius);

        // skybox HDR (background + image-based ambient)
        { JSContext* c = host.ctx(); JSValue g = JS_GetGlobalObject(c);
          JSValue fn = JS_GetPropertyStr(c, g, "__skyInfo");
          JSValue arr = JS_Call(c, fn, g, 0, nullptr);
          if (JS_IsObject(arr)) {
              JSValue nv = JS_GetPropertyUint32(c, arr, 0);
              const char* nm = JS_ToCString(c, nv);
              double op = 0.45, rot = 0, ei = 0.3;
              JSValue ov = JS_GetPropertyUint32(c, arr, 1); JS_ToFloat64(c, &op, ov);
              JSValue rv = JS_GetPropertyUint32(c, arr, 2); JS_ToFloat64(c, &rot, rv);
              JSValue ev = JS_GetPropertyUint32(c, arr, 3); JS_ToFloat64(c, &ei, ev);
              if (nm) { const AepackEntry* he = findAsset(nm);
                  if (he) { std::vector<float> hdr; int hw=0, hh=0; std::string he2;
                      if (decodeHDR(g_pack->data(*he), (size_t)he->length, hdr, hw, hh, he2))
                          gfx.setEnvMap(hdr.data(), hw, hh, (float)op, (float)rot, (float)ei); } }
              JS_FreeValue(c, nv); JS_FreeValue(c, ov); JS_FreeValue(c, rv); JS_FreeValue(c, ev);
              if (nm) JS_FreeCString(c, nm);
          }
          JS_FreeValue(c, arr); JS_FreeValue(c, fn); JS_FreeValue(c, g); }
    };
    applySceneVisuals();
    std::printf("Scene visuals: %zu ground tris, light+shadow(radius %.1f)+sky applied.\n", g_groundTris.size()/9, radius);

    // ---- loop options + follow-camera targets ----
    double runSeconds = 0.0; bool walk = false, follow = false, warmCache = false;
    std::string shotPath; double shotAt = 6.0; bool shotTaken = false;
    bool freeCam = false; double fc[6] = {0,0,0, 0,0,0};   // debug: ex,ey,ez,tx,ty,tz
    std::string talkTarget; bool talked = false;            // debug: --talk <name>
    bool startMenu = false;                                 // debug: --menu (open the save/load menu at start)
    std::string spawnName; bool spawned = false;            // debug: --spawntest <name>
    std::string fxTestKind; bool fxTested = false;          // debug: --fxtest <kind>
    bool gotoTest = false, wentScene = false;               // debug: --gotoscene
    bool scatterTest = false, scattered = false;            // debug: --scattertest
    bool fxBoneTest = false, fxBoned = false;               // debug: --fxbonetest
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        if (a == "--seconds" && i+1 < argc) runSeconds = atof(argv[++i]);
        else if (a == "--walk") walk = true;
        else if (a == "--follow") follow = true;
        else if (a == "--warmcache") warmCache = true;   // build MM caches, then exit
        else if (a == "--shot" && i+1 < argc) shotPath = argv[++i];       // capture one PNG then exit
        else if (a == "--shot-at" && i+1 < argc) shotAt = atof(argv[++i]);
        else if (a == "--freecam" && i+1 < argc) {       // debug: park the camera at ex,ey,ez looking at tx,ty,tz
            const char* p = argv[++i]; char* e = nullptr;
            for (int k=0;k<6;k++) { fc[k] = strtod(p, &e); if (e==p) break; p = (*e==','||*e==' ') ? e+1 : e; }
            freeCam = true;
        }
        else if (a == "--talk" && i+1 < argc) talkTarget = argv[++i];   // debug: open a dialogue with this element
        else if (a == "--menu") startMenu = true;                       // debug: open the save/load menu on the first frame
        else if (a == "--spawntest" && i+1 < argc) spawnName = argv[++i]; // debug: clone this element at runtime
        else if (a == "--fxtest" && i+1 < argc) fxTestKind = argv[++i];    // debug: spawn a looping particle emitter
        else if (a == "--gotoscene") gotoTest = true;                     // debug: synthesize + switch to a 2nd scene
        else if (a == "--scattertest") scatterTest = true;                // debug: scatter copies around the Commander
        else if (a == "--fxbonetest") fxBoneTest = true;                  // debug: bone-anchored FX on the Commander
        else if (a == "--savetest" && i+1 < argc) {                     // debug: exercise the save system, then exit
            std::string mode = argv[++i];
            double t0 = plat.now();
            JSContext* c = host.ctx(); JSValue g = JS_GetGlobalObject(c);
            JSValue fn = JS_GetPropertyStr(c, g, "__saveSelfTest");
            JSValue mv = JS_NewString(c, mode.c_str());
            JSValue r = JS_Call(c, fn, g, 1, &mv);
            double ms = (plat.now() - t0) * 1000.0;
            const char* s = JS_ToCString(c, r);
            std::printf("SAVE TEST (%s) in %.3f ms:\n%s\n", mode.c_str(), ms, s ? s : "(null)");
            if (s) JS_FreeCString(c, s);
            JS_FreeValue(c, r); JS_FreeValue(c, mv); JS_FreeValue(c, fn); JS_FreeValue(c, g);
            gfx.shutdown(); host.shutdown();
            return 0;
        }
    }
    if (!camId.empty() && !playerId.empty()) follow = true;   // the scene has a real view camera
    std::printf("Follow-cam: %s (cam=%s player=%s)%s\n", follow ? "on" : "off",
                camId.empty()?"-":camId.substr(0,8).c_str(), playerId.empty()?"-":playerId.substr(0,8).c_str(),
                walk ? "  [--walk]" : "");

    // UI font: bake the dialogue TTF into a glyph atlas for the native 2D overlay.
    {
        const AepackEntry* fe = findAsset("ps2_helvetica.ttf");
        if (!fe) fe = findAsset("PS2Helvetica.ttf");
        std::string fer;
        if (fe && bakeFont(g_pack->data(*fe), (size_t)fe->length, 44.0f, g_font, fer)) {
            g_fontTex = gfx.createTexture(g_font.image.rgba.data(), g_font.image.w, g_font.image.h);
            g_fontOK = g_fontTex.valid();
            std::printf("UI: font atlas baked (%dx%d).\n", g_font.image.w, g_font.image.h);
        } else std::printf("UI: font unavailable (%s) — text overlay disabled.\n", fe ? fer.c_str() : "not in pack");
    }

    struct Draw { MeshHandle mesh; Mat4 model; TexHandle tex; float cutoff; bool transparent; float depth; };
    std::vector<Draw> drawList;   // built once per frame; drives the shadow pass and the main pass
    std::map<std::string, FxEmitter> fxEmitters;   // particle FX pools, keyed by element id

    double last = plat.now(), dist = radius*1.9;   // dist: camera-less fallback only
    long long frames = 0; double fpsT = 0; int fpsN = 0; double posT = 0;
    // ---- in-game save/load menu (F6), quicksave (F5), quickload (F9) --------
    bool menuOpen = false; int menuSel = 0;
    std::vector<std::pair<std::string,std::string>> menuRows;   // (slot, subtitle)
    std::string toast; double toastAt = -100.0;
    auto refreshMenu = [&]() {
        menuRows.clear();
        std::string tsv = jsSaveMenuList(host.ctx());
        size_t p = 0;
        while (p < tsv.size()) {
            size_t nl = tsv.find('\n', p);
            std::string line = tsv.substr(p, nl == std::string::npos ? std::string::npos : nl - p);
            if (!line.empty()) { size_t tab = line.find('\t');
                menuRows.push_back({ line.substr(0, tab), tab == std::string::npos ? std::string() : line.substr(tab + 1) }); }
            if (nl == std::string::npos) break; p = nl + 1;
        }
    };
    FrameInput in;
    while (plat.pump(in)) {
        if (in.down[Key::Escape]) break;
        if (runSeconds > 0 && plat.now() >= runSeconds) break;
        if (in.resized) gfx.resize(plat.width(), plat.height());
        double t = plat.now(), dt = t - last; last = t; if (dt > 0.25) dt = 0.25;
        // Gamepad (XInput pad 0) → the input3d seams. Left stick drives movement
        // (input3d.stick), right stick the camera (input3d.lookStick), buttons the
        // Pad* codes. Edge state kept for pressed().
        ae1::Gamepad gp; g_padConnected = ae1::pollGamepad(gp);
        for (int i = 0; i < PAD_N; i++) g_padPrev[i] = g_padCur[i];
        for (int i = 0; i < PAD_N && i < 16; i++) g_padCur[i] = gp.btn[i];
        g_padLX = gp.lx; g_padLY = gp.ly; g_padRX = gp.rx;
        g_padRY = -gp.ry;   // XInput stick-up is +, but the camera's pitch is +down → flip so up looks up
        g_stickX = gp.lx; g_stickY = gp.ly;

        // Mouse-look feeds the REAL AE1ThirdPersonCamera element (hold left button
        // to orbit — pointer-locked so it never hits a screen edge). `looking`
        // gates the camera's look read; a connected pad keeps it on for the stick.
        bool mouseLook = in.mouseDown[0] && !menuOpen;   // the menu owns the cursor while open
        plat.captureMouse(mouseLook);
        g_looking = mouseLook || (g_padConnected && !menuOpen);
        if (mouseLook) { g_lookDX += in.mouseDX; g_lookDY += in.mouseDY; }

        // ---- save/load menu + quick keys (F5 save, F9 load, F6 menu) --------
        // F-key VKs: F5=0x74 F6=0x75 F9=0x78. Nav Up=0x26 Down=0x28 Enter=0x0D Del=0x2E.
        if (startMenu && !menuOpen && toastAt < 0) {   // --menu: open once on the first frame
            menuOpen = true; refreshMenu(); menuSel = 0; jsSetUiLock(host.ctx(), true); startMenu = false;
        }
        if (in.pressed[0x74]) { toast = jsSaveAction(host.ctx(), "quicksave", ""); toastAt = plat.now(); }
        if (in.pressed[0x78]) { toast = jsSaveAction(host.ctx(), "quickload", ""); toastAt = plat.now(); }
        if (in.pressed[0x75]) { menuOpen = !menuOpen; if (menuOpen) { refreshMenu(); menuSel = 0; }
                                jsSetUiLock(host.ctx(), menuOpen); }
        if (menuOpen) {
            int nRows = (int)menuRows.size() + 1;   // + a trailing "New save" row
            if (in.pressed[0x26] || in.pressed['W']) menuSel = (menuSel + nRows - 1) % nRows;
            if (in.pressed[0x28] || in.pressed['S']) menuSel = (menuSel + 1) % nRows;
            bool onNew = menuSel >= (int)menuRows.size();
            if (in.pressed[0x0D]) {                 // Enter: load a slot, or create a new one
                if (onNew) { std::string slot = "slot-" + std::to_string((int)menuRows.size() + 1);
                             toast = jsSaveAction(host.ctx(), "save", slot); refreshMenu(); }
                else { toast = jsSaveAction(host.ctx(), "load", menuRows[menuSel].first);
                       menuOpen = false; jsSetUiLock(host.ctx(), false); }
                toastAt = plat.now();
            }
            if (in.pressed[0x2E] && !onNew) {       // Delete: remove the selected slot
                toast = jsSaveAction(host.ctx(), "delete", menuRows[menuSel].first);
                toastAt = plat.now(); refreshMenu(); if (menuSel > 0) menuSel--;
            }
        }

        // TICK the engine — VARIABLE timestep (one tick of this frame's real dt),
        // like the browser's rAF. A fixed 60 Hz step judders on a non-60 display
        // (75 Hz → 0/1/2 steps per frame → the animation stutters); the matcher is
        // dt-driven and clamps min(0.1,dt) internally, so per-frame dt is smoothest.
        g_in = in;
        if (walk) g_in.down[(int)'W'] = true;   // --walk: forward (digital)
        double tickT0 = plat.now();
        double stepDt = dt > 0.1 ? 0.1 : dt;    // clamp the one giant post-build frame
        jsTick(host.ctx(), host.rt(), stepDt);
        int steps = 1;
        double tickMs = (plat.now() - tickT0) * 1000.0;

        // --warmcache: exit the moment every MM matcher is built (its cache
        // written). A safety cap covers a rig that never binds.
        if (warmCache) {
            if (jsCallStr(host.ctx(), "__mmAllReady") == "true") {
                std::printf("Warm cache: all motion-matching tables built + written. Done.\n"); break;
            }
            if (plat.now() > 90.0) { std::printf("Warm cache: timed out before all matchers built.\n"); break; }
        }

        // THE VIEW COMES FROM THE REAL CAMERA. AE1ThirdPersonCamera ticked in JS
        // above and computed its own eye, orbit and fov (follow distance, height,
        // shoulder, chase-lag, sway, spawn facing — the browser-proven camera the
        // character also steers against). We just read its transform. Engine space
        // is RH; the renderer is LH, so z-flips on both eye and forward.
        float aspect = plat.height() ? (float)plat.width()/plat.height() : 1.7778f;
        float fovRad = 1.05f;
        Vec3 eye, target;
        {
            JSContext* c = host.ctx(); JSValue g = JS_GetGlobalObject(c);
            JSValue fn = JS_GetPropertyStr(c, g, "__camView");
            JSValue arr = JS_Call(c, fn, g, 0, nullptr);
            bool ok = JS_IsObject(arr);
            if (ok) {
                double cv[7] = {0,0,0, 0,0,-1, 48};
                for (int i = 0; i < 7; i++) { JSValue e = JS_GetPropertyUint32(c, arr, i); JS_ToFloat64(c, &cv[i], e); JS_FreeValue(c, e); }
                eye = { (float)cv[0], (float)cv[1], -(float)cv[2] };
                target = { eye.x + (float)cv[3], eye.y + (float)cv[4], eye.z - (float)cv[5] };
                fovRad = (float)(cv[6] * 3.14159265358979 / 180.0);
            } else {   // fallback: orbit the scene centre (no camera element)
                eye = { center.x, center.y + radius, center.z - (float)dist }; target = center;
            }
            JS_FreeValue(c, arr); JS_FreeValue(c, fn); JS_FreeValue(c, g);
        }
        if (freeCam) {   // debug override: fixed eye/target (engine space -> render z-flip)
            eye = { (float)fc[0], (float)fc[1], -(float)fc[2] };
            target = { (float)fc[3], (float)fc[4], -(float)fc[5] };
        }
        Mat4 view = lookAtLH(eye, target, {0,1,0});
        Mat4 proj = perspectiveFovLH(fovRad, aspect, radius*0.02f + 0.02f, radius*40.0f + 10.0f);

        gfx.setViewProj(view, proj);   // before the sky + shadow passes (both use the camera)
        // Depth of field focuses on the player; the void/sky beyond softens.
        { double pp[10];
          if (!playerId.empty() && jsXform(host.ctx(), playerId, pp)) {
              float fx = (float)pp[0] - eye.x, fy = (float)pp[1] - eye.y, fz = -(float)pp[2] - eye.z;
              gfx.setDOF(std::sqrt(fx*fx + fy*fy + fz*fz), radius * 0.7f, 0.006f);
          }
        }
        float animT = (float)plat.now();
        std::vector<double> worlds;
        std::vector<double> gLocals;   // clip sample fed to the JS bone-physics graph
        double drawT0 = plat.now();

        // §rescan: a spawn/despawn this frame bumped the generation — add draw
        // instances for new elements, hide gone ones. Cheap when nothing changed.
        { int gen = 0; { std::string gs = jsCallStr(host.ctx(), "__instGenGet"); gen = std::atoi(gs.c_str()); }
          if (gen != lastInstGen) { reconcileInstances(); lastInstGen = gen; } }
        // §multi-scene: a goToScene bumped the epoch — the instances already
        // reconciled above; now re-light, re-sky, re-ground, re-frame, re-resolve
        // the camera/player, and drop the old scene's particle emitters.
        { int se = 0; { std::string ss = jsCallStr(host.ctx(), "__sceneEpochGet"); se = std::atoi(ss.c_str()); }
          if (se != lastSceneEpoch) {
              applySceneVisuals();
              fxEmitters.clear();
              // free pooled static meshes the new scene no longer uses (GPU teardown)
              int freed = 0;
              for (auto it = staticMeshCache.begin(); it != staticMeshCache.end(); ) {
                  bool used = false;
                  for (auto& in : insts) if (in.shared && in.media == it->first) { used = true; break; }
                  if (!used) { for (auto mh : it->second.meshes) gfx.destroyMesh(mh);
                               freed += (int)it->second.meshes.size(); it = staticMeshCache.erase(it); }
                  else ++it;
              }
              camId = jsCallStr(host.ctx(), "__camId");
              playerId = jsCallStr(host.ctx(), "__playerId");
              int mt = 0, mf = 0; gfx.meshStats(mt, mf);
              std::printf("Scene changed -> \"%s\": %zu insts, %zu ground tris, %d pooled freed | GPU meshes live=%d (slots %d, recycled %d).\n",
                          jsCallStr(host.ctx(), "__sceneFileKey").c_str(), insts.size(), g_groundTris.size()/9, freed, mt - mf, mt, mf);
              lastSceneEpoch = se;
          } }

        // 1) Build the frame's draw list — skin/pose every rig ONCE here, so the
        // shadow pass and the main pass share the posed vertex buffers.
        drawList.clear();
        for (auto& inst : insts) {
            if (inst.hidden) continue;
            double v[10]; if (!jsXform(host.ctx(), inst.id, v)) continue;
            // Rig-unit artifact: a tiny element scale on an already-human-sized
            // mesh (e.g. the player character's cm-rig 0.01) — the character class ignores it in-engine.
            if (std::fabs(v[6]) < 0.05 && inst.bindH > 0.5) { v[6] = v[7] = v[8] = 1.0; }
            Mat4 model = elemModelLH(v);   // element's LIVE transform, read from JS
            Mat4 drawModel = model;
            if (inst.rig) {
                // Latch bone-physics NPCs (e.g. the Commander's sword sash): a
                // glTF-anim rig that also carries a components.model.bonePhys.
                // These route through a JS bone graph running the browser's real
                // verlet sim — checked BEFORE the MM readback, because once the
                // sim runs, objectFor populates the same __rigGraphs the MM path
                // reads and we'd wrongly treat it as a world-space matcher graph.
                if (!inst.bpAnim && inst.anim >= 0 && jsHasBonePhys(host.ctx(), inst.id))
                    inst.bpAnim = true;
                if (inst.bpAnim) {
                    // Sample the clip to per-node local TRS, drive + physick the JS
                    // graph, then skin from its (glb-LOCAL) world matrices. The graph
                    // is glb-local, so draw with the element model (unlike MM).
                    rigPoseLocals(inst.rig, inst.anim, animT, gLocals);
                    jsBonePhysStep(host.ctx(), inst.id, gLocals, stepDt);
                    if (jsRigWorlds(host.ctx(), inst.id, worlds)) {
                        poseRigFromWorlds(inst.rig, worlds.data(), (int)(worlds.size() / 16), inst.cpu);
                        for (size_t i = 0; i < inst.meshes.size(); i++)
                            gfx.updateMesh(inst.meshes[i], inst.cpu[i].verts.data(), inst.cpu[i].verts.size());
                    }
                } else if (jsRigWorlds(host.ctx(), inst.id, worlds)) {
                    // motion-matching posed the bone graph in JS — the skinned verts already
                    // carry the character's WORLD transform, so draw with IDENTITY.
                    poseRigFromWorlds(inst.rig, worlds.data(), (int)(worlds.size() / 16), inst.cpu);
                    for (size_t i = 0; i < inst.meshes.size(); i++)
                        gfx.updateMesh(inst.meshes[i], inst.cpu[i].verts.data(), inst.cpu[i].verts.size());
                    drawModel = identity();
                } else if (inst.anim >= 0) {   // glTF clip
                    poseRig(inst.rig, inst.anim, animT, inst.cpu);
                    for (size_t i = 0; i < inst.meshes.size(); i++)
                        gfx.updateMesh(inst.meshes[i], inst.cpu[i].verts.data(), inst.cpu[i].verts.size());
                }
                // else: skinned, matcher not built yet — dynamic mesh holds bind pose
            }
            float dx = (float)v[0] - eye.x, dz = -(float)v[2] - eye.z;
            for (size_t i = 0; i < inst.meshes.size(); i++) {
                bool tr = (i < inst.transparent.size()) ? (bool)inst.transparent[i]
                                                        : (i < inst.cpu.size() && inst.cpu[i].transparent);
                drawList.push_back({ inst.meshes[i], drawModel, inst.texes[i], inst.cutoffs[i], tr, dx*dx + dz*dz });
            }
        }

        // 1b) Scatter (§18.23): each archetype's copies render as GPU INSTANCES —
        // one draw call per archetype mesh for ALL its copies (trees/props). The
        // matrices are collected here and drawn instanced in the shadow + main
        // passes below (opaque dressing).
        struct ScatterGroup { MeshHandle mesh; TexHandle tex; float cutoff; std::vector<Mat4> models; };
        std::vector<ScatterGroup> scatterGroups;
        {
            std::string sc = jsCallStr(host.ctx(), "__scatterElements");
            const size_t npos = std::string::npos;
            size_t sp = 0;
            while (sp < sc.size()) {
                size_t nl = sc.find('\n', sp);
                std::string line = sc.substr(sp, nl==npos ? npos : nl-sp);
                sp = (nl==npos) ? sc.size() : nl+1;
                if (line.empty()) continue;
                size_t t1 = line.find('\t'); if (t1==npos) continue;
                size_t t2 = line.find('\t', t1+1); if (t2==npos) continue;
                std::string id = line.substr(0, t1);
                bool snap = line[t1+1] == '1';
                std::string rowsStr = line.substr(t2+1);
                // find the archetype inst + its live transform
                Instance* arch = nullptr; for (auto& in : insts) if (in.id == id) { arch = &in; break; }
                if (!arch || arch->meshes.empty()) continue;
                double av[10]; if (!jsXform(host.ctx(), id, av)) continue;
                if (std::fabs(av[6]) < 0.05 && arch->bindH > 0.5) { av[6]=av[7]=av[8]=1.0; }
                // archetype foot (glb-local lowest y) for ground snap
                float footLocal = 0.f;
                if (snap) { Vec3 lo{1e9f,1e9f,1e9f}, hi{-1e9f,-1e9f,-1e9f}; meshBounds(arch->cpu, lo, hi);
                            if (lo.y < 1e8f) footLocal = -lo.y; }
                std::vector<Mat4> copyModels;
                // parse rows: x,y,z,yaw,scale ; ...
                size_t rp = 0;
                while (rp < rowsStr.size()) {
                    size_t semi = rowsStr.find(';', rp);
                    std::string row = rowsStr.substr(rp, semi==npos ? npos : semi-rp);
                    rp = (semi==npos) ? rowsStr.size() : semi+1;
                    if (row.empty()) continue;
                    double r[5] = {0,0,0,0,1}; { const char* p = row.c_str(); char* e = nullptr;
                        for (int k=0;k<5;k++){ r[k]=strtod(p,&e); if(e==p)break; p=(*e==',')?e+1:e; } }
                    double cx=r[0], cy=r[1], cz=r[2], yaw=r[3], k=r[4];
                    double posY = cy;
                    if (snap) { double gy = groundAtXZ(cx, cz, std::fabs(cy)+50.0);
                                posY = gy + footLocal * av[7] * k + cy; }
                    // copy transform: archetype rotation + yaw about up, scale*k
                    double cv[10] = { cx, posY, cz, av[3], av[4] + yaw, av[5],
                                      av[6]*k, av[7]*k, av[8]*k, av[9] };
                    copyModels.push_back(elemModelLH(cv));
                }
                if (copyModels.empty()) continue;
                // one instance group per archetype mesh, all copies in it
                for (size_t i = 0; i < arch->meshes.size(); i++)
                    scatterGroups.push_back({ arch->meshes[i], arch->texes[i], arch->cutoffs[i], copyModels });
            }
        }

        // 2) Shadow depth pass (opaque casters) from the sun's view.
        gfx.beginShadowPass();
        for (const auto& dr : drawList) if (!dr.transparent) gfx.drawMeshShadow(dr.mesh, dr.model);
        for (const auto& sg : scatterGroups) gfx.drawMeshInstancedShadow(sg.mesh, sg.models.data(), sg.models.size());
        gfx.endShadowPass();

        // 3) Main pass: sky + opaque, then transparent sorted back-to-front.
        gfx.beginFrame(0.10f, 0.11f, 0.13f);
        for (const auto& dr : drawList) if (!dr.transparent) gfx.drawMesh(dr.mesh, dr.model, dr.tex, dr.cutoff, false);
        for (const auto& sg : scatterGroups) gfx.drawMeshInstanced(sg.mesh, sg.models.data(), sg.models.size(), sg.tex, sg.cutoff);
        std::sort(drawList.begin(), drawList.end(), [](const Draw& a, const Draw& b){ return a.depth > b.depth; });
        for (const auto& dr : drawList) if (dr.transparent) gfx.drawMesh(dr.mesh, dr.model, dr.tex, dr.cutoff, true);

        // 3b) Particle FX: renderer-owned sim (mirrors render3d) + camera-facing
        // billboards into the HDR scene target (so they tonemap with the frame).
        {
            std::string fxTsv = jsCallStr(host.ctx(), "__fxElements");
            // camera basis in render space, for billboarding
            Vec3 fwd = { target.x-eye.x, target.y-eye.y, target.z-eye.z };
            float fl = std::sqrt(fwd.x*fwd.x+fwd.y*fwd.y+fwd.z*fwd.z); if (fl<1e-6f) fl=1; fwd.x/=fl; fwd.y/=fl; fwd.z/=fl;
            Vec3 rgt = { -fwd.z, 0.f, fwd.x };   // cross(fwd, worldUp)
            float rl = std::sqrt(rgt.x*rgt.x+rgt.z*rgt.z); if (rl<1e-6f) rl=1; rgt.x/=rl; rgt.z/=rl;
            Vec3 upv = { rgt.y*fwd.z - rgt.z*fwd.y, rgt.z*fwd.x - rgt.x*fwd.z, rgt.x*fwd.y - rgt.y*fwd.x };
            float dtp = dt > 0.1 ? 0.1f : (float)dt;
            std::vector<Gfx::ParticleVert> addV, ovV;
            std::set<std::string> fxSeen;
            const size_t npos = std::string::npos;
            size_t pp = 0;
            while (pp < fxTsv.size()) {
                size_t nl = fxTsv.find('\n', pp);
                std::string line = fxTsv.substr(pp, nl==npos ? npos : nl-pp);
                pp = (nl==npos) ? fxTsv.size() : nl+1;
                if (line.empty()) continue;
                std::vector<std::string> f; size_t q = 0;
                while (true) { size_t t = line.find('\t', q); f.push_back(line.substr(q, t==npos?npos:t-q)); if (t==npos) break; q = t+1; }
                if (f.size() < 10) continue;
                const std::string& id = f[0]; const std::string& kind = f[1];
                bool loop = f[2]=="1"; int burst = std::atoi(f[3].c_str()); float scl = (float)std::atof(f[4].c_str());
                bool anchored = f[6]=="1";
                float rax = (float)std::atof(f[7].c_str()), ray = (float)std::atof(f[8].c_str()), raz = -(float)std::atof(f[9].c_str());
                fxSeen.insert(id);
                auto it = fxEmitters.find(id);
                if (it == fxEmitters.end() || it->second.kind != kind) {
                    FxEmitter em; em.kind = kind; em.p = fxPreset(kind);
                    em.pool.assign(em.p.count, FxParticle{});
                    for (auto& q2 : em.pool) { q2.age = 1e9f; q2.life = 1.f; }
                    em.cr = em.p.cr; em.cg = em.p.cg; em.cb = em.p.cb;
                    if (!f[5].empty()) fxParseHexColor(f[5], em.cr, em.cg, em.cb);
                    fxEmitters[id] = std::move(em); it = fxEmitters.find(id);
                }
                FxEmitter& em = it->second; const FxPreset& pr = em.p;
                bool doBurst = anchored && burst != em.lastBurst; em.lastBurst = burst;
                for (auto& q2 : em.pool) {
                    if (q2.age < q2.life) { q2.age += dtp; if (q2.age < 0) continue;
                        q2.vy += (pr.lift + pr.gravity)*dtp; q2.px += q2.vx*dtp; q2.py += q2.vy*dtp; q2.pz += q2.vz*dtp; }
                    else if (doBurst) fxSpawn(em, q2, rax, ray, raz, 0.f);
                    else if (loop && anchored) fxSpawn(em, q2, rax, ray, raz, fxRand()*0.2f);
                    else continue;
                    if (q2.age < 0 || q2.age >= q2.life) continue;
                    float t = q2.age / q2.life; if (t < 0) t = 0;
                    float alpha = pr.maxAlpha * (1-t) * std::min(1.f, t*8.f);
                    float hs = q2.size0 * (1 + pr.grow*t) * scl * 0.5f;
                    Vec3 P[4] = {
                        { q2.px - rgt.x*hs - upv.x*hs, q2.py - rgt.y*hs - upv.y*hs, q2.pz - rgt.z*hs - upv.z*hs },
                        { q2.px + rgt.x*hs - upv.x*hs, q2.py + rgt.y*hs - upv.y*hs, q2.pz + rgt.z*hs - upv.z*hs },
                        { q2.px + rgt.x*hs + upv.x*hs, q2.py + rgt.y*hs + upv.y*hs, q2.pz + rgt.z*hs + upv.z*hs },
                        { q2.px - rgt.x*hs + upv.x*hs, q2.py - rgt.y*hs + upv.y*hs, q2.pz - rgt.z*hs + upv.z*hs },
                    };
                    const float uv[4][2] = { {0,1},{1,1},{1,0},{0,0} };
                    const int tri[6] = { 0,1,2, 0,2,3 };
                    std::vector<Gfx::ParticleVert>& V = pr.add ? addV : ovV;
                    for (int k = 0; k < 6; k++) { int j = tri[k];
                        V.push_back({ P[j].x, P[j].y, P[j].z, uv[j][0], uv[j][1], em.cr, em.cg, em.cb, alpha }); }
                }
            }
            for (auto it2 = fxEmitters.begin(); it2 != fxEmitters.end(); ) {
                if (!fxSeen.count(it2->first)) it2 = fxEmitters.erase(it2); else ++it2;
            }
            if (!ovV.empty())  gfx.drawParticles(ovV.data(),  ovV.size(),  false);
            if (!addV.empty()) gfx.drawParticles(addV.data(), addV.size(), true);
        }

        double drawMs = (plat.now() - drawT0) * 1000.0;
        if (frames < 14) std::printf("  frame %lld: tick %.0f ms (x%d), draw/skin %.0f ms\n", frames, tickMs, steps, drawMs);
        gfx.endFrame();

        // ---- UI overlay: control hint + active dialogue (native 2D text) ----
        if (g_fontOK) {
            int W = plat.width(), H = plat.height();
            std::vector<OV> box, txt;
            { const char* hint = "WASD move   LMB look   Shift run   Space jump   F5 save   F9 load   F6 menu   Esc quit";
              float hs = 0.34f, hw = textWidth(g_font, hint, hs);
              emitRect(box, 10.0f, H - 32.0f, hw + 20.0f, 26.0f, 0,0,0, 0.35f);
              emitText(txt, g_font, 20.0f, H - 30.0f, hs, hint, 1,1,1, 0.85f); }
            // dialogue (if a tree is open)
            JSContext* c = host.ctx(); JSValue g = JS_GetGlobalObject(c);
            JSValue fn = JS_GetPropertyStr(c, g, "__dlgInfo");
            JSValue o = JS_Call(c, fn, g, 0, nullptr);
            if (JS_IsObject(o)) {
                auto grabStr = [&](const char* k)->std::string { JSValue v = JS_GetPropertyStr(c, o, k);
                    const char* s = JS_ToCString(c, v); std::string r = s ? s : ""; if (s) JS_FreeCString(c, s); JS_FreeValue(c, v); return r; };
                std::string spk = grabStr("speaker"), body = grabStr("text");
                JSValue selv = JS_GetPropertyStr(c, o, "sel"); int32_t sel = 0; JS_ToInt32(c, &sel, selv); JS_FreeValue(c, selv);
                std::vector<std::string> opts;
                JSValue ov = JS_GetPropertyStr(c, o, "options");
                JSValue lv = JS_GetPropertyStr(c, ov, "length"); uint32_t on = 0; JS_ToUint32(c, &on, lv); JS_FreeValue(c, lv);
                for (uint32_t i = 0; i < on && i < 12; i++) { JSValue ev = JS_GetPropertyUint32(c, ov, i);
                    const char* s = JS_ToCString(c, ev); if (s) { opts.push_back(s); JS_FreeCString(c, s); } JS_FreeValue(c, ev); }
                JS_FreeValue(c, ov);
                float bx = W*0.09f, bw = W*0.82f, by = H*0.60f;
                float bh = H*0.36f;
                emitRect(box, bx-22, by-22, bw+44, bh+22, 0,0,0, 0.60f);
                float ty = by;
                if (!spk.empty()) { emitText(txt, g_font, bx, ty, 0.40f, spk, 0.75f,0.78f,0.85f, 0.9f); ty += 30; }
                ty = emitWrapped(txt, g_font, bx, ty, 0.52f, body, bw, 30.0f, 1,1,1, 1.0f);
                ty += 12;
                for (size_t i = 0; i < opts.size(); i++) { bool onSel = (int)i == sel;
                    std::string line = (onSel ? "> " : "   ") + opts[i];
                    emitText(txt, g_font, bx, ty, 0.48f, line, 1,1,1, onSel ? 1.0f : 0.42f); ty += 30; }
            }
            JS_FreeValue(c, o); JS_FreeValue(c, fn); JS_FreeValue(c, g);

            // ---- save/load menu (F6) ----
            if (menuOpen) {
                float mw = W*0.56f, mx = (W-mw)*0.5f, my = H*0.15f, rowH = 34.0f;
                int nRows = (int)menuRows.size() + 1;
                emitRect(box, mx-24, my-24, mw+48, 96.0f + nRows*rowH + 24.0f, 0,0,0, 0.80f);
                emitText(txt, g_font, mx, my, 0.62f, "SAVE / LOAD", 1,1,1, 1.0f);
                emitText(txt, g_font, mx, my+32, 0.30f,
                         "Up/Down select    Enter load/new    Del delete    F5 quicksave    F9 quickload    F6 close",
                         0.68f,0.72f,0.82f, 0.9f);
                float ry = my + 72;
                for (int i = 0; i < (int)menuRows.size(); i++) { bool on = i == menuSel;
                    emitText(txt, g_font, mx, ry, 0.50f, std::string(on?"> ":"   ") + menuRows[i].first,
                             1,1,1, on?1.0f:0.5f);
                    if (!menuRows[i].second.empty())
                        emitText(txt, g_font, mx + mw*0.40f, ry+2, 0.32f, menuRows[i].second, 0.7f,0.74f,0.82f, on?0.9f:0.45f);
                    ry += rowH; }
                bool onNew = menuSel >= (int)menuRows.size();
                emitText(txt, g_font, mx, ry, 0.50f, std::string(onNew?"> ":"   ") + "+  New save slot",
                         0.6f, 0.85f, 0.6f, onNew?1.0f:0.55f);
            }
            // ---- toast (save/load feedback), fades over the last 0.5 s ----
            if (!toast.empty() && plat.now() - toastAt < 2.5) {
                float a = (float)((2.5 - (plat.now()-toastAt)) / 0.5); if (a > 1) a = 1; if (a < 0) a = 0;
                float tw = textWidth(g_font, toast.c_str(), 0.44f);
                emitRect(box, (W-tw)*0.5f - 16, H*0.11f - 6, tw + 32, 32, 0,0,0, 0.6f*a);
                emitText(txt, g_font, (W-tw)*0.5f, H*0.11f, 0.44f, toast, 1,1,1, a);
            }

            if (!box.empty()) gfx.drawOverlay(box.data(), box.size(), TexHandle{ 1 });   // 1 = white
            if (!txt.empty()) gfx.drawOverlay(txt.data(), txt.size(), g_fontTex);
        }

        // --talk: once MM is ready, fire the interaction a few seconds before
        // the shot so the dialogue opens and its cinematic camera composes.
        if (!talkTarget.empty() && !talked && jsCallStr(host.ctx(), "__mmAllReady") == "true"
            && plat.now() >= (shotAt > 3 ? shotAt - 3 : shotAt * 0.5)) {
            JSContext* c = host.ctx(); JSValue g = JS_GetGlobalObject(c);
            JSValue fn = JS_GetPropertyStr(c, g, "__debugTalk");
            JSValue av = JS_NewString(c, talkTarget.c_str());
            JSValue r = JS_Call(c, fn, g, 1, &av);
            const char* s = JS_ToCString(c, r);
            if (s) { std::printf("--talk %s: %s\n", talkTarget.c_str(), s); JS_FreeCString(c, s); }
            JS_FreeValue(c, r); JS_FreeValue(c, av); JS_FreeValue(c, fn); JS_FreeValue(c, g);
            talked = true;
        }

        // --spawntest: clone a model element at runtime (scene.add + rescan) to
        // prove the renderer picks up runtime spawns.
        if (!spawnName.empty() && !spawned && jsCallStr(host.ctx(), "__mmAllReady") == "true"
            && plat.now() >= (shotAt > 3 ? shotAt - 3 : shotAt * 0.5)) {
            JSContext* c = host.ctx(); JSValue g = JS_GetGlobalObject(c);
            JSValue fn = JS_GetPropertyStr(c, g, "__spawnTest");
            JSValue av[2] = { JS_NewString(c, spawnName.c_str()), JS_NewFloat64(c, -3.0) };
            JSValue r = JS_Call(c, fn, g, 2, av);
            const char* s = JS_ToCString(c, r);
            if (s) { std::printf("--spawntest %s: %s\n", spawnName.c_str(), s); JS_FreeCString(c, s); }
            JS_FreeValue(c, r); JS_FreeValue(c, av[0]); JS_FreeValue(c, av[1]); JS_FreeValue(c, fn); JS_FreeValue(c, g);
            spawned = true;
        }

        // --fxtest: spawn a visible looping particle emitter to prove the sim.
        if (!fxTestKind.empty() && !fxTested && jsCallStr(host.ctx(), "__mmAllReady") == "true"
            && plat.now() >= (shotAt > 3 ? shotAt - 3 : shotAt * 0.5)) {
            JSContext* c = host.ctx(); JSValue g = JS_GetGlobalObject(c);
            JSValue fn = JS_GetPropertyStr(c, g, "__fxTest");
            JSValue av = JS_NewString(c, fxTestKind.c_str());
            JSValue r = JS_Call(c, fn, g, 1, &av);
            const char* s = JS_ToCString(c, r);
            if (s) { std::printf("--fxtest: %s\n", s); JS_FreeCString(c, s); }
            JS_FreeValue(c, r); JS_FreeValue(c, av); JS_FreeValue(c, fn); JS_FreeValue(c, g);
            fxTested = true;
        }

        // --fxbonetest: anchor a looping flame to a bone of the Commander.
        if (fxBoneTest && !fxBoned && jsCallStr(host.ctx(), "__mmAllReady") == "true"
            && plat.now() >= (shotAt > 3 ? shotAt - 3 : shotAt * 0.5)) {
            std::printf("--fxbonetest: %s\n", jsCallStr(host.ctx(), "__addFxBoneTest").c_str());
            fxBoned = true;
        }

        // --scattertest: make the Commander a scatter archetype (a ring of copies).
        if (scatterTest && !scattered && jsCallStr(host.ctx(), "__mmAllReady") == "true"
            && plat.now() >= (shotAt > 3 ? shotAt - 3 : shotAt * 0.5)) {
            std::printf("--scattertest: %s\n", jsCallStr(host.ctx(), "__addScatterTest").c_str());
            scattered = true;
        }

        // --gotoscene: switch scenes, then TOGGLE back and forth every ~1.5 s to
        // stress teardown/rebuild — the GPU-mesh live count must stay bounded.
        static double lastSwitchT = 0; static int switchCount = 0;
        if (gotoTest && plat.now() >= 9.0
            && switchCount < 6 && (plat.now() - lastSwitchT) > 1.5) {
            std::printf("--gotoscene[%d]: %s\n", switchCount, jsCallStr(host.ctx(), "__gotoTestScene").c_str());
            lastSwitchT = plat.now(); switchCount++; wentScene = true;
        }

        // --shot: once MM is built and she's had a moment to move, grab one
        // backbuffer PNG for headless visual verification, then quit. (A scene
        // with no MM characters — e.g. after --gotoscene — reports not-ready, so
        // once we've switched scenes the shot no longer waits on MM.)
        if (!shotPath.empty() && !shotTaken && plat.now() >= shotAt
            && (wentScene || jsCallStr(host.ctx(), "__mmAllReady") == "true")) {
            std::vector<uint8_t> px; int sw = 0, sh = 0;
            if (gfx.screenshot(px, sw, sh) && writePng(shotPath, px.data(), sw, sh))
                std::printf("Screenshot: %dx%d -> %s\n", sw, sh, shotPath.c_str());
            else std::printf("Screenshot FAILED\n");
            shotTaken = true; break;
        }
        gfx.present();

        posT += dt;
        if (posT >= 1.5) { std::printf("  %s\n", jsCallStr(host.ctx(), "__ctrlDump").c_str()); posT = 0; }
        frames++; fpsN++; fpsT += dt;
        if (fpsT >= 0.3) {
            char buf[256];
            std::snprintf(buf, sizeof buf, "%s  —  AE1 native (tick+draw)  |  %.0f fps  frame %lld  %zu elems",
                          man.title.c_str(), fpsN/fpsT, frames, insts.size());
            plat.setTitle(buf); fpsT = 0; fpsN = 0;
        }
    }
    {   // report motion-matching build status
        JSContext* c = host.ctx(); JSValue g = JS_GetGlobalObject(c);
        JSValue fn = JS_GetPropertyStr(c, g, "__mmStatus");
        JSValue r = JS_Call(c, fn, g, 0, nullptr);
        const char* s = JS_ToCString(c, r);
        if (s) { std::printf("motion-matching: %s\n", s); JS_FreeCString(c, s); }
        JS_FreeValue(c, r); JS_FreeValue(c, fn); JS_FreeValue(c, g);
    }
    {   // §errscan: surface any unique errors the tick swallowed this run
        std::string errs = jsCallStr(host.ctx(), "__dumpErrs");
        if (!errs.empty()) std::printf("\n=== tick errors (deduped) ===\n%s\n=== end ===\n", errs.c_str());
    }
    for (auto& inst : insts) if (inst.rig) freeGlbRig(inst.rig);
    gfx.shutdown(); host.shutdown();
    std::printf("Ran %lld frames. The engine ticked and drew itself natively.\n", frames);
    return 0;
}
