// tex.cpp — KTX2 -> RGBA8 via Basis Universal; PNG/JPEG -> RGBA8 via stb_image.
#include "tex.hpp"
#include "basisu_transcoder.h"

#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG
#define STBI_ONLY_JPEG
#define STBI_ONLY_HDR      // equirect skybox (Radiance .hdr) via stbi_loadf
#define STBI_NO_STDIO
#include "stb_image.h"

#define STB_TRUETYPE_IMPLEMENTATION
#include "stb_truetype.h"

namespace ae1 {

bool bakeFont(const uint8_t* ttf, size_t len, float pixelHeight, GlyphAtlas& out, std::string& err) {
    stbtt_fontinfo font;
    if (!stbtt_InitFont(&font, ttf, stbtt_GetFontOffsetForIndex(ttf, 0))) { err = "stbtt init failed"; return false; }
    const int W = 512, H = 512;
    std::vector<unsigned char> bmp((size_t)W * H, 0);
    stbtt_bakedchar chars[95];
    // negative return = didn't fit; positive = last row used. Either way `chars` is filled for what fit.
    stbtt_BakeFontBitmap(ttf, 0, pixelHeight, bmp.data(), W, H, 32, 95, chars);
    int asc = 0, desc = 0, gap = 0; stbtt_GetFontVMetrics(&font, &asc, &desc, &gap);
    float scale = stbtt_ScaleForPixelHeight(&font, pixelHeight);
    out.pixelHeight = pixelHeight;
    out.ascent = asc * scale;
    out.image.w = W; out.image.h = H;
    out.image.rgba.assign((size_t)W * H * 4, 0);
    for (size_t i = 0; i < (size_t)W * H; i++) {
        unsigned char a = bmp[i];
        out.image.rgba[i*4+0] = 255; out.image.rgba[i*4+1] = 255; out.image.rgba[i*4+2] = 255; out.image.rgba[i*4+3] = a;
    }
    for (int i = 0; i < 95; i++) {
        const stbtt_bakedchar& b = chars[i];
        GlyphAtlas::G& g = out.glyph[i];
        g.u0 = b.x0 / (float)W; g.v0 = b.y0 / (float)H; g.u1 = b.x1 / (float)W; g.v1 = b.y1 / (float)H;
        g.w = (float)(b.x1 - b.x0); g.h = (float)(b.y1 - b.y0);
        g.xoff = b.xoff; g.yoff = b.yoff; g.xadv = b.xadvance;
    }
    return true;
}

bool decodeImage(const uint8_t* data, size_t len, Image& out, std::string& err) {
    int w = 0, h = 0, ch = 0;
    unsigned char* px = stbi_load_from_memory(data, (int)len, &w, &h, &ch, 4);
    if (!px) { const char* r = stbi_failure_reason(); err = r ? r : "stbi decode failed"; return false; }
    out.w = w; out.h = h;
    out.rgba.assign(px, px + (size_t)w * h * 4);
    stbi_image_free(px);
    return true;
}

bool decodeHDR(const uint8_t* data, size_t len, std::vector<float>& out, int& w, int& h, std::string& err) {
    int ch = 0;
    float* px = stbi_loadf_from_memory(data, (int)len, &w, &h, &ch, 3);   // force RGB
    if (!px) { const char* r = stbi_failure_reason(); err = r ? r : "stbi hdr decode failed"; return false; }
    out.assign(px, px + (size_t)w * h * 3);
    stbi_image_free(px);
    return true;
}

bool transcodeKTX2(const uint8_t* data, size_t len, Image& out, std::string& err) {
    static bool inited = false;
    if (!inited) { basist::basisu_transcoder_init(); inited = true; }

    basist::ktx2_transcoder t;
    if (!t.init(data, (uint32_t)len)) { err = "ktx2 init failed"; return false; }
    if (!t.start_transcoding())       { err = "ktx2 start_transcoding failed"; return false; }

    uint32_t w = t.get_width(), h = t.get_height();
    if (w == 0 || h == 0) { err = "ktx2 zero dimensions"; return false; }
    out.w = (int)w; out.h = (int)h;
    out.rgba.assign((size_t)w * h * 4, 0);

    // level 0, layer 0, face 0 -> RGBA32 (one uint32 per pixel)
    if (!t.transcode_image_level(0, 0, 0, out.rgba.data(), w * h,
                                 basist::transcoder_texture_format::cTFRGBA32)) {
        err = "transcode_image_level failed";
        return false;
    }
    return true;
}

} // namespace ae1
