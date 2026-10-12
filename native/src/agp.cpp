// agp.cpp — Win32 implementation of the AGP reader (see agp.hpp).
#include "agp.hpp"
#include "json.hpp"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <bcrypt.h>

#include <cstdio>
#include <fstream>

#pragma comment(lib, "bcrypt.lib")

namespace ae1 {

// ---- file read ------------------------------------------------------------

bool readFile(const std::string& path, std::string& out, std::string& err) {
    std::ifstream f(path, std::ios::binary | std::ios::ate);
    if (!f) { err = "cannot open " + path; return false; }
    std::streamsize sz = f.tellg();
    f.seekg(0, std::ios::beg);
    out.resize((size_t)sz);
    if (sz > 0 && !f.read(&out[0], sz)) { err = "read failed: " + path; return false; }
    return true;
}

// ---- sha256 (BCrypt) ------------------------------------------------------

std::string sha256hex(const uint8_t* data, size_t len) {
    BCRYPT_ALG_HANDLE alg = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    std::string result;
    unsigned char digest[32];

    if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0)
        return result;
    if (BCryptCreateHash(alg, &hash, nullptr, 0, nullptr, 0, 0) == 0) {
        // BCryptHashData takes a ULONG length; hash in chunks for >4GB safety.
        size_t off = 0;
        bool ok = true;
        while (off < len) {
            ULONG chunk = (ULONG)((len - off > 0x40000000ull) ? 0x40000000ull : (len - off));
            if (BCryptHashData(hash, (PUCHAR)(data + off), chunk, 0) != 0) { ok = false; break; }
            off += chunk;
        }
        if (ok && BCryptFinishHash(hash, digest, sizeof digest, 0) == 0) {
            static const char* hx = "0123456789abcdef";
            result.resize(64);
            for (int i = 0; i < 32; i++) {
                result[i * 2]     = hx[digest[i] >> 4];
                result[i * 2 + 1] = hx[digest[i] & 0xF];
            }
        }
        BCryptDestroyHash(hash);
    }
    BCryptCloseAlgorithmProvider(alg, 0);
    return result;
}

// ---- Aepack ---------------------------------------------------------------

Aepack::~Aepack() { close(); }

void Aepack::close() {
    if (base_)       { UnmapViewOfFile((LPCVOID)base_); base_ = nullptr; }
    if (mapHandle_)  { CloseHandle((HANDLE)mapHandle_);  mapHandle_ = nullptr; }
    if (fileHandle_) { CloseHandle((HANDLE)fileHandle_); fileHandle_ = nullptr; }
    entries_.clear();
    fileSize_ = 0; payloadStart_ = 0; version_ = 0;
}

bool Aepack::open(const std::string& path, std::string& err) {
    close();

    HANDLE fh = CreateFileA(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (fh == INVALID_HANDLE_VALUE) { err = "cannot open " + path; return false; }
    fileHandle_ = fh;

    LARGE_INTEGER li;
    if (!GetFileSizeEx(fh, &li) || li.QuadPart < 12) {
        err = "file too small to be an aepack";
        close(); return false;
    }
    fileSize_ = (uint64_t)li.QuadPart;

    HANDLE mh = CreateFileMappingA(fh, nullptr, PAGE_READONLY, 0, 0, nullptr);
    if (!mh) { err = "CreateFileMapping failed"; close(); return false; }
    mapHandle_ = mh;

    const uint8_t* p = (const uint8_t*)MapViewOfFile(mh, FILE_MAP_READ, 0, 0, 0);
    if (!p) { err = "MapViewOfFile failed"; close(); return false; }
    base_ = p;

    // Header: 'AEPK' | u32 version (LE) | u32 tocLen (LE).
    if (!(p[0] == 'A' && p[1] == 'E' && p[2] == 'P' && p[3] == 'K')) {
        err = "bad magic (not 'AEPK')"; close(); return false;
    }
    auto rdU32 = [](const uint8_t* q) -> uint32_t {
        return (uint32_t)q[0] | ((uint32_t)q[1] << 8) |
               ((uint32_t)q[2] << 16) | ((uint32_t)q[3] << 24);
    };
    version_ = rdU32(p + 4);
    uint32_t tocLen = rdU32(p + 8);
    uint64_t tocStart = 12;
    if (tocStart + tocLen > fileSize_) { err = "TOC length exceeds file"; close(); return false; }
    payloadStart_ = tocStart + tocLen;

    try {
        Json toc = Json::parse((const char*)(p + tocStart), tocLen);
        const Json& arr = toc["entries"];
        if (!arr.isArray()) { err = "TOC has no entries array"; close(); return false; }
        entries_.reserve(arr.size());
        for (size_t k = 0; k < arr.size(); k++) {
            const Json& e = arr[k];
            AepackEntry ae;
            ae.name   = e["name"].str();
            ae.bag    = e["bag"].str();
            ae.offset = (uint64_t)e["offset"].num();
            ae.length = (uint64_t)e["length"].num();
            ae.sha256 = e["sha256"].str();
            // Bounds-check every entry against the mapping now, so data() is
            // always safe later.
            if (payloadStart_ + ae.offset + ae.length > fileSize_) {
                err = "entry '" + ae.name + "' extends past end of file";
                close(); return false;
            }
            entries_.push_back(std::move(ae));
        }
    } catch (const std::exception& ex) {
        err = std::string("TOC parse: ") + ex.what();
        close(); return false;
    }
    return true;
}

const AepackEntry* Aepack::find(const std::string& name) const {
    for (const auto& e : entries_)
        if (e.name == name) return &e;
    return nullptr;
}

// ---- manifest -------------------------------------------------------------

bool AgpManifest::load(const std::string& path, AgpManifest& out, std::string& err) {
    std::string txt;
    if (!readFile(path, txt, err)) return false;
    try {
        Json m = Json::parse(txt);
        out.agpVersion  = (int)m["agpVersion"].num();
        out.engine      = m["engine"].str();
        const Json& g = m["game"];
        out.gameId      = g["id"].str();
        out.title       = g["title"].str();
        out.gameVersion = g["version"].str();
        out.entryScene  = g["entryScene"].str();
        const Json& d = m["data"];
        out.dataFile    = d["file"].str();
        out.dataBytes   = (uint64_t)d["bytes"].num();
        out.dataSha     = d["sha256"].str();
        const Json& pl = m["payload"];
        out.payloadFile = pl["file"].str();
        out.payloadBytes= (uint64_t)pl["bytes"].num();
        out.payloadSha  = pl["sha256"].str();
        out.assets      = (int)pl["assets"].num();
    } catch (const std::exception& ex) {
        err = std::string("manifest parse: ") + ex.what();
        return false;
    }
    return true;
}

} // namespace ae1
