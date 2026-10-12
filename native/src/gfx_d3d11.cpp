// gfx_d3d11.cpp — D3D11 implementation of the Gfx seam (see gfx.hpp).
//
// Owns the device, swapchain, depth buffer, a single forward shader (compiled
// from inline HLSL at startup), and per-mesh vertex/index buffers. This is the
// low-level RHI; bgfx would replace THIS file behind gfx.hpp. Lighting here is a
// placeholder lambert — three.js material parity comes as the renderer matures.
#include "gfx.hpp"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <d3dcompiler.h>

#include <vector>
#include <cstdio>
#include <cstring>
#include <cmath>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "d3dcompiler.lib")

namespace ae1 {

struct GpuMesh {
    ID3D11Buffer* vb = nullptr;
    ID3D11Buffer* ib = nullptr;
    UINT icount = 0;
    UINT vcap = 0;      // vertex capacity (for dynamic updates)
    float metallic = 0.0f, roughness = 0.7f;   // pbrMetallicRoughness factors
    bool dynamic = false;
};
struct GpuTex {
    ID3D11Texture2D* tex = nullptr;
    ID3D11ShaderResourceView* srv = nullptr;
};

// Matches the HLSL cbuffer (16-byte aligned).
struct CbData {
    Mat4  model;
    Mat4  viewProj;
    float lightDir[4];    // xyz travel dir
    float lightColor[4];  // rgb, w = ambient
    float params[4];      // x = alphaCutoff, y = shadow texel, z = metallic, w = roughness
    float envColor[4];    // rgb = average sky radiance, w = envIntensity
    float camPos[4];      // xyz world eye (view vector for PBR specular)
    Mat4  lightViewProj;
};
struct FxCb {
    Mat4  invViewProj;
    float camPos[4];
    float skyParams[4];   // x=opacity, y=rotation, z=exposure, w=grain time
    float dofParams[4];   // x=focus dist, y=range, z=max blur (uv), w=aspect (h/w)
    float rcpFrame[4];    // xy = 1/width, 1/height (FXAA)
};

static const char* kHLSL = R"HLSL(
cbuffer Cb : register(b0) {
    row_major float4x4 model;
    row_major float4x4 viewProj;
    float4 lightDir;
    float4 lightColor;   // rgb, w = ambient
    float4 params;       // x = alphaCutoff, y = shadow texel (0 = no shadows), z = metallic, w = roughness
    float4 envColor;     // rgb = average sky radiance, w = envIntensity
    float4 camPos;       // xyz world eye
    row_major float4x4 lightViewProj;
};
Texture2D    baseTex : register(t0);
SamplerState samp    : register(s0);
Texture2D               shadowMap  : register(t1);
SamplerComparisonState  shadowSamp : register(s1);

struct VSIn  { float3 pos : POSITION; float3 nrm : NORMAL; float2 uv : TEXCOORD0; float3 col : COLOR; };
struct VSOut { float4 pos : SV_POSITION; float3 nrm : NORMAL; float2 uv : TEXCOORD0; float3 col : COLOR; float3 wpos : TEXCOORD1; };

VSOut VSMain(VSIn i) {
    VSOut o;
    float4 wp = mul(float4(i.pos, 1.0), model);
    o.pos = mul(wp, viewProj);
    o.nrm = mul(float4(i.nrm, 0.0), model).xyz;
    o.uv = i.uv;
    o.col = i.col;
    o.wpos = wp.xyz;
    return o;
}
// Instanced variants: the per-instance model matrix arrives as 4 instance-rate
// rows (INSTMTX0..3, input slot 1) instead of the cbuffer `model` — one draw
// call for N scatter copies. The pixel shader is shared (PSMain / the shadow
// depth), and per-mesh material/lights stay in the cbuffer (shared per draw).
struct InstIn { float3 pos:POSITION; float3 nrm:NORMAL; float2 uv:TEXCOORD0; float3 col:COLOR;
                float4 m0:INSTMTX0; float4 m1:INSTMTX1; float4 m2:INSTMTX2; float4 m3:INSTMTX3; };
VSOut InstVSMain(InstIn i) {
    VSOut o;
    row_major float4x4 im = float4x4(i.m0, i.m1, i.m2, i.m3);
    float4 wp = mul(float4(i.pos, 1.0), im);
    o.pos = mul(wp, viewProj);
    o.nrm = mul(float4(i.nrm, 0.0), im).xyz;
    o.uv = i.uv; o.col = i.col; o.wpos = wp.xyz;
    return o;
}
float4 InstShVS(InstIn i) : SV_POSITION {
    row_major float4x4 im = float4x4(i.m0, i.m1, i.m2, i.m3);
    float4 wp = mul(float4(i.pos, 1.0), im);
    return mul(wp, lightViewProj);
}
// Depth-only pass from the sun's view (fills the shadow map).
float4 ShVS(VSIn i) : SV_POSITION {
    float4 wp = mul(float4(i.pos, 1.0), model);
    return mul(wp, lightViewProj);
}
float sampleShadow(float3 wpos, float ndotl) {
    if (params.y <= 0.0) return 1.0;                    // shadows off
    float4 lp = mul(float4(wpos, 1.0), lightViewProj);
    lp.xyz /= lp.w;
    float2 suv = lp.xy * float2(0.5, -0.5) + 0.5;
    if (any(suv < 0.0) || any(suv > 1.0) || lp.z > 1.0) return 1.0;
    float bias = max(0.0025 * (1.0 - ndotl), 0.0008);
    float t = params.y, sum = 0.0;
    [unroll] for (int y = -1; y <= 1; y++)
        [unroll] for (int x = -1; x <= 1; x++)
            sum += shadowMap.SampleCmpLevelZero(shadowSamp, suv + float2(x, y) * t, lp.z - bias);
    return sum / 9.0;
}
static const float PI = 3.14159265;
float4 PSMain(VSOut i) : SV_TARGET {
    float4 tex = baseTex.Sample(samp, i.uv);
    if (params.x > 0.0 && tex.a < params.x) discard;   // alpha test (MASK / cutout)
    // base color textures are sRGB in a UNORM (linear-sampled) texture — linearize
    // before lighting; the composite re-encodes once at the end.
    float3 albedo = pow(max(tex.rgb, 0.0), 2.2) * i.col;
    float metallic  = saturate(params.z);
    float rough     = clamp(params.w, 0.045, 1.0);

    float3 N = normalize(i.nrm);
    float3 V = normalize(camPos.xyz - i.wpos);
    float3 L = normalize(-lightDir.xyz);
    float3 H = normalize(V + L);
    float NdotL = saturate(dot(N, L));
    float NdotV = saturate(dot(N, V)) + 1e-4;
    float NdotH = saturate(dot(N, H));
    float VdotH = saturate(dot(V, H));

    // Cook-Torrance specular (GGX / Smith-Schlick / Fresnel-Schlick).
    float3 F0 = lerp(float3(0.04, 0.04, 0.04), albedo, metallic);
    float a = rough * rough, a2 = a * a;
    float dnm = NdotH * NdotH * (a2 - 1.0) + 1.0;
    float D = a2 / (PI * dnm * dnm);
    float kg = (rough + 1.0); kg = kg * kg / 8.0;
    float G = (NdotV / (NdotV * (1.0 - kg) + kg)) * (NdotL / (NdotL * (1.0 - kg) + kg));
    float3 F = F0 + (1.0 - F0) * pow(1.0 - VdotH, 5.0);
    float3 spec = (D * G * F) / (4.0 * NdotV * NdotL + 1e-4);
    float3 kd = (1.0 - F) * (1.0 - metallic);

    float sh = sampleShadow(i.wpos, NdotL);
    float3 direct = (kd * albedo / PI + spec) * lightColor.rgb * NdotL * sh;

    // Ambient (image-based, approximated): diffuse fill on the albedo (metals take
    // less), plus a Fresnel grazing term tinted by F0 so metal edges catch the sky.
    float3 ambCol = lightColor.w + envColor.rgb * envColor.w;
    float3 Fr = F0 + (max(1.0 - rough, F0.r) - F0) * pow(1.0 - NdotV, 5.0);
    float3 ambient = ambCol * albedo * kd + ambCol * Fr * (metallic * 0.7 + 0.08);

    float3 c = direct + ambient;
    return float4(c, tex.a);  // alpha used by the transparent (blended) pass; ignored when opaque
}
)HLSL";

// Fullscreen passes: the equirect skybox background, and the HDR->display
// tonemap composite. Both draw one big triangle from SV_VertexID (no vbuffer).
static const char* kFxHLSL = R"HLSL(
Texture2D    fxTex : register(t0);   // sky pass: env equirect | composite: sceneColor
SamplerState fxSamp: register(s0);
cbuffer Fx : register(b1) {
    row_major float4x4 invViewProj;
    float4 camPos;      // xyz world eye
    float4 skyParams;   // x=opacity, y=rotation(rad), z=exposure, w=grain time
    float4 dofParams;   // x=focus, y=range, z=maxBlur(uv), w=aspect(h/w)
    float4 rcpFrame;    // xy = 1/width, 1/height (FXAA)
};
Texture2D depthTex : register(t2);   // composite: scene depth for DOF
struct FsOut { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };
FsOut FsVS(uint id : SV_VertexID) {
    FsOut o;
    float2 p = float2((id << 1) & 2, id & 2);      // (0,0) (2,0) (0,2)
    o.uv  = p;
    o.pos = float4(p.x * 2 - 1, 1 - p.y * 2, 0, 1); // covers the screen
    return o;
}
static const float PI = 3.14159265;
float4 SkyPS(FsOut i) : SV_TARGET {
    float2 ndc = float2(i.uv.x * 2 - 1, 1 - i.uv.y * 2);
    float4 wp = mul(float4(ndc, 1, 1), invViewProj);
    float3 dir = normalize(wp.xyz / wp.w - camPos.xyz);
    float s = sin(skyParams.y), c = cos(skyParams.y);   // spin about Y
    float3 d = float3(c * dir.x - s * dir.z, dir.y, s * dir.x + c * dir.z);
    float u = atan2(d.x, d.z) / (2 * PI) + 0.5;
    float v = acos(clamp(d.y, -1.0, 1.0)) / PI;
    float3 col = fxTex.SampleLevel(fxSamp, float2(u, v), 0).rgb;
    return float4(col * skyParams.x, 1.0);
}
// AgX (Minimal, Benjamin Wrensch / Filament fit) — the AE1 grade (§18.88).
float3 agxContrast(float3 x) {
    float3 x2 = x * x, x4 = x2 * x2;
    return 15.5*x4*x2 - 40.14*x4*x + 31.96*x4 - 6.868*x2*x + 0.4298*x2 + 0.1191*x - 0.00232;
}
float3 agx(float3 v) {
    const float3x3 M = float3x3(0.842479062253094, 0.0784335999999992, 0.0792237451477643,
                                0.0423282422610123, 0.878468636469772, 0.0791661274605434,
                                0.0423756549057051, 0.0784336,          0.879142973793104);
    const float mn = -12.47393, mx = 4.026069;
    v = mul(M, v);
    v = clamp(log2(max(v, 1e-10)), mn, mx);
    v = (v - mn) / (mx - mn);
    return agxContrast(v);
}
float3 agxEotf(float3 v) {
    const float3x3 Mi = float3x3( 1.19687900512017,  -0.0980208811401368, -0.0990297440797205,
                                 -0.0528968517574562,  1.15190312990417,   -0.0989611768448433,
                                 -0.0529716355144438, -0.0980434501171241,  1.15107367264116);
    return mul(Mi, v);
}
static const float2 DISC[12] = {
    float2( 0.000, 1.000), float2( 0.866, 0.500), float2( 0.866,-0.500),
    float2( 0.000,-1.000), float2(-0.866,-0.500), float2(-0.866, 0.500),
    float2( 0.500, 0.500), float2( 0.500,-0.500), float2(-0.500,-0.500),
    float2(-0.500, 0.500), float2( 0.300, 0.000), float2(-0.300, 0.000)
};
float4 CompPS(FsOut i) : SV_TARGET {
    // depth-of-field: circle-of-confusion from distance to the focus plane, then
    // a disc blur of the HDR scene scaled by CoC (background/foreground soften).
    float depth = depthTex.SampleLevel(fxSamp, i.uv, 0).r;
    float dist;
    if (depth >= 0.99999) dist = 1e6;                  // sky at infinity
    else {
        float2 ndc = float2(i.uv.x * 2 - 1, 1 - i.uv.y * 2);
        float4 wp = mul(float4(ndc, depth, 1), invViewProj);
        dist = length(wp.xyz / wp.w - camPos.xyz);
    }
    float coc = saturate(abs(dist - dofParams.x) / max(dofParams.y, 0.001));
    float rad = coc * dofParams.z;
    float3 hdr = fxTex.SampleLevel(fxSamp, i.uv, 0).rgb;
    if (rad > 0.0008) {
        float3 sum = hdr; float wsum = 1.0;
        [unroll] for (int k = 0; k < 12; k++) {
            float2 o = DISC[k] * float2(rad * dofParams.w, rad);
            sum += fxTex.SampleLevel(fxSamp, i.uv + o, 0).rgb; wsum += 1.0;
        }
        hdr = sum / wsum;
    }
    float3 c = agxEotf(agx(hdr * skyParams.z));        // exposure -> AgX
    c = pow(max(c, 0.0), 1.0 / 2.2);                   // display encode
    // film grain: subtle animated luminance noise (skyParams.w = time seed).
    float n = frac(sin(dot(i.uv * 1024.0 + skyParams.w, float2(12.9898, 78.233))) * 43758.5453);
    c += (n - 0.5) * 0.02;
    return float4(saturate(c), 1.0);
}
// FXAA (compact, Timothy Lottes) — edge AA on the tonemapped LDR image.
float4 FxaaPS(FsOut i) : SV_TARGET {
    float2 rcp = rcpFrame.xy;
    float3 mid = fxTex.SampleLevel(fxSamp, i.uv, 0).rgb;
    float3 nw = fxTex.SampleLevel(fxSamp, i.uv + float2(-1,-1)*rcp, 0).rgb;
    float3 ne = fxTex.SampleLevel(fxSamp, i.uv + float2( 1,-1)*rcp, 0).rgb;
    float3 sw = fxTex.SampleLevel(fxSamp, i.uv + float2(-1, 1)*rcp, 0).rgb;
    float3 se = fxTex.SampleLevel(fxSamp, i.uv + float2( 1, 1)*rcp, 0).rgb;
    float3 L = float3(0.299, 0.587, 0.114);
    float lM=dot(mid,L), lNW=dot(nw,L), lNE=dot(ne,L), lSW=dot(sw,L), lSE=dot(se,L);
    float lMin = min(lM, min(min(lNW,lNE), min(lSW,lSE)));
    float lMax = max(lM, max(max(lNW,lNE), max(lSW,lSE)));
    if (lMax - lMin < 0.04) return float4(mid, 1.0);   // flat area: skip
    float2 dir = float2(-((lNW+lNE)-(lSW+lSE)), ((lNW+lSW)-(lNE+lSE)));
    float reduce = max((lNW+lNE+lSW+lSE)*0.25*0.125, 1.0/128.0);
    float rcpDir = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
    dir = clamp(dir*rcpDir, -8.0, 8.0) * rcp;
    float3 rgbA = 0.5 * (fxTex.SampleLevel(fxSamp, i.uv + dir*(1.0/3.0-0.5), 0).rgb
                       + fxTex.SampleLevel(fxSamp, i.uv + dir*(2.0/3.0-0.5), 0).rgb);
    float3 rgbB = rgbA*0.5 + 0.25*(fxTex.SampleLevel(fxSamp, i.uv + dir*(-0.5), 0).rgb
                                 + fxTex.SampleLevel(fxSamp, i.uv + dir*( 0.5), 0).rgb);
    float lB = dot(rgbB, L);
    return float4((lB < lMin || lB > lMax) ? rgbA : rgbB, 1.0);
}
)HLSL";

// 2D screen-space overlay (UI). Pixel-space quads -> NDC; samples a texture
// (glyph atlas alpha, or 1x1 white for solid rects) times the vertex colour.
static const char* kOvHLSL = R"HLSL(
Texture2D    ovTex  : register(t0);
SamplerState ovSamp : register(s0);
cbuffer Ov : register(b2) { float4 ovInvRes; };   // xy = 1/width, 1/height
struct OvIn  { float2 pos : POSITION; float2 uv : TEXCOORD0; float4 col : COLOR; };
struct OvOut { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; float4 col : COLOR; };
OvOut OvVS(OvIn i) {
    OvOut o;
    o.pos = float4(i.pos.x * ovInvRes.x * 2 - 1, 1 - i.pos.y * ovInvRes.y * 2, 0, 1);
    o.uv = i.uv; o.col = i.col;
    return o;
}
float4 OvPS(OvOut i) : SV_TARGET { return i.col * ovTex.Sample(ovSamp, i.uv); }
)HLSL";

// Particle billboards: world-space quads transformed by the camera viewProj
// (reuses cbuffer b0 for viewProj), textured by the soft radial sprite, output
// PREMULTIPLIED so one shader serves both additive glows and alpha smoke (the
// blend state picks which). Depth test on, no write — set by drawParticles.
static const char* kPtHLSL = R"HLSL(
cbuffer Cb : register(b0) {
    row_major float4x4 model;
    row_major float4x4 viewProj;
    float4 lightDir; float4 lightColor; float4 params; float4 envColor;
    row_major float4x4 lightViewProj;
};
Texture2D    ptTex  : register(t0);
SamplerState ptSamp : register(s0);
struct PIn  { float3 pos : POSITION; float2 uv : TEXCOORD0; float4 col : COLOR; };
struct POut { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; float4 col : COLOR; };
POut PtVS(PIn i) { POut o; o.pos = mul(float4(i.pos, 1.0), viewProj); o.uv = i.uv; o.col = i.col; return o; }
float4 PtPS(POut i) : SV_TARGET {
    float a = ptTex.Sample(ptSamp, i.uv).a * i.col.a;   // sprite falloff * particle alpha
    return float4(i.col.rgb * a, a);                     // premultiplied
}
)HLSL";

struct Gfx::Impl {
    ID3D11Device*           dev = nullptr;
    ID3D11DeviceContext*    ctx = nullptr;
    IDXGISwapChain*         swap = nullptr;
    ID3D11RenderTargetView* rtv = nullptr;
    ID3D11Texture2D*        depthTex = nullptr;
    ID3D11DepthStencilView* dsv = nullptr;
    ID3D11ShaderResourceView* depthSRV = nullptr;   // depth as SRV (DOF)
    ID3D11DepthStencilState* dss = nullptr;
    ID3D11DepthStencilState* dssReadNoWrite = nullptr;  // transparent: depth-test, no write
    ID3D11RasterizerState*  rs = nullptr;
    ID3D11BlendState*       blendOff = nullptr;
    ID3D11BlendState*       blendOn = nullptr;           // src-alpha over

    // instanced scatter pipeline (per-instance model matrix, one draw for N copies)
    ID3D11VertexShader* instVS = nullptr;
    ID3D11VertexShader* instShVS = nullptr;
    ID3D11InputLayout*  instLayout = nullptr;
    ID3D11Buffer*       instanceVB = nullptr;
    UINT                instanceVBCap = 0;   // matrices
    ID3D11VertexShader* vs = nullptr;
    ID3D11PixelShader*  ps = nullptr;
    ID3D11InputLayout*  layout = nullptr;
    ID3D11Buffer*       cb = nullptr;
    ID3D11SamplerState* samp = nullptr;

    int width = 0, height = 0;
    Mat4 viewProj = identity();
    float lightDir[3] = { -0.4f, -1.0f, -0.5f };
    float lightColor[3] = { 0.70f, 0.70f, 0.70f };
    float ambient = 0.30f;
    std::vector<GpuMesh> meshes;
    std::vector<uint32_t> freeMeshSlots;   // recycled by createMesh after destroyMesh
    std::vector<GpuTex>  textures;   // index 0 = 1x1 white

    // HDR offscreen scene target (skybox + geometry render here in linear HDR,
    // then a fullscreen composite tonemaps it to the display backbuffer).
    ID3D11Texture2D*          sceneTex = nullptr;
    ID3D11RenderTargetView*   sceneRTV = nullptr;
    ID3D11ShaderResourceView* sceneSRV = nullptr;
    // Equirect HDR environment.
    ID3D11Texture2D*          envTex = nullptr;
    ID3D11ShaderResourceView* envSRV = nullptr;
    float skyOpacity = 0.0f, skyRotation = 0.0f, envIntensity = 0.0f, exposure = 1.0f;
    float envColor[3] = { 0, 0, 0 };   // average sky radiance → image-based ambient tint
    float grainT = 0.0f;               // advancing seed for animated film grain
    float dofFocus = 0.0f, dofRange = 0.0f, dofMaxBlur = 0.0f;   // depth of field
    // FX pipeline (fullscreen sky + composite).
    ID3D11VertexShader*  fxVS = nullptr;
    ID3D11PixelShader*   skyPS = nullptr;
    ID3D11PixelShader*   compPS = nullptr;
    ID3D11PixelShader*   fxaaPS = nullptr;
    // LDR result of the composite; FXAA reads it and writes the backbuffer.
    ID3D11Texture2D*          ldrTex = nullptr;
    ID3D11RenderTargetView*   ldrRTV = nullptr;
    ID3D11ShaderResourceView* ldrSRV = nullptr;
    ID3D11Buffer*        fxCb = nullptr;
    ID3D11SamplerState*  fxSamp = nullptr;      // linear clamp
    ID3D11DepthStencilState* dssNone = nullptr; // depth off (fullscreen passes)
    Mat4 invViewProj = identity();
    float camPos[3] = { 0, 0, 0 };

    // 2D overlay (UI).
    ID3D11VertexShader* ovVS = nullptr;
    ID3D11PixelShader*  ovPS = nullptr;
    ID3D11InputLayout*  ovLayout = nullptr;
    ID3D11Buffer*       ovVB = nullptr;
    ID3D11Buffer*       ovCb = nullptr;
    UINT                ovVBCap = 0;   // vertices

    // Particle FX billboards.
    ID3D11VertexShader* ptVS = nullptr;
    ID3D11PixelShader*  ptPS = nullptr;
    ID3D11InputLayout*  ptLayout = nullptr;
    ID3D11Buffer*       ptVB = nullptr;
    UINT                ptVBCap = 0;
    ID3D11BlendState*   blendAddPM = nullptr;   // premultiplied additive (glows)
    ID3D11BlendState*   blendOverPM = nullptr;  // premultiplied over (smoke)
    uint32_t            ptSprite = 1;           // soft radial sprite texture handle

    // Shadow map (depth from the sun's view; PCF-sampled in the main pass).
    static const int SHADOW_RES = 2048;
    ID3D11Texture2D*          shadowTex = nullptr;
    ID3D11DepthStencilView*   shadowDSV = nullptr;
    ID3D11ShaderResourceView* shadowSRV = nullptr;
    ID3D11VertexShader*       shVS = nullptr;
    ID3D11SamplerState*       shadowSamp = nullptr;   // comparison
    Mat4  lightViewProj = identity();
    Vec3  shadowCenter = { 0, 0, 0 };
    float shadowRadius = 0.0f;                        // 0 => shadows disabled

    bool createTargets() {
        ID3D11Texture2D* back = nullptr;
        if (FAILED(swap->GetBuffer(0, __uuidof(ID3D11Texture2D), (void**)&back))) return false;
        HRESULT hr = dev->CreateRenderTargetView(back, nullptr, &rtv);
        back->Release();
        if (FAILED(hr)) return false;

        D3D11_TEXTURE2D_DESC dd = {};
        dd.Width = (UINT)width; dd.Height = (UINT)height;
        dd.MipLevels = 1; dd.ArraySize = 1;
        dd.Format = DXGI_FORMAT_R24G8_TYPELESS;   // typeless so it reads back as an SRV (DOF)
        dd.SampleDesc.Count = 1;
        dd.Usage = D3D11_USAGE_DEFAULT;
        dd.BindFlags = D3D11_BIND_DEPTH_STENCIL | D3D11_BIND_SHADER_RESOURCE;
        if (FAILED(dev->CreateTexture2D(&dd, nullptr, &depthTex))) return false;
        D3D11_DEPTH_STENCIL_VIEW_DESC dvd = {}; dvd.Format = DXGI_FORMAT_D24_UNORM_S8_UINT; dvd.ViewDimension = D3D11_DSV_DIMENSION_TEXTURE2D;
        if (FAILED(dev->CreateDepthStencilView(depthTex, &dvd, &dsv))) return false;
        D3D11_SHADER_RESOURCE_VIEW_DESC dsr = {}; dsr.Format = DXGI_FORMAT_R24_UNORM_X8_TYPELESS; dsr.ViewDimension = D3D11_SRV_DIMENSION_TEXTURE2D; dsr.Texture2D.MipLevels = 1;
        if (FAILED(dev->CreateShaderResourceView(depthTex, &dsr, &depthSRV))) return false;

        // HDR scene color (RGBA16F): geometry + sky render here, then tonemapped.
        D3D11_TEXTURE2D_DESC sc = {};
        sc.Width = (UINT)width; sc.Height = (UINT)height;
        sc.MipLevels = 1; sc.ArraySize = 1;
        sc.Format = DXGI_FORMAT_R16G16B16A16_FLOAT;
        sc.SampleDesc.Count = 1;
        sc.Usage = D3D11_USAGE_DEFAULT;
        sc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
        if (FAILED(dev->CreateTexture2D(&sc, nullptr, &sceneTex))) return false;
        if (FAILED(dev->CreateRenderTargetView(sceneTex, nullptr, &sceneRTV))) return false;
        if (FAILED(dev->CreateShaderResourceView(sceneTex, nullptr, &sceneSRV))) return false;

        // LDR composite target (tonemapped), then FXAA resolves it to the backbuffer.
        D3D11_TEXTURE2D_DESC ld = sc; ld.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
        if (FAILED(dev->CreateTexture2D(&ld, nullptr, &ldrTex))) return false;
        if (FAILED(dev->CreateRenderTargetView(ldrTex, nullptr, &ldrRTV))) return false;
        if (FAILED(dev->CreateShaderResourceView(ldrTex, nullptr, &ldrSRV))) return false;
        return true;
    }
    void releaseTargets() {
        if (ldrSRV)   { ldrSRV->Release(); ldrSRV = nullptr; }
        if (ldrRTV)   { ldrRTV->Release(); ldrRTV = nullptr; }
        if (ldrTex)   { ldrTex->Release(); ldrTex = nullptr; }
        if (sceneSRV)  { sceneSRV->Release(); sceneSRV = nullptr; }
        if (sceneRTV)  { sceneRTV->Release(); sceneRTV = nullptr; }
        if (sceneTex)  { sceneTex->Release(); sceneTex = nullptr; }
        if (depthSRV) { depthSRV->Release(); depthSRV = nullptr; }
        if (dsv)      { dsv->Release(); dsv = nullptr; }
        if (depthTex) { depthTex->Release(); depthTex = nullptr; }
        if (rtv)      { rtv->Release(); rtv = nullptr; }
    }
};

Gfx::Gfx()  : p_(new Impl()) {}
Gfx::~Gfx() { shutdown(); delete p_; p_ = nullptr; }

bool Gfx::init(void* nativeWindowHandle, int width, int height, std::string& err) {
    Impl& d = *p_;
    d.width = width; d.height = height;
    HWND hwnd = (HWND)nativeWindowHandle;

    DXGI_SWAP_CHAIN_DESC sd = {};
    sd.BufferCount = 2;
    sd.BufferDesc.Width = width; sd.BufferDesc.Height = height;
    sd.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    sd.BufferDesc.RefreshRate.Numerator = 60; sd.BufferDesc.RefreshRate.Denominator = 1;
    sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    sd.OutputWindow = hwnd;
    sd.SampleDesc.Count = 1;
    sd.Windowed = TRUE;
    sd.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;

    D3D_FEATURE_LEVEL want[] = { D3D_FEATURE_LEVEL_11_0 };
    D3D_FEATURE_LEVEL got;
    HRESULT hr = D3D11CreateDeviceAndSwapChain(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0,
        want, 1, D3D11_SDK_VERSION, &sd, &d.swap, &d.dev, &got, &d.ctx);
    if (FAILED(hr))
        hr = D3D11CreateDeviceAndSwapChain(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, 0,
            want, 1, D3D11_SDK_VERSION, &sd, &d.swap, &d.dev, &got, &d.ctx);
    if (FAILED(hr)) { err = "D3D11CreateDeviceAndSwapChain failed"; return false; }
    if (!d.createTargets()) { err = "create render/depth targets failed"; return false; }

    // compile shaders
    ID3DBlob* vsb = nullptr; ID3DBlob* psb = nullptr; ID3DBlob* errb = nullptr;
    UINT cf = D3DCOMPILE_ENABLE_STRICTNESS | D3DCOMPILE_OPTIMIZATION_LEVEL3;
    if (FAILED(D3DCompile(kHLSL, strlen(kHLSL), "ae1.hlsl", nullptr, nullptr, "VSMain", "vs_5_0", cf, 0, &vsb, &errb))) {
        err = std::string("VS compile: ") + (errb ? (const char*)errb->GetBufferPointer() : "?");
        return false;
    }
    if (FAILED(D3DCompile(kHLSL, strlen(kHLSL), "ae1.hlsl", nullptr, nullptr, "PSMain", "ps_5_0", cf, 0, &psb, &errb))) {
        err = std::string("PS compile: ") + (errb ? (const char*)errb->GetBufferPointer() : "?");
        return false;
    }
    d.dev->CreateVertexShader(vsb->GetBufferPointer(), vsb->GetBufferSize(), nullptr, &d.vs);
    d.dev->CreatePixelShader(psb->GetBufferPointer(), psb->GetBufferSize(), nullptr, &d.ps);

    D3D11_INPUT_ELEMENT_DESC il[] = {
        { "POSITION", 0, DXGI_FORMAT_R32G32B32_FLOAT, 0, 0,  D3D11_INPUT_PER_VERTEX_DATA, 0 },
        { "NORMAL",   0, DXGI_FORMAT_R32G32B32_FLOAT, 0, 12, D3D11_INPUT_PER_VERTEX_DATA, 0 },
        { "TEXCOORD", 0, DXGI_FORMAT_R32G32_FLOAT,    0, 24, D3D11_INPUT_PER_VERTEX_DATA, 0 },
        { "COLOR",    0, DXGI_FORMAT_R32G32B32_FLOAT, 0, 32, D3D11_INPUT_PER_VERTEX_DATA, 0 },
    };
    d.dev->CreateInputLayout(il, 4, vsb->GetBufferPointer(), vsb->GetBufferSize(), &d.layout);
    vsb->Release(); psb->Release();

    // ---- instanced pipeline (scatter): 4 per-vertex attrs + a per-instance 4x4 ----
    ID3DBlob* ivb = nullptr; ID3DBlob* isvb = nullptr;
    if (FAILED(D3DCompile(kHLSL, strlen(kHLSL), "ae1.hlsl", nullptr, nullptr, "InstVSMain", "vs_5_0", cf, 0, &ivb, &errb))) {
        err = std::string("Inst VS: ") + (errb ? (const char*)errb->GetBufferPointer() : "?"); return false; }
    if (FAILED(D3DCompile(kHLSL, strlen(kHLSL), "ae1.hlsl", nullptr, nullptr, "InstShVS", "vs_5_0", cf, 0, &isvb, &errb))) {
        err = std::string("Inst ShVS: ") + (errb ? (const char*)errb->GetBufferPointer() : "?"); return false; }
    d.dev->CreateVertexShader(ivb->GetBufferPointer(), ivb->GetBufferSize(), nullptr, &d.instVS);
    d.dev->CreateVertexShader(isvb->GetBufferPointer(), isvb->GetBufferSize(), nullptr, &d.instShVS);
    D3D11_INPUT_ELEMENT_DESC iil[] = {
        { "POSITION", 0, DXGI_FORMAT_R32G32B32_FLOAT,    0, 0,  D3D11_INPUT_PER_VERTEX_DATA,   0 },
        { "NORMAL",   0, DXGI_FORMAT_R32G32B32_FLOAT,    0, 12, D3D11_INPUT_PER_VERTEX_DATA,   0 },
        { "TEXCOORD", 0, DXGI_FORMAT_R32G32_FLOAT,       0, 24, D3D11_INPUT_PER_VERTEX_DATA,   0 },
        { "COLOR",    0, DXGI_FORMAT_R32G32B32_FLOAT,    0, 32, D3D11_INPUT_PER_VERTEX_DATA,   0 },
        { "INSTMTX",  0, DXGI_FORMAT_R32G32B32A32_FLOAT, 1, 0,  D3D11_INPUT_PER_INSTANCE_DATA, 1 },
        { "INSTMTX",  1, DXGI_FORMAT_R32G32B32A32_FLOAT, 1, 16, D3D11_INPUT_PER_INSTANCE_DATA, 1 },
        { "INSTMTX",  2, DXGI_FORMAT_R32G32B32A32_FLOAT, 1, 32, D3D11_INPUT_PER_INSTANCE_DATA, 1 },
        { "INSTMTX",  3, DXGI_FORMAT_R32G32B32A32_FLOAT, 1, 48, D3D11_INPUT_PER_INSTANCE_DATA, 1 },
    };
    d.dev->CreateInputLayout(iil, 8, ivb->GetBufferPointer(), ivb->GetBufferSize(), &d.instLayout);
    ivb->Release(); isvb->Release();

    D3D11_BUFFER_DESC cbd = {};
    cbd.ByteWidth = sizeof(CbData);
    cbd.Usage = D3D11_USAGE_DYNAMIC;
    cbd.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
    cbd.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
    d.dev->CreateBuffer(&cbd, nullptr, &d.cb);

    D3D11_DEPTH_STENCIL_DESC dsd = {};
    dsd.DepthEnable = TRUE;
    dsd.DepthWriteMask = D3D11_DEPTH_WRITE_MASK_ALL;
    dsd.DepthFunc = D3D11_COMPARISON_LESS_EQUAL;
    d.dev->CreateDepthStencilState(&dsd, &d.dss);

    D3D11_DEPTH_STENCIL_DESC dsr = dsd;
    dsr.DepthWriteMask = D3D11_DEPTH_WRITE_MASK_ZERO;   // transparent: test, don't write
    d.dev->CreateDepthStencilState(&dsr, &d.dssReadNoWrite);

    D3D11_RASTERIZER_DESC rd = {};
    rd.FillMode = D3D11_FILL_SOLID;
    rd.CullMode = D3D11_CULL_NONE;   // imported meshes vary in winding / double-sidedness
    rd.FrontCounterClockwise = FALSE;
    d.dev->CreateRasterizerState(&rd, &d.rs);

    D3D11_BLEND_DESC bo = {};   // opaque: no blend
    bo.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
    d.dev->CreateBlendState(&bo, &d.blendOff);
    D3D11_BLEND_DESC bn = {};   // src-alpha over (straight alpha)
    bn.RenderTarget[0].BlendEnable = TRUE;
    bn.RenderTarget[0].SrcBlend = D3D11_BLEND_SRC_ALPHA;
    bn.RenderTarget[0].DestBlend = D3D11_BLEND_INV_SRC_ALPHA;
    bn.RenderTarget[0].BlendOp = D3D11_BLEND_OP_ADD;
    bn.RenderTarget[0].SrcBlendAlpha = D3D11_BLEND_ONE;
    bn.RenderTarget[0].DestBlendAlpha = D3D11_BLEND_INV_SRC_ALPHA;
    bn.RenderTarget[0].BlendOpAlpha = D3D11_BLEND_OP_ADD;
    bn.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
    d.dev->CreateBlendState(&bn, &d.blendOn);

    D3D11_SAMPLER_DESC sm = {};
    sm.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
    sm.AddressU = sm.AddressV = sm.AddressW = D3D11_TEXTURE_ADDRESS_WRAP;
    sm.MaxLOD = D3D11_FLOAT32_MAX;
    d.dev->CreateSamplerState(&sm, &d.samp);

    // ---- FX pipeline: fullscreen skybox + tonemap composite ----
    ID3DBlob* fvb = nullptr; ID3DBlob* skb = nullptr; ID3DBlob* cmb = nullptr;
    if (FAILED(D3DCompile(kFxHLSL, strlen(kFxHLSL), "fx.hlsl", nullptr, nullptr, "FsVS", "vs_5_0", cf, 0, &fvb, &errb))) {
        err = std::string("FX VS: ") + (errb ? (const char*)errb->GetBufferPointer() : "?"); return false; }
    if (FAILED(D3DCompile(kFxHLSL, strlen(kFxHLSL), "fx.hlsl", nullptr, nullptr, "SkyPS", "ps_5_0", cf, 0, &skb, &errb))) {
        err = std::string("Sky PS: ") + (errb ? (const char*)errb->GetBufferPointer() : "?"); return false; }
    if (FAILED(D3DCompile(kFxHLSL, strlen(kFxHLSL), "fx.hlsl", nullptr, nullptr, "CompPS", "ps_5_0", cf, 0, &cmb, &errb))) {
        err = std::string("Comp PS: ") + (errb ? (const char*)errb->GetBufferPointer() : "?"); return false; }
    d.dev->CreateVertexShader(fvb->GetBufferPointer(), fvb->GetBufferSize(), nullptr, &d.fxVS);
    d.dev->CreatePixelShader(skb->GetBufferPointer(), skb->GetBufferSize(), nullptr, &d.skyPS);
    d.dev->CreatePixelShader(cmb->GetBufferPointer(), cmb->GetBufferSize(), nullptr, &d.compPS);
    fvb->Release(); skb->Release(); cmb->Release();
    ID3DBlob* fxb = nullptr;
    if (FAILED(D3DCompile(kFxHLSL, strlen(kFxHLSL), "fx.hlsl", nullptr, nullptr, "FxaaPS", "ps_5_0", cf, 0, &fxb, &errb))) {
        err = std::string("FXAA PS: ") + (errb ? (const char*)errb->GetBufferPointer() : "?"); return false; }
    d.dev->CreatePixelShader(fxb->GetBufferPointer(), fxb->GetBufferSize(), nullptr, &d.fxaaPS);
    fxb->Release();

    D3D11_BUFFER_DESC fcb = {};
    fcb.ByteWidth = sizeof(FxCb); fcb.Usage = D3D11_USAGE_DYNAMIC;
    fcb.BindFlags = D3D11_BIND_CONSTANT_BUFFER; fcb.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
    d.dev->CreateBuffer(&fcb, nullptr, &d.fxCb);

    D3D11_SAMPLER_DESC fs = {};
    fs.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
    fs.AddressU = fs.AddressV = fs.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
    fs.MaxLOD = D3D11_FLOAT32_MAX;
    d.dev->CreateSamplerState(&fs, &d.fxSamp);

    D3D11_DEPTH_STENCIL_DESC nd = {};
    nd.DepthEnable = FALSE; nd.DepthWriteMask = D3D11_DEPTH_WRITE_MASK_ZERO;
    d.dev->CreateDepthStencilState(&nd, &d.dssNone);

    // ---- Shadow map ----
    ID3DBlob* shb = nullptr;
    if (FAILED(D3DCompile(kHLSL, strlen(kHLSL), "ae1.hlsl", nullptr, nullptr, "ShVS", "vs_5_0", cf, 0, &shb, &errb))) {
        err = std::string("Shadow VS: ") + (errb ? (const char*)errb->GetBufferPointer() : "?"); return false; }
    d.dev->CreateVertexShader(shb->GetBufferPointer(), shb->GetBufferSize(), nullptr, &d.shVS);
    shb->Release();

    D3D11_TEXTURE2D_DESC shd = {};
    shd.Width = shd.Height = (UINT)Impl::SHADOW_RES; shd.MipLevels = 1; shd.ArraySize = 1;
    shd.Format = DXGI_FORMAT_R32_TYPELESS; shd.SampleDesc.Count = 1;
    shd.Usage = D3D11_USAGE_DEFAULT; shd.BindFlags = D3D11_BIND_DEPTH_STENCIL | D3D11_BIND_SHADER_RESOURCE;
    if (FAILED(d.dev->CreateTexture2D(&shd, nullptr, &d.shadowTex))) { err = "shadow tex"; return false; }
    D3D11_DEPTH_STENCIL_VIEW_DESC svd = {}; svd.Format = DXGI_FORMAT_D32_FLOAT; svd.ViewDimension = D3D11_DSV_DIMENSION_TEXTURE2D;
    d.dev->CreateDepthStencilView(d.shadowTex, &svd, &d.shadowDSV);
    D3D11_SHADER_RESOURCE_VIEW_DESC srd = {}; srd.Format = DXGI_FORMAT_R32_FLOAT; srd.ViewDimension = D3D11_SRV_DIMENSION_TEXTURE2D; srd.Texture2D.MipLevels = 1;
    d.dev->CreateShaderResourceView(d.shadowTex, &srd, &d.shadowSRV);

    D3D11_SAMPLER_DESC cs = {};
    cs.Filter = D3D11_FILTER_COMPARISON_MIN_MAG_LINEAR_MIP_POINT;
    cs.AddressU = cs.AddressV = cs.AddressW = D3D11_TEXTURE_ADDRESS_BORDER;
    cs.BorderColor[0] = cs.BorderColor[1] = cs.BorderColor[2] = cs.BorderColor[3] = 1.0f;  // outside = fully lit
    cs.ComparisonFunc = D3D11_COMPARISON_LESS_EQUAL; cs.MaxLOD = D3D11_FLOAT32_MAX;
    d.dev->CreateSamplerState(&cs, &d.shadowSamp);

    // ---- 2D overlay pipeline (UI) ----
    ID3DBlob* ovb = nullptr; ID3DBlob* opb = nullptr;
    if (FAILED(D3DCompile(kOvHLSL, strlen(kOvHLSL), "ov.hlsl", nullptr, nullptr, "OvVS", "vs_5_0", cf, 0, &ovb, &errb))) {
        err = std::string("Overlay VS: ") + (errb ? (const char*)errb->GetBufferPointer() : "?"); return false; }
    if (FAILED(D3DCompile(kOvHLSL, strlen(kOvHLSL), "ov.hlsl", nullptr, nullptr, "OvPS", "ps_5_0", cf, 0, &opb, &errb))) {
        err = std::string("Overlay PS: ") + (errb ? (const char*)errb->GetBufferPointer() : "?"); return false; }
    d.dev->CreateVertexShader(ovb->GetBufferPointer(), ovb->GetBufferSize(), nullptr, &d.ovVS);
    d.dev->CreatePixelShader(opb->GetBufferPointer(), opb->GetBufferSize(), nullptr, &d.ovPS);
    D3D11_INPUT_ELEMENT_DESC ovil[] = {
        { "POSITION", 0, DXGI_FORMAT_R32G32_FLOAT,       0, 0,  D3D11_INPUT_PER_VERTEX_DATA, 0 },
        { "TEXCOORD", 0, DXGI_FORMAT_R32G32_FLOAT,       0, 8,  D3D11_INPUT_PER_VERTEX_DATA, 0 },
        { "COLOR",    0, DXGI_FORMAT_R32G32B32A32_FLOAT, 0, 16, D3D11_INPUT_PER_VERTEX_DATA, 0 },
    };
    d.dev->CreateInputLayout(ovil, 3, ovb->GetBufferPointer(), ovb->GetBufferSize(), &d.ovLayout);
    ovb->Release(); opb->Release();
    D3D11_BUFFER_DESC ocb = {}; ocb.ByteWidth = 16; ocb.Usage = D3D11_USAGE_DYNAMIC;
    ocb.BindFlags = D3D11_BIND_CONSTANT_BUFFER; ocb.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
    d.dev->CreateBuffer(&ocb, nullptr, &d.ovCb);

    // ---- particle pipeline (world-space billboards) ----
    ID3DBlob* ptb = nullptr; ID3DBlob* ppb = nullptr;
    if (FAILED(D3DCompile(kPtHLSL, strlen(kPtHLSL), "pt.hlsl", nullptr, nullptr, "PtVS", "vs_5_0", cf, 0, &ptb, &errb))) {
        err = std::string("Particle VS: ") + (errb ? (const char*)errb->GetBufferPointer() : "?"); return false; }
    if (FAILED(D3DCompile(kPtHLSL, strlen(kPtHLSL), "pt.hlsl", nullptr, nullptr, "PtPS", "ps_5_0", cf, 0, &ppb, &errb))) {
        err = std::string("Particle PS: ") + (errb ? (const char*)errb->GetBufferPointer() : "?"); return false; }
    d.dev->CreateVertexShader(ptb->GetBufferPointer(), ptb->GetBufferSize(), nullptr, &d.ptVS);
    d.dev->CreatePixelShader(ppb->GetBufferPointer(), ppb->GetBufferSize(), nullptr, &d.ptPS);
    D3D11_INPUT_ELEMENT_DESC ptil[] = {
        { "POSITION", 0, DXGI_FORMAT_R32G32B32_FLOAT,    0, 0,  D3D11_INPUT_PER_VERTEX_DATA, 0 },
        { "TEXCOORD", 0, DXGI_FORMAT_R32G32_FLOAT,       0, 12, D3D11_INPUT_PER_VERTEX_DATA, 0 },
        { "COLOR",    0, DXGI_FORMAT_R32G32B32A32_FLOAT, 0, 20, D3D11_INPUT_PER_VERTEX_DATA, 0 },
    };
    d.dev->CreateInputLayout(ptil, 3, ptb->GetBufferPointer(), ptb->GetBufferSize(), &d.ptLayout);
    ptb->Release(); ppb->Release();
    // premultiplied blends: additive (Src ONE, Dest ONE) and over (Src ONE, Dest INV_SRC_ALPHA)
    D3D11_BLEND_DESC ba = {}; ba.RenderTarget[0].BlendEnable = TRUE;
    ba.RenderTarget[0].SrcBlend = D3D11_BLEND_ONE; ba.RenderTarget[0].DestBlend = D3D11_BLEND_ONE; ba.RenderTarget[0].BlendOp = D3D11_BLEND_OP_ADD;
    ba.RenderTarget[0].SrcBlendAlpha = D3D11_BLEND_ONE; ba.RenderTarget[0].DestBlendAlpha = D3D11_BLEND_ONE; ba.RenderTarget[0].BlendOpAlpha = D3D11_BLEND_OP_ADD;
    ba.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
    d.dev->CreateBlendState(&ba, &d.blendAddPM);
    D3D11_BLEND_DESC bov = ba;
    bov.RenderTarget[0].DestBlend = D3D11_BLEND_INV_SRC_ALPHA; bov.RenderTarget[0].DestBlendAlpha = D3D11_BLEND_INV_SRC_ALPHA;
    d.dev->CreateBlendState(&bov, &d.blendOverPM);

    // handle 0 is reserved as "invalid"/white for both meshes and textures.
    d.meshes.push_back(GpuMesh{});
    d.textures.push_back(GpuTex{});
    const uint8_t white[4] = { 255, 255, 255, 255 };
    createTexture(white, 1, 1);   // becomes handle 1; used as the default below

    // Soft radial particle sprite: white RGB, alpha a smooth falloff to the edge.
    // Built procedurally (no media) — the browser generates the same on a canvas.
    { const int PR = 64; std::vector<uint8_t> sp((size_t)PR*PR*4);
      for (int y = 0; y < PR; y++) for (int x = 0; x < PR; x++) {
          float dx = (x + 0.5f)/PR*2 - 1, dy = (y + 0.5f)/PR*2 - 1;
          float r = std::sqrt(dx*dx + dy*dy);
          float a = 1.0f - r; if (a < 0) a = 0; a = a*a*(3 - 2*a);   // smoothstep
          uint8_t* px = &sp[((size_t)y*PR + x)*4];
          px[0] = px[1] = px[2] = 255; px[3] = (uint8_t)(a*255.0f + 0.5f);
      }
      TexHandle h = createTexture(sp.data(), PR, PR); if (h.valid()) d.ptSprite = h.id;
    }
    return true;
}

TexHandle Gfx::createTexture(const uint8_t* rgba, int width, int height) {
    Impl& d = *p_;
    if (width <= 0 || height <= 0) return TexHandle{};
    D3D11_TEXTURE2D_DESC td = {};
    td.Width = (UINT)width; td.Height = (UINT)height;
    td.MipLevels = 1; td.ArraySize = 1;
    td.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    td.SampleDesc.Count = 1;
    td.Usage = D3D11_USAGE_IMMUTABLE;
    td.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    D3D11_SUBRESOURCE_DATA sd = { rgba, (UINT)(width * 4), 0 };
    GpuTex t;
    if (FAILED(d.dev->CreateTexture2D(&td, &sd, &t.tex))) return TexHandle{};
    if (FAILED(d.dev->CreateShaderResourceView(t.tex, nullptr, &t.srv))) { t.tex->Release(); return TexHandle{}; }
    d.textures.push_back(t);
    return TexHandle{ (uint32_t)(d.textures.size() - 1) };
}

void Gfx::shutdown() {
    if (!p_) return;
    Impl& d = *p_;
    for (auto& m : d.meshes) { if (m.vb) m.vb->Release(); if (m.ib) m.ib->Release(); }
    d.meshes.clear();
    for (auto& t : d.textures) { if (t.srv) t.srv->Release(); if (t.tex) t.tex->Release(); }
    d.textures.clear();
    if (d.shadowSRV) d.shadowSRV->Release(); d.shadowSRV = nullptr;
    if (d.shadowDSV) d.shadowDSV->Release(); d.shadowDSV = nullptr;
    if (d.shadowTex) d.shadowTex->Release(); d.shadowTex = nullptr;
    if (d.shadowSamp) d.shadowSamp->Release(); d.shadowSamp = nullptr;
    if (d.shVS) d.shVS->Release(); d.shVS = nullptr;
    if (d.ovVB) d.ovVB->Release(); d.ovVB = nullptr;
    if (d.ovCb) d.ovCb->Release(); d.ovCb = nullptr;
    if (d.ovLayout) d.ovLayout->Release(); d.ovLayout = nullptr;
    if (d.ptVB) d.ptVB->Release(); d.ptVB = nullptr;
    if (d.ptLayout) d.ptLayout->Release(); d.ptLayout = nullptr;
    if (d.ptVS) d.ptVS->Release(); d.ptVS = nullptr;
    if (d.ptPS) d.ptPS->Release(); d.ptPS = nullptr;
    if (d.blendAddPM) d.blendAddPM->Release(); d.blendAddPM = nullptr;
    if (d.blendOverPM) d.blendOverPM->Release(); d.blendOverPM = nullptr;
    if (d.ovPS) d.ovPS->Release(); d.ovPS = nullptr;
    if (d.ovVS) d.ovVS->Release(); d.ovVS = nullptr;
    if (d.envSRV) d.envSRV->Release(); d.envSRV = nullptr;
    if (d.envTex) d.envTex->Release(); d.envTex = nullptr;
    if (d.fxVS) d.fxVS->Release(); d.fxVS = nullptr;
    if (d.skyPS) d.skyPS->Release(); d.skyPS = nullptr;
    if (d.compPS) d.compPS->Release(); d.compPS = nullptr;
    if (d.fxaaPS) d.fxaaPS->Release(); d.fxaaPS = nullptr;
    if (d.fxCb) d.fxCb->Release(); d.fxCb = nullptr;
    if (d.fxSamp) d.fxSamp->Release(); d.fxSamp = nullptr;
    if (d.dssNone) d.dssNone->Release(); d.dssNone = nullptr;
    if (d.samp) d.samp->Release(); d.samp = nullptr;
    if (d.cb) d.cb->Release(); d.cb = nullptr;
    if (d.layout) d.layout->Release(); d.layout = nullptr;
    if (d.ps) d.ps->Release(); d.ps = nullptr;
    if (d.vs) d.vs->Release(); d.vs = nullptr;
    if (d.instanceVB) d.instanceVB->Release(); d.instanceVB = nullptr;
    if (d.instLayout) d.instLayout->Release(); d.instLayout = nullptr;
    if (d.instShVS) d.instShVS->Release(); d.instShVS = nullptr;
    if (d.instVS) d.instVS->Release(); d.instVS = nullptr;
    if (d.blendOn) d.blendOn->Release(); d.blendOn = nullptr;
    if (d.blendOff) d.blendOff->Release(); d.blendOff = nullptr;
    if (d.dssReadNoWrite) d.dssReadNoWrite->Release(); d.dssReadNoWrite = nullptr;
    if (d.rs) d.rs->Release(); d.rs = nullptr;
    if (d.dss) d.dss->Release(); d.dss = nullptr;
    d.releaseTargets();
    if (d.swap) d.swap->Release(); d.swap = nullptr;
    if (d.ctx) d.ctx->Release(); d.ctx = nullptr;
    if (d.dev) d.dev->Release(); d.dev = nullptr;
}

void Gfx::resize(int width, int height) {
    Impl& d = *p_;
    if (width <= 0 || height <= 0 || !d.swap) return;
    d.width = width; d.height = height;
    d.releaseTargets();
    d.swap->ResizeBuffers(0, (UINT)width, (UINT)height, DXGI_FORMAT_UNKNOWN, 0);
    d.createTargets();
}

MeshHandle Gfx::createMesh(const Vertex* verts, size_t vcount,
                           const uint32_t* indices, size_t icount, bool dynamic) {
    Impl& d = *p_;
    GpuMesh m;
    m.icount = (UINT)icount;
    m.vcap = (UINT)vcount;
    m.dynamic = dynamic;

    D3D11_BUFFER_DESC vbd = {};
    vbd.ByteWidth = (UINT)(vcount * sizeof(Vertex));
    vbd.Usage = dynamic ? D3D11_USAGE_DYNAMIC : D3D11_USAGE_IMMUTABLE;
    vbd.BindFlags = D3D11_BIND_VERTEX_BUFFER;
    vbd.CPUAccessFlags = dynamic ? D3D11_CPU_ACCESS_WRITE : 0;
    D3D11_SUBRESOURCE_DATA vsdata = { verts, 0, 0 };
    if (FAILED(d.dev->CreateBuffer(&vbd, &vsdata, &m.vb))) return MeshHandle{};

    D3D11_BUFFER_DESC ibd = {};
    ibd.ByteWidth = (UINT)(icount * sizeof(uint32_t));
    ibd.Usage = D3D11_USAGE_IMMUTABLE;
    ibd.BindFlags = D3D11_BIND_INDEX_BUFFER;
    D3D11_SUBRESOURCE_DATA isdata = { indices, 0, 0 };
    if (FAILED(d.dev->CreateBuffer(&ibd, &isdata, &m.ib))) { m.vb->Release(); return MeshHandle{}; }

    if (!d.freeMeshSlots.empty()) {   // recycle a slot freed by destroyMesh
        uint32_t idx = d.freeMeshSlots.back(); d.freeMeshSlots.pop_back();
        d.meshes[idx] = m;
        return MeshHandle{ idx };
    }
    d.meshes.push_back(m);
    return MeshHandle{ (uint32_t)(d.meshes.size() - 1) };
}

void Gfx::destroyMesh(MeshHandle mesh) {
    Impl& d = *p_;
    if (mesh.id == 0 || mesh.id >= d.meshes.size()) return;   // 0 is the reserved invalid slot
    GpuMesh& m = d.meshes[mesh.id];
    if (m.vb) m.vb->Release();
    if (m.ib) m.ib->Release();
    m = GpuMesh{};
    d.freeMeshSlots.push_back(mesh.id);
}

void Gfx::meshStats(int& total, int& free) const {
    total = (int)p_->meshes.size();
    free = (int)p_->freeMeshSlots.size();
}

void Gfx::setMeshMaterial(MeshHandle mesh, float metallic, float roughness) {
    Impl& d = *p_;
    if (mesh.id == 0 || mesh.id >= d.meshes.size()) return;
    d.meshes[mesh.id].metallic = metallic;
    d.meshes[mesh.id].roughness = roughness;
}

void Gfx::updateMesh(MeshHandle mesh, const Vertex* verts, size_t vcount) {
    Impl& d = *p_;
    if (mesh.id == 0 || mesh.id >= d.meshes.size()) return;
    GpuMesh& m = d.meshes[mesh.id];
    if (!m.dynamic || !m.vb) return;
    if (vcount > m.vcap) vcount = m.vcap;
    D3D11_MAPPED_SUBRESOURCE ms;
    if (SUCCEEDED(d.ctx->Map(m.vb, 0, D3D11_MAP_WRITE_DISCARD, 0, &ms))) {
        std::memcpy(ms.pData, verts, vcount * sizeof(Vertex));
        d.ctx->Unmap(m.vb, 0);
    }
}

void Gfx::setEnvMap(const float* rgb, int w, int h, float opacity, float rotation, float envIntensity) {
    Impl& d = *p_;
    if (d.envSRV) { d.envSRV->Release(); d.envSRV = nullptr; }
    if (d.envTex) { d.envTex->Release(); d.envTex = nullptr; }
    d.skyOpacity = opacity; d.skyRotation = rotation; d.envIntensity = envIntensity;
    d.envColor[0] = d.envColor[1] = d.envColor[2] = 0;
    if (!rgb || w <= 0 || h <= 0) return;
    std::vector<float> rgba((size_t)w * h * 4);
    double ar = 0, ag = 0, ab = 0;
    for (size_t i = 0; i < (size_t)w * h; i++) {
        float r = rgb[i*3], g = rgb[i*3+1], b = rgb[i*3+2];
        rgba[i*4] = r; rgba[i*4+1] = g; rgba[i*4+2] = b; rgba[i*4+3] = 1.0f;
        ar += r; ag += g; ab += b;
    }
    double n = (double)w * h;
    d.envColor[0] = (float)(ar / n); d.envColor[1] = (float)(ag / n); d.envColor[2] = (float)(ab / n);
    D3D11_TEXTURE2D_DESC td = {};
    td.Width = (UINT)w; td.Height = (UINT)h; td.MipLevels = 1; td.ArraySize = 1;
    td.Format = DXGI_FORMAT_R32G32B32A32_FLOAT; td.SampleDesc.Count = 1;
    td.Usage = D3D11_USAGE_IMMUTABLE; td.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    D3D11_SUBRESOURCE_DATA sd = { rgba.data(), (UINT)(w * 16), 0 };
    if (SUCCEEDED(d.dev->CreateTexture2D(&td, &sd, &d.envTex)))
        d.dev->CreateShaderResourceView(d.envTex, nullptr, &d.envSRV);
}

void Gfx::beginFrame(float r, float g, float b) {
    Impl& d = *p_;
    const float col[4] = { r, g, b, 1.0f };
    // Render the scene into the HDR offscreen target (endFrame tonemaps it).
    d.ctx->OMSetRenderTargets(1, &d.sceneRTV, d.dsv);
    D3D11_VIEWPORT vp = {}; vp.Width = (FLOAT)d.width; vp.Height = (FLOAT)d.height; vp.MaxDepth = 1.0f;
    d.ctx->RSSetViewports(1, &vp);
    d.ctx->ClearRenderTargetView(d.sceneRTV, col);
    d.ctx->ClearDepthStencilView(d.dsv, D3D11_CLEAR_DEPTH | D3D11_CLEAR_STENCIL, 1.0f, 0);

    // Skybox first (depth off, fills where geometry won't). Only if we have one.
    if (d.envSRV) {
        d.ctx->OMSetDepthStencilState(d.dssNone, 0);
        d.ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        d.ctx->IASetInputLayout(nullptr);
        d.ctx->VSSetShader(d.fxVS, nullptr, 0);
        d.ctx->PSSetShader(d.skyPS, nullptr, 0);
        D3D11_MAPPED_SUBRESOURCE ms;
        if (SUCCEEDED(d.ctx->Map(d.fxCb, 0, D3D11_MAP_WRITE_DISCARD, 0, &ms))) {
            FxCb* f = (FxCb*)ms.pData;
            f->invViewProj = d.invViewProj;
            f->camPos[0] = d.camPos[0]; f->camPos[1] = d.camPos[1]; f->camPos[2] = d.camPos[2]; f->camPos[3] = 0;
            f->skyParams[0] = d.skyOpacity; f->skyParams[1] = d.skyRotation; f->skyParams[2] = d.exposure; f->skyParams[3] = 0;
            d.ctx->Unmap(d.fxCb, 0);
        }
        d.ctx->VSSetConstantBuffers(1, 1, &d.fxCb);
        d.ctx->PSSetConstantBuffers(1, 1, &d.fxCb);
        d.ctx->PSSetShaderResources(0, 1, &d.envSRV);
        d.ctx->PSSetSamplers(0, 1, &d.fxSamp);
        d.ctx->Draw(3, 0);
    }

    // Geometry pass.
    d.ctx->OMSetDepthStencilState(d.dss, 0);
    d.ctx->RSSetState(d.rs);
    d.ctx->IASetInputLayout(d.layout);
    d.ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    d.ctx->VSSetShader(d.vs, nullptr, 0);
    d.ctx->PSSetShader(d.ps, nullptr, 0);
    d.ctx->VSSetConstantBuffers(0, 1, &d.cb);
    d.ctx->PSSetConstantBuffers(0, 1, &d.cb);
    d.ctx->PSSetSamplers(0, 1, &d.samp);
    d.ctx->PSSetSamplers(1, 1, &d.shadowSamp);           // s1: PCF comparison
    d.ctx->PSSetShaderResources(1, 1, &d.shadowSRV);     // t1: shadow map (filled this frame)
}

void Gfx::setViewProj(const Mat4& view, const Mat4& proj) {
    p_->viewProj = mul(view, proj);
    p_->invViewProj = inverse(p_->viewProj);
    // camera world pos = inverse(view).translation
    Mat4 iv = inverse(view);
    p_->camPos[0] = iv.m[12]; p_->camPos[1] = iv.m[13]; p_->camPos[2] = iv.m[14];
}

// Fit the sun's ortho frustum to the scene sphere (render space). The sun
// travels along `ld`; it is placed back along -ld, looking at the centre.
static Mat4 computeLightVP(const float ld[3], Vec3 c, float radius) {
    float len = std::sqrt(ld[0]*ld[0] + ld[1]*ld[1] + ld[2]*ld[2]); if (len < 1e-4f) len = 1;
    Vec3 dir = { ld[0]/len, ld[1]/len, ld[2]/len };
    float dist = radius * 1.6f;
    Vec3 eye = { c.x - dir.x*dist, c.y - dir.y*dist, c.z - dir.z*dist };
    Vec3 up = (std::fabs(dir.y) > 0.95f) ? Vec3{ 0,0,1 } : Vec3{ 0,1,0 };
    Mat4 view = lookAtLH(eye, c, up);
    Mat4 proj = orthoLH(radius * 2.4f, radius * 2.4f, 0.05f, dist + radius * 2.0f);
    return mul(view, proj);
}

void Gfx::setLight(Vec3 dir, float r, float g, float b, float ambient) {
    Impl& d = *p_;
    d.lightDir[0] = dir.x; d.lightDir[1] = dir.y; d.lightDir[2] = dir.z;
    d.lightColor[0] = r; d.lightColor[1] = g; d.lightColor[2] = b;
    d.ambient = ambient;
    if (d.shadowRadius > 0) d.lightViewProj = computeLightVP(d.lightDir, d.shadowCenter, d.shadowRadius);
}
void Gfx::setDOF(float focus, float range, float maxBlur) {
    Impl& d = *p_; d.dofFocus = focus; d.dofRange = range; d.dofMaxBlur = maxBlur;
}
void Gfx::setShadowBounds(Vec3 center, float radius) {
    Impl& d = *p_;
    d.shadowCenter = center; d.shadowRadius = radius;
    if (radius > 0) d.lightViewProj = computeLightVP(d.lightDir, center, radius);
}
void Gfx::beginShadowPass() {
    Impl& d = *p_;
    if (d.shadowRadius <= 0) return;
    ID3D11ShaderResourceView* nullSRV = nullptr;
    d.ctx->PSSetShaderResources(1, 1, &nullSRV);        // release last frame's shadow SRV (it's now the DSV)
    ID3D11RenderTargetView* noRT = nullptr;
    d.ctx->OMSetRenderTargets(1, &noRT, d.shadowDSV);   // depth only
    d.ctx->ClearDepthStencilView(d.shadowDSV, D3D11_CLEAR_DEPTH, 1.0f, 0);
    D3D11_VIEWPORT vp = {}; vp.Width = vp.Height = (FLOAT)Impl::SHADOW_RES; vp.MaxDepth = 1.0f;
    d.ctx->RSSetViewports(1, &vp);
    d.ctx->OMSetDepthStencilState(d.dss, 0);
    d.ctx->OMSetBlendState(d.blendOff, nullptr, 0xffffffff);
    d.ctx->RSSetState(d.rs);
    d.ctx->IASetInputLayout(d.layout);
    d.ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    d.ctx->VSSetShader(d.shVS, nullptr, 0);
    d.ctx->PSSetShader(nullptr, nullptr, 0);   // depth only, no colour
    d.ctx->VSSetConstantBuffers(0, 1, &d.cb);
}
void Gfx::drawMeshShadow(MeshHandle mesh, const Mat4& model) {
    Impl& d = *p_;
    if (d.shadowRadius <= 0 || mesh.id == 0 || mesh.id >= d.meshes.size()) return;
    GpuMesh& m = d.meshes[mesh.id];
    if (!m.vb) return;   // destroyed slot (scene teardown)
    D3D11_MAPPED_SUBRESOURCE ms;
    if (SUCCEEDED(d.ctx->Map(d.cb, 0, D3D11_MAP_WRITE_DISCARD, 0, &ms))) {
        CbData* c = (CbData*)ms.pData;
        c->model = model; c->lightViewProj = d.lightViewProj;
        d.ctx->Unmap(d.cb, 0);
    }
    UINT stride = sizeof(Vertex), offset = 0;
    d.ctx->IASetVertexBuffers(0, 1, &m.vb, &stride, &offset);
    d.ctx->IASetIndexBuffer(m.ib, DXGI_FORMAT_R32_UINT, 0);
    d.ctx->DrawIndexed(m.icount, 0, 0);
}
void Gfx::endShadowPass() { /* targets rebound by beginFrame */ }

void Gfx::drawMesh(MeshHandle mesh, const Mat4& model, TexHandle tex, float alphaCutoff, bool blended) {
    Impl& d = *p_;
    if (mesh.id == 0 || mesh.id >= d.meshes.size()) return;
    GpuMesh& m = d.meshes[mesh.id];
    if (!m.vb) return;   // destroyed slot (scene teardown)

    const float bf[4] = { 0, 0, 0, 0 };
    d.ctx->OMSetBlendState(blended ? d.blendOn : d.blendOff, bf, 0xffffffff);
    d.ctx->OMSetDepthStencilState(blended ? d.dssReadNoWrite : d.dss, 0);

    uint32_t ti = (tex.id && tex.id < d.textures.size()) ? tex.id : 1;  // 1 = white default
    if (ti < d.textures.size() && d.textures[ti].srv)
        d.ctx->PSSetShaderResources(0, 1, &d.textures[ti].srv);

    D3D11_MAPPED_SUBRESOURCE ms;
    if (SUCCEEDED(d.ctx->Map(d.cb, 0, D3D11_MAP_WRITE_DISCARD, 0, &ms))) {
        CbData* c = (CbData*)ms.pData;
        c->model = model;
        c->viewProj = d.viewProj;
        c->lightDir[0] = d.lightDir[0]; c->lightDir[1] = d.lightDir[1]; c->lightDir[2] = d.lightDir[2]; c->lightDir[3] = 0;
        c->lightColor[0] = d.lightColor[0]; c->lightColor[1] = d.lightColor[1]; c->lightColor[2] = d.lightColor[2]; c->lightColor[3] = d.ambient;
        c->params[0] = alphaCutoff;
        c->params[1] = d.shadowRadius > 0 ? 1.0f / (float)Impl::SHADOW_RES : 0.0f;  // shadow texel (0 = off)
        c->params[2] = m.metallic; c->params[3] = m.roughness;
        c->envColor[0] = d.envColor[0]; c->envColor[1] = d.envColor[1]; c->envColor[2] = d.envColor[2]; c->envColor[3] = d.envIntensity;
        c->camPos[0] = d.camPos[0]; c->camPos[1] = d.camPos[1]; c->camPos[2] = d.camPos[2]; c->camPos[3] = 0;
        c->lightViewProj = d.lightViewProj;
        d.ctx->Unmap(d.cb, 0);
    }
    UINT stride = sizeof(Vertex), offset = 0;
    d.ctx->IASetVertexBuffers(0, 1, &m.vb, &stride, &offset);
    d.ctx->IASetIndexBuffer(m.ib, DXGI_FORMAT_R32_UINT, 0);
    d.ctx->DrawIndexed(m.icount, 0, 0);
}

// Upload N model matrices to a dynamic instance buffer (grows as needed).
static bool uploadInstances(ID3D11Device* dev, ID3D11DeviceContext* ctx,
                            ID3D11Buffer*& vb, UINT& cap, const Mat4* models, size_t count) {
    if (count > cap) {
        if (vb) { vb->Release(); vb = nullptr; }
        D3D11_BUFFER_DESC vd = {}; vd.ByteWidth = (UINT)(count * sizeof(Mat4));
        vd.Usage = D3D11_USAGE_DYNAMIC; vd.BindFlags = D3D11_BIND_VERTEX_BUFFER; vd.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
        if (FAILED(dev->CreateBuffer(&vd, nullptr, &vb))) return false;
        cap = (UINT)count;
    }
    D3D11_MAPPED_SUBRESOURCE ms;
    if (SUCCEEDED(ctx->Map(vb, 0, D3D11_MAP_WRITE_DISCARD, 0, &ms))) {
        std::memcpy(ms.pData, models, count * sizeof(Mat4)); ctx->Unmap(vb, 0); return true;
    }
    return false;
}

void Gfx::drawMeshInstanced(MeshHandle mesh, const Mat4* models, size_t count, TexHandle tex, float alphaCutoff) {
    Impl& d = *p_;
    if (mesh.id == 0 || mesh.id >= d.meshes.size() || !count) return;
    GpuMesh& m = d.meshes[mesh.id]; if (!m.vb) return;
    if (!uploadInstances(d.dev, d.ctx, d.instanceVB, d.instanceVBCap, models, count)) return;
    const float bf[4] = { 0,0,0,0 };
    d.ctx->OMSetBlendState(d.blendOff, bf, 0xffffffff);
    d.ctx->OMSetDepthStencilState(d.dss, 0);
    uint32_t ti = (tex.id && tex.id < d.textures.size()) ? tex.id : 1;
    if (ti < d.textures.size() && d.textures[ti].srv) d.ctx->PSSetShaderResources(0, 1, &d.textures[ti].srv);
    D3D11_MAPPED_SUBRESOURCE ms;
    if (SUCCEEDED(d.ctx->Map(d.cb, 0, D3D11_MAP_WRITE_DISCARD, 0, &ms))) {
        CbData* c = (CbData*)ms.pData; *c = CbData{};
        c->viewProj = d.viewProj;   // model unused (per-instance)
        c->lightDir[0]=d.lightDir[0]; c->lightDir[1]=d.lightDir[1]; c->lightDir[2]=d.lightDir[2];
        c->lightColor[0]=d.lightColor[0]; c->lightColor[1]=d.lightColor[1]; c->lightColor[2]=d.lightColor[2]; c->lightColor[3]=d.ambient;
        c->params[0]=alphaCutoff; c->params[1]= d.shadowRadius>0 ? 1.0f/(float)Impl::SHADOW_RES : 0.0f;
        c->params[2]=m.metallic; c->params[3]=m.roughness;
        c->envColor[0]=d.envColor[0]; c->envColor[1]=d.envColor[1]; c->envColor[2]=d.envColor[2]; c->envColor[3]=d.envIntensity;
        c->camPos[0]=d.camPos[0]; c->camPos[1]=d.camPos[1]; c->camPos[2]=d.camPos[2];
        c->lightViewProj = d.lightViewProj;
        d.ctx->Unmap(d.cb, 0);
    }
    ID3D11Buffer* vbs[2] = { m.vb, d.instanceVB };
    UINT strides[2] = { sizeof(Vertex), sizeof(Mat4) }, offs[2] = { 0, 0 };
    d.ctx->IASetInputLayout(d.instLayout);
    d.ctx->IASetVertexBuffers(0, 2, vbs, strides, offs);
    d.ctx->IASetIndexBuffer(m.ib, DXGI_FORMAT_R32_UINT, 0);
    d.ctx->VSSetShader(d.instVS, nullptr, 0);
    d.ctx->PSSetShader(d.ps, nullptr, 0);
    d.ctx->DrawIndexedInstanced(m.icount, (UINT)count, 0, 0, 0);
    d.ctx->IASetInputLayout(d.layout);   // restore the non-instanced layout
    d.ctx->VSSetShader(d.vs, nullptr, 0);
}

void Gfx::drawMeshInstancedShadow(MeshHandle mesh, const Mat4* models, size_t count) {
    Impl& d = *p_;
    if (d.shadowRadius <= 0 || mesh.id == 0 || mesh.id >= d.meshes.size() || !count) return;
    GpuMesh& m = d.meshes[mesh.id]; if (!m.vb) return;
    if (!uploadInstances(d.dev, d.ctx, d.instanceVB, d.instanceVBCap, models, count)) return;
    D3D11_MAPPED_SUBRESOURCE ms;
    if (SUCCEEDED(d.ctx->Map(d.cb, 0, D3D11_MAP_WRITE_DISCARD, 0, &ms))) {
        CbData* c = (CbData*)ms.pData; c->lightViewProj = d.lightViewProj; d.ctx->Unmap(d.cb, 0);
    }
    ID3D11Buffer* vbs[2] = { m.vb, d.instanceVB };
    UINT strides[2] = { sizeof(Vertex), sizeof(Mat4) }, offs[2] = { 0, 0 };
    d.ctx->IASetInputLayout(d.instLayout);
    d.ctx->IASetVertexBuffers(0, 2, vbs, strides, offs);
    d.ctx->IASetIndexBuffer(m.ib, DXGI_FORMAT_R32_UINT, 0);
    d.ctx->VSSetShader(d.instShVS, nullptr, 0);
    d.ctx->PSSetShader(nullptr, 0, 0);
    d.ctx->DrawIndexedInstanced(m.icount, (UINT)count, 0, 0, 0);
    d.ctx->IASetInputLayout(d.layout);
    d.ctx->VSSetShader(d.shVS, nullptr, 0);
}

void Gfx::endFrame() {
    Impl& d = *p_;
    ID3D11ShaderResourceView* nullSRV = nullptr;
    D3D11_VIEWPORT vp = {}; vp.Width = (FLOAT)d.width; vp.Height = (FLOAT)d.height; vp.MaxDepth = 1.0f;
    d.ctx->RSSetViewports(1, &vp);
    d.ctx->OMSetDepthStencilState(d.dssNone, 0);
    d.ctx->OMSetBlendState(d.blendOff, nullptr, 0xffffffff);
    d.ctx->IASetInputLayout(nullptr);
    d.ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    d.ctx->VSSetShader(d.fxVS, nullptr, 0);
    d.ctx->VSSetConstantBuffers(1, 1, &d.fxCb);
    d.ctx->PSSetConstantBuffers(1, 1, &d.fxCb);
    d.ctx->PSSetSamplers(0, 1, &d.fxSamp);
    D3D11_MAPPED_SUBRESOURCE ms;
    if (SUCCEEDED(d.ctx->Map(d.fxCb, 0, D3D11_MAP_WRITE_DISCARD, 0, &ms))) {
        FxCb* f = (FxCb*)ms.pData;
        f->invViewProj = d.invViewProj;
        f->camPos[0] = d.camPos[0]; f->camPos[1] = d.camPos[1]; f->camPos[2] = d.camPos[2]; f->camPos[3] = 0;
        f->skyParams[0] = d.skyOpacity; f->skyParams[1] = d.skyRotation; f->skyParams[2] = d.exposure;
        d.grainT += 1.7f; f->skyParams[3] = d.grainT;
        f->dofParams[0] = d.dofFocus; f->dofParams[1] = d.dofRange; f->dofParams[2] = d.dofMaxBlur;
        f->dofParams[3] = d.height ? (float)d.height / (float)d.width : 1.0f;
        f->rcpFrame[0] = d.width ? 1.0f/d.width : 0; f->rcpFrame[1] = d.height ? 1.0f/d.height : 0;
        d.ctx->Unmap(d.fxCb, 0);
    }
    // Pass 1: tonemap the HDR scene into the LDR target.
    d.ctx->OMSetRenderTargets(1, &d.ldrRTV, nullptr);
    d.ctx->PSSetShader(d.compPS, nullptr, 0);
    d.ctx->PSSetShaderResources(0, 1, &d.sceneSRV);
    d.ctx->PSSetShaderResources(2, 1, &d.depthSRV);
    d.ctx->Draw(3, 0);
    d.ctx->PSSetShaderResources(0, 1, &nullSRV);
    d.ctx->PSSetShaderResources(2, 1, &nullSRV);
    // Pass 2: FXAA the LDR image onto the display backbuffer.
    d.ctx->OMSetRenderTargets(1, &d.rtv, nullptr);
    d.ctx->PSSetShader(d.fxaaPS, nullptr, 0);
    d.ctx->PSSetShaderResources(0, 1, &d.ldrSRV);
    d.ctx->Draw(3, 0);
    d.ctx->PSSetShaderResources(0, 1, &nullSRV);   // unbind ldr (it's an RTV next frame)
    // backbuffer now holds the AA'd image; UI overlay draws on top, then present().
}

void Gfx::present() { p_->swap->Present(1, 0); }

void Gfx::drawOverlay(const Overlay2DVert* verts, size_t count, TexHandle tex) {
    Impl& d = *p_;
    if (!verts || count < 3) return;
    if (count > d.ovVBCap) {   // grow the dynamic vertex buffer
        if (d.ovVB) { d.ovVB->Release(); d.ovVB = nullptr; }
        D3D11_BUFFER_DESC vd = {}; vd.ByteWidth = (UINT)(count * sizeof(Overlay2DVert));
        vd.Usage = D3D11_USAGE_DYNAMIC; vd.BindFlags = D3D11_BIND_VERTEX_BUFFER; vd.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
        if (FAILED(d.dev->CreateBuffer(&vd, nullptr, &d.ovVB))) return;
        d.ovVBCap = (UINT)count;
    }
    D3D11_MAPPED_SUBRESOURCE ms;
    if (SUCCEEDED(d.ctx->Map(d.ovVB, 0, D3D11_MAP_WRITE_DISCARD, 0, &ms))) {
        std::memcpy(ms.pData, verts, count * sizeof(Overlay2DVert)); d.ctx->Unmap(d.ovVB, 0);
    }
    D3D11_MAPPED_SUBRESOURCE cm;
    if (SUCCEEDED(d.ctx->Map(d.ovCb, 0, D3D11_MAP_WRITE_DISCARD, 0, &cm))) {
        float* r = (float*)cm.pData; r[0] = d.width ? 1.0f/d.width : 0; r[1] = d.height ? 1.0f/d.height : 0; r[2] = r[3] = 0;
        d.ctx->Unmap(d.ovCb, 0);
    }
    d.ctx->OMSetRenderTargets(1, &d.rtv, nullptr);
    d.ctx->OMSetDepthStencilState(d.dssNone, 0);
    const float bf[4] = { 0,0,0,0 };
    d.ctx->OMSetBlendState(d.blendOn, bf, 0xffffffff);
    d.ctx->RSSetState(d.rs);
    d.ctx->IASetInputLayout(d.ovLayout);
    d.ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    UINT stride = sizeof(Overlay2DVert), offset = 0;
    d.ctx->IASetVertexBuffers(0, 1, &d.ovVB, &stride, &offset);
    d.ctx->VSSetShader(d.ovVS, nullptr, 0);
    d.ctx->PSSetShader(d.ovPS, nullptr, 0);
    d.ctx->VSSetConstantBuffers(2, 1, &d.ovCb);
    uint32_t ti = (tex.id && tex.id < d.textures.size()) ? tex.id : 1;
    if (ti < d.textures.size() && d.textures[ti].srv) d.ctx->PSSetShaderResources(0, 1, &d.textures[ti].srv);
    d.ctx->PSSetSamplers(0, 1, &d.samp);
    d.ctx->Draw((UINT)count, 0);
}

void Gfx::drawParticles(const ParticleVert* verts, size_t count, bool additive) {
    Impl& d = *p_;
    if (!verts || count < 3) return;
    if (count > d.ptVBCap) {   // grow the dynamic vertex buffer
        if (d.ptVB) { d.ptVB->Release(); d.ptVB = nullptr; }
        D3D11_BUFFER_DESC vd = {}; vd.ByteWidth = (UINT)(count * sizeof(ParticleVert));
        vd.Usage = D3D11_USAGE_DYNAMIC; vd.BindFlags = D3D11_BIND_VERTEX_BUFFER; vd.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
        if (FAILED(d.dev->CreateBuffer(&vd, nullptr, &d.ptVB))) return;
        d.ptVBCap = (UINT)count;
    }
    D3D11_MAPPED_SUBRESOURCE ms;
    if (SUCCEEDED(d.ctx->Map(d.ptVB, 0, D3D11_MAP_WRITE_DISCARD, 0, &ms))) {
        std::memcpy(ms.pData, verts, count * sizeof(ParticleVert)); d.ctx->Unmap(d.ptVB, 0);
    }
    // b0 carries viewProj (the VS reads it); map model=identity + current viewProj.
    D3D11_MAPPED_SUBRESOURCE cm;
    if (SUCCEEDED(d.ctx->Map(d.cb, 0, D3D11_MAP_WRITE_DISCARD, 0, &cm))) {
        CbData* c = (CbData*)cm.pData; *c = CbData{}; c->model = identity(); c->viewProj = d.viewProj;
        d.ctx->Unmap(d.cb, 0);
    }
    d.ctx->OMSetRenderTargets(1, &d.sceneRTV, d.dsv);    // HDR scene target, with the scene depth
    d.ctx->OMSetDepthStencilState(d.dssReadNoWrite, 0);  // depth TEST (occluded by geometry), no WRITE
    const float bf[4] = { 0, 0, 0, 0 };
    d.ctx->OMSetBlendState(additive ? d.blendAddPM : d.blendOverPM, bf, 0xffffffff);
    d.ctx->RSSetState(d.rs);
    d.ctx->IASetInputLayout(d.ptLayout);
    d.ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    UINT stride = sizeof(ParticleVert), offset = 0;
    d.ctx->IASetVertexBuffers(0, 1, &d.ptVB, &stride, &offset);
    d.ctx->VSSetShader(d.ptVS, nullptr, 0);
    d.ctx->PSSetShader(d.ptPS, nullptr, 0);
    d.ctx->VSSetConstantBuffers(0, 1, &d.cb);
    uint32_t ti = (d.ptSprite < d.textures.size()) ? d.ptSprite : 1;
    if (d.textures[ti].srv) d.ctx->PSSetShaderResources(0, 1, &d.textures[ti].srv);
    d.ctx->PSSetSamplers(0, 1, &d.samp);
    d.ctx->Draw((UINT)count, 0);
}

bool Gfx::screenshot(std::vector<uint8_t>& rgba, int& w, int& h) {
    ID3D11Texture2D* back = nullptr;
    if (FAILED(p_->swap->GetBuffer(0, __uuidof(ID3D11Texture2D), (void**)&back)) || !back) return false;
    D3D11_TEXTURE2D_DESC bd{}; back->GetDesc(&bd);
    D3D11_TEXTURE2D_DESC sd = bd;
    sd.Usage = D3D11_USAGE_STAGING; sd.BindFlags = 0;
    sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ; sd.MiscFlags = 0;
    ID3D11Texture2D* stg = nullptr;
    if (FAILED(p_->dev->CreateTexture2D(&sd, nullptr, &stg)) || !stg) { back->Release(); return false; }
    p_->ctx->CopyResource(stg, back);
    D3D11_MAPPED_SUBRESOURCE ms{};
    bool ok = SUCCEEDED(p_->ctx->Map(stg, 0, D3D11_MAP_READ, 0, &ms));
    if (ok) {
        w = (int)bd.Width; h = (int)bd.Height;
        rgba.resize((size_t)w * h * 4);
        const uint8_t* src = (const uint8_t*)ms.pData;
        for (int y = 0; y < h; y++) std::memcpy(&rgba[(size_t)y * w * 4], src + (size_t)y * ms.RowPitch, (size_t)w * 4);
        p_->ctx->Unmap(stg, 0);
    }
    stg->Release(); back->Release();
    return ok;
}

} // namespace ae1
