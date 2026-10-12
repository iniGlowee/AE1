// main.cpp — ae1pack: the native AGP inspector.
//
// Usage: ae1pack <agp-dir> [--verify]
//
// Reads an AE1 Game Package the way the future native player will: parse
// manifest.json, memory-map game.aepack, parse the TOC, parse data.json, and
// report the whole game inventory (identity, scenes, scripts, media, assets).
// With --verify it re-hashes data.json, the whole aepack, and every asset in
// the TOC, and checks them against the recorded sha256 digests.
//
// This is Phase-A step 0 of docs/engine/20: it establishes, in C++, that the
// package contract holds end to end before any window or GPU exists.
#include "agp.hpp"
#include "json.hpp"

#include <cstdio>
#include <string>
#include <vector>
#include <algorithm>

using namespace ae1;

static std::string humanBytes(uint64_t n) {
    char buf[64];
    const char* u[] = {"B", "KB", "MB", "GB", "TB"};
    double v = (double)n; int i = 0;
    while (v >= 1024.0 && i < 4) { v /= 1024.0; i++; }
    if (i == 0) std::snprintf(buf, sizeof buf, "%llu %s", (unsigned long long)n, u[i]);
    else        std::snprintf(buf, sizeof buf, "%.2f %s", v, u[i]);
    return buf;
}

static std::string joinPath(const std::string& dir, const std::string& file) {
    if (dir.empty()) return file;
    char last = dir.back();
    if (last == '/' || last == '\\') return dir + file;
    return dir + "\\" + file;
}

static void rule() { std::printf("--------------------------------------------------------------\n"); }

int main(int argc, char** argv) {
    if (argc < 2) {
        std::printf("ae1pack — AE1 Game Package inspector\n"
                    "usage: ae1pack <agp-dir> [--verify]\n");
        return 2;
    }
    std::string dir = argv[1];
    bool verify = false;
    for (int i = 2; i < argc; i++)
        if (std::string(argv[i]) == "--verify") verify = true;

    std::string err;

    // ---- manifest ----
    AgpManifest man;
    if (!AgpManifest::load(joinPath(dir, "manifest.json"), man, err)) {
        std::printf("ERROR: %s\n", err.c_str());
        return 1;
    }
    rule();
    std::printf("  AE1 GAME PACKAGE   (agpVersion %d)\n", man.agpVersion);
    rule();
    std::printf("  Title       : %s\n", man.title.c_str());
    std::printf("  Game id     : %s\n", man.gameId.c_str());
    std::printf("  Game version: %s\n", man.gameVersion.c_str());
    std::printf("  Engine      : %s\n", man.engine.c_str());
    std::printf("  Entry scene : %s\n", man.entryScene.c_str());
    std::printf("  data.json   : %s (%s)\n", humanBytes(man.dataBytes).c_str(), man.dataFile.c_str());
    std::printf("  game.aepack : %s, %d assets (%s)\n",
                humanBytes(man.payloadBytes).c_str(), man.assets, man.payloadFile.c_str());

    // ---- data.json ----
    std::string dataTxt;
    if (!readFile(joinPath(dir, man.dataFile), dataTxt, err)) {
        std::printf("ERROR: %s\n", err.c_str());
        return 1;
    }
    Json data;
    try { data = Json::parse(dataTxt); }
    catch (const std::exception& ex) {
        std::printf("ERROR: data.json parse: %s\n", ex.what());
        return 1;
    }
    const Json& scenes  = data["scenes"];
    const Json& scripts = data["scripts"];
    const Json& media   = data["media"];
    rule();
    std::printf("  GAME DEFINITION (data.json)\n");
    rule();
    std::printf("  Scenes  : %zu\n", scenes.size());
    for (const auto& kv : scenes.obj())
        std::printf("      - %s\n", kv.first.c_str());
    std::printf("  Scripts : %zu\n", scripts.size());
    if (scripts.isObject()) {
        int shown = 0;
        for (const auto& kv : scripts.obj()) {
            if (shown++ < 12) std::printf("      - %s\n", kv.first.c_str());
        }
        if ((int)scripts.size() > 12) std::printf("      ... +%zu more\n", scripts.size() - 12);
    }
    std::printf("  Media   : %zu entries in the media index\n", media.size());

    // ---- aepack ----
    Aepack pack;
    if (!pack.open(joinPath(dir, man.payloadFile), err)) {
        std::printf("ERROR: %s\n", err.c_str());
        return 1;
    }
    rule();
    std::printf("  BINARY PAYLOAD (game.aepack v%u, %s)\n",
                pack.version(), humanBytes(pack.fileSize()).c_str());
    rule();

    // Group by bag, largest first within each bag.
    for (const char* bag : {"glbs", "bins"}) {
        std::vector<const AepackEntry*> es;
        uint64_t total = 0;
        for (const auto& e : pack.entries())
            if (e.bag == bag) { es.push_back(&e); total += e.length; }
        if (es.empty()) continue;
        std::sort(es.begin(), es.end(),
                  [](const AepackEntry* a, const AepackEntry* b){ return a->length > b->length; });
        std::printf("  [%s]  %zu assets, %s\n", bag, es.size(), humanBytes(total).c_str());
        for (const auto* e : es)
            std::printf("      %10s   %s\n", humanBytes(e->length).c_str(), e->name.c_str());
    }

    // ---- verify ----
    if (verify) {
        rule();
        std::printf("  INTEGRITY (recomputed SHA-256 vs recorded)\n");
        rule();
        int fails = 0;

        std::string dsha = sha256hex((const uint8_t*)dataTxt.data(), dataTxt.size());
        bool dok = (dsha == man.dataSha);
        std::printf("  %-24s %s\n", "data.json", dok ? "OK" : "MISMATCH");
        if (!dok) { fails++; std::printf("      want %s\n      got  %s\n", man.dataSha.c_str(), dsha.c_str()); }

        // Whole-pack hash — hash the mapped bytes directly (zero re-read).
        std::string psha = sha256hex(pack.base(), (size_t)pack.fileSize());
        bool pok = (!psha.empty() && psha == man.payloadSha);
        std::printf("  %-24s %s\n", "game.aepack (whole)", pok ? "OK" : "MISMATCH");
        if (!pok) { fails++; std::printf("      want %s\n      got  %s\n", man.payloadSha.c_str(), psha.c_str()); }

        // Every asset, hashed from its zero-copy view.
        int assetFails = 0;
        for (const auto& e : pack.entries()) {
            std::string h = sha256hex(pack.data(e), (size_t)e.length);
            if (h != e.sha256) {
                assetFails++;
                std::printf("  asset MISMATCH: %s\n      want %s\n      got  %s\n",
                            e.name.c_str(), e.sha256.c_str(), h.c_str());
            }
        }
        std::printf("  %-24s %s (%zu checked)\n", "assets",
                    assetFails == 0 ? "ALL OK" : "FAILURES", pack.entries().size());
        fails += assetFails;

        rule();
        if (fails == 0) std::printf("  RESULT: package verified — all digests match.\n");
        else            std::printf("  RESULT: %d integrity failure(s).\n", fails);
        rule();
        return fails == 0 ? 0 : 1;
    }

    rule();
    std::printf("  OK: package parsed. (run with --verify to check integrity)\n");
    rule();
    return 0;
}
