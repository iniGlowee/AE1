// mat.hpp — tiny 4x4 matrix / vec3 math for the native renderer.
//
// Row-major storage, row-vector convention (v' = v * M), left-handed — the
// traditional D3D layout. HLSL cbuffers declare these `row_major` so the bytes
// upload as-is. Just enough to place a camera and spin a model; the real
// renderer will grow this (or lean on the engine's own math via QuickJS).
#pragma once
#include <cmath>

namespace ae1 {

struct Vec3 { float x, y, z; };

inline Vec3 operator-(Vec3 a, Vec3 b) { return { a.x - b.x, a.y - b.y, a.z - b.z }; }
inline float dot(Vec3 a, Vec3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline Vec3 cross(Vec3 a, Vec3 b) {
    return { a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x };
}
inline Vec3 normalize(Vec3 v) {
    float n = std::sqrt(dot(v, v));
    if (n < 1e-8f) return { 0, 0, 0 };
    return { v.x / n, v.y / n, v.z / n };
}

struct Mat4 {
    float m[16];  // row-major: m[row*4 + col]
};

inline Mat4 identity() {
    return { { 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1 } };
}

// row-vector convention: (a*b) applies a first, then b.
inline Mat4 mul(const Mat4& a, const Mat4& b) {
    Mat4 r{};
    for (int row = 0; row < 4; row++)
        for (int col = 0; col < 4; col++) {
            float s = 0;
            for (int k = 0; k < 4; k++) s += a.m[row * 4 + k] * b.m[k * 4 + col];
            r.m[row * 4 + col] = s;
        }
    return r;
}

// General 4x4 inverse (row-major). Used to reconstruct world-space view rays
// for the skybox (invViewProj · NDC). Returns identity if singular.
inline Mat4 inverse(const Mat4& in) {
    const float* m = in.m; float inv[16];
    inv[0]  =  m[5]*m[10]*m[15]-m[5]*m[11]*m[14]-m[9]*m[6]*m[15]+m[9]*m[7]*m[14]+m[13]*m[6]*m[11]-m[13]*m[7]*m[10];
    inv[4]  = -m[4]*m[10]*m[15]+m[4]*m[11]*m[14]+m[8]*m[6]*m[15]-m[8]*m[7]*m[14]-m[12]*m[6]*m[11]+m[12]*m[7]*m[10];
    inv[8]  =  m[4]*m[9]*m[15]-m[4]*m[11]*m[13]-m[8]*m[5]*m[15]+m[8]*m[7]*m[13]+m[12]*m[5]*m[11]-m[12]*m[7]*m[9];
    inv[12] = -m[4]*m[9]*m[14]+m[4]*m[10]*m[13]+m[8]*m[5]*m[14]-m[8]*m[6]*m[13]-m[12]*m[5]*m[10]+m[12]*m[6]*m[9];
    inv[1]  = -m[1]*m[10]*m[15]+m[1]*m[11]*m[14]+m[9]*m[2]*m[15]-m[9]*m[3]*m[14]-m[13]*m[2]*m[11]+m[13]*m[3]*m[10];
    inv[5]  =  m[0]*m[10]*m[15]-m[0]*m[11]*m[14]-m[8]*m[2]*m[15]+m[8]*m[3]*m[14]+m[12]*m[2]*m[11]-m[12]*m[3]*m[10];
    inv[9]  = -m[0]*m[9]*m[15]+m[0]*m[11]*m[13]+m[8]*m[1]*m[15]-m[8]*m[3]*m[13]-m[12]*m[1]*m[11]+m[12]*m[3]*m[9];
    inv[13] =  m[0]*m[9]*m[14]-m[0]*m[10]*m[13]-m[8]*m[1]*m[14]+m[8]*m[2]*m[13]+m[12]*m[1]*m[10]-m[12]*m[2]*m[9];
    inv[2]  =  m[1]*m[6]*m[15]-m[1]*m[7]*m[14]-m[5]*m[2]*m[15]+m[5]*m[3]*m[14]+m[13]*m[2]*m[7]-m[13]*m[3]*m[6];
    inv[6]  = -m[0]*m[6]*m[15]+m[0]*m[7]*m[14]+m[4]*m[2]*m[15]-m[4]*m[3]*m[14]-m[12]*m[2]*m[7]+m[12]*m[3]*m[6];
    inv[10] =  m[0]*m[5]*m[15]-m[0]*m[7]*m[13]-m[4]*m[1]*m[15]+m[4]*m[3]*m[13]+m[12]*m[1]*m[7]-m[12]*m[3]*m[5];
    inv[14] = -m[0]*m[5]*m[14]+m[0]*m[6]*m[13]+m[4]*m[1]*m[14]-m[4]*m[2]*m[13]-m[12]*m[1]*m[6]+m[12]*m[2]*m[5];
    inv[3]  = -m[1]*m[6]*m[11]+m[1]*m[7]*m[10]+m[5]*m[2]*m[11]-m[5]*m[3]*m[10]-m[9]*m[2]*m[7]+m[9]*m[3]*m[6];
    inv[7]  =  m[0]*m[6]*m[11]-m[0]*m[7]*m[10]-m[4]*m[2]*m[11]+m[4]*m[3]*m[10]+m[8]*m[2]*m[7]-m[8]*m[3]*m[6];
    inv[11] = -m[0]*m[5]*m[11]+m[0]*m[7]*m[9]+m[4]*m[1]*m[11]-m[4]*m[3]*m[9]-m[8]*m[1]*m[7]+m[8]*m[3]*m[5];
    inv[15] =  m[0]*m[5]*m[10]-m[0]*m[6]*m[9]-m[4]*m[1]*m[10]+m[4]*m[2]*m[9]+m[8]*m[1]*m[6]-m[8]*m[2]*m[5];
    float det = m[0]*inv[0]+m[1]*inv[4]+m[2]*inv[8]+m[3]*inv[12];
    if (det == 0.0f) return identity();
    det = 1.0f/det; Mat4 r; for (int i=0;i<16;i++) r.m[i]=inv[i]*det; return r;
}

inline Mat4 rotationY(float a) {
    float c = std::cos(a), s = std::sin(a);
    return { { c, 0, -s, 0,
               0, 1,  0, 0,
               s, 0,  c, 0,
               0, 0,  0, 1 } };
}

inline Mat4 translation(float x, float y, float z) {
    return { { 1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1 } };
}

inline Mat4 orthoLH(float w, float h, float zn, float zf) {
    return { { 2.0f/w, 0, 0, 0,
               0, 2.0f/h, 0, 0,
               0, 0, 1.0f/(zf-zn), 0,
               0, 0, -zn/(zf-zn), 1 } };
}

inline Mat4 perspectiveFovLH(float fovY, float aspect, float zn, float zf) {
    float ys = 1.0f / std::tan(fovY * 0.5f);
    float xs = ys / aspect;
    float q = zf / (zf - zn);
    return { { xs, 0,  0,       0,
               0,  ys, 0,       0,
               0,  0,  q,       1,
               0,  0,  -zn * q, 0 } };
}

inline Mat4 lookAtLH(Vec3 eye, Vec3 at, Vec3 up) {
    Vec3 z = normalize(at - eye);
    Vec3 x = normalize(cross(up, z));
    Vec3 y = cross(z, x);
    return { { x.x, y.x, z.x, 0,
               x.y, y.y, z.y, 0,
               x.z, y.z, z.z, 0,
               -dot(x, eye), -dot(y, eye), -dot(z, eye), 1 } };
}

} // namespace ae1
