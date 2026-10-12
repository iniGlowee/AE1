// agp.hpp — the native reader for the AE1 Game Package (AGP, docs/engine/21).
//
// An AGP directory is: manifest.json + data.json + game.aepack. This reader is
// the native mirror of the browser loader (play.html's fetch path): it memory-
// maps game.aepack once and hands out ZERO-COPY views into the mapping, exactly
// as the plan (docs/engine/20) says the native runtime should — "the exe mmaps
// media.bin; no decode-the-universe load step."
//
// The aepack byte layout (must match exporter.build_aepack exactly):
//   'AEPK'            4 bytes, raw ASCII (read as-is, NOT endian-swapped)
//   u32 version       little-endian
//   u32 tocLen        little-endian — length of the TOC JSON in bytes
//   toc               tocLen bytes of UTF-8 JSON: {agpVersion, entries:[...]}
//   payload           entries' offsets are relative to HERE; each 8-aligned
//
// This is Phase-A step 0: no window, no GPU yet. It proves the contract from
// C++ so every later system (renderer, audio, scripts) loads assets the same
// way. Windows-only for now (Win32 mmap + BCrypt); the surface is portable.
#pragma once
#include <string>
#include <vector>
#include <cstdint>

namespace ae1 {

struct AepackEntry {
    std::string name;    // asset name, e.g. "2b.glb" or "mm/pose66t.bin"
    std::string bag;     // "glbs" or "bins"
    uint64_t    offset;  // byte offset into the payload region
    uint64_t    length;  // asset size in bytes
    std::string sha256;  // hex digest recorded at build time (for verify)
};

// Memory-mapped game.aepack. Copyable? No — owns OS handles. Move-only-ish;
// we just keep one alive for the process. Views returned by data() are valid
// until close()/destruction.
class Aepack {
public:
    Aepack() = default;
    ~Aepack();
    Aepack(const Aepack&) = delete;
    Aepack& operator=(const Aepack&) = delete;

    // Maps the file and parses the header + TOC. Returns false and fills `err`
    // on any failure (missing file, bad magic, truncated TOC).
    bool open(const std::string& path, std::string& err);
    void close();

    bool        isOpen()   const { return base_ != nullptr; }
    uint32_t    version()  const { return version_; }
    uint64_t    fileSize() const { return fileSize_; }
    const std::vector<AepackEntry>& entries() const { return entries_; }

    // Zero-copy pointer to an asset's raw bytes inside the mapping.
    const uint8_t* data(const AepackEntry& e) const {
        return base_ + payloadStart_ + e.offset;
    }
    const AepackEntry* find(const std::string& name) const;

    // Start of the whole mapped file (magic byte 0). Valid while open.
    const uint8_t* base() const { return base_; }
    uint64_t payloadStart() const { return payloadStart_; }

private:
    void*    fileHandle_ = nullptr;   // HANDLE (opaque to avoid windows.h here)
    void*    mapHandle_  = nullptr;   // HANDLE
    const uint8_t* base_ = nullptr;   // MapViewOfFile result
    uint64_t fileSize_    = 0;
    uint64_t payloadStart_= 0;
    uint32_t version_     = 0;
    std::vector<AepackEntry> entries_;
};

// Parsed manifest.json — the AGP entry point.
struct AgpManifest {
    int         agpVersion = 0;
    std::string engine;
    std::string gameId, title, gameVersion, entryScene;
    std::string dataFile;    uint64_t dataBytes = 0;    std::string dataSha;
    std::string payloadFile; uint64_t payloadBytes = 0; std::string payloadSha;
    int         assets = 0;

    static bool load(const std::string& path, AgpManifest& out, std::string& err);
};

// SHA-256 (hex, lowercase) of a buffer, via the Windows CNG (BCrypt) provider.
std::string sha256hex(const uint8_t* data, size_t len);

// Read a whole file into a string. Returns false + err on failure.
bool readFile(const std::string& path, std::string& out, std::string& err);

} // namespace ae1
