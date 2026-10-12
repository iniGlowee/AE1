// tex.hpp — decode a KTX2 (Basis Universal) texture to RGBA8.
//
// The pack's baseColor textures are KHR_texture_basisu / KTX2 (ETC1S for opaque,
// UASTC for alpha). The browser transcodes them with the basis wasm; natively we
// use the vendored Basis Universal transcoder to unpack to plain RGBA8, which
// D3D11 uploads directly. (Block-format upload — BC7 etc. — is a later tidy.)
#pragma once
#include <vector>
#include <cstdint>
#include <string>

namespace ae1 {

struct Image {
    std::vector<uint8_t> rgba;   // width*height*4, row-major, top-left origin
    int w = 0, h = 0;
};

// Transcode a KTX2 blob (level 0) to RGBA8. false + err on failure.
bool transcodeKTX2(const uint8_t* data, size_t len, Image& out, std::string& err);

// Decode a PNG/JPEG blob to RGBA8 (via stb_image). The pack keeps soft-alpha
// cutout images (e.g. hair, §18.96) as PNG rather than KTX2. false + err on failure.
bool decodeImage(const uint8_t* data, size_t len, Image& out, std::string& err);

// Decode a Radiance .hdr blob to float32 RGB (via stb_image, linear). Used for
// the equirect skybox / image-based light. `out` is width*height*3 floats.
bool decodeHDR(const uint8_t* data, size_t len, std::vector<float>& out, int& w, int& h, std::string& err);

// A baked glyph atlas (ASCII 32..126) for the native UI text renderer.
struct GlyphAtlas {
    Image image;            // RGBA: white rgb, alpha = coverage
    float pixelHeight = 0;  // the size baked at
    float ascent = 0;       // px above baseline (for line layout)
    struct G { float u0, v0, u1, v1; float xoff, yoff, xadv; float w, h; };
    G glyph[95] = {};       // index = char - 32
};
// Rasterize a TTF blob (via stb_truetype) into a glyph atlas at `pixelHeight`.
bool bakeFont(const uint8_t* ttf, size_t len, float pixelHeight, GlyphAtlas& out, std::string& err);

} // namespace ae1
