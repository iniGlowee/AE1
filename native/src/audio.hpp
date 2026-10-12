// audio.hpp — the native audio seam (miniaudio).
//
// The browser's audio facade (voiceLine/playSound/playMusic) becomes native
// here: a miniaudio engine plays the pack's transcoded MP3s straight from the
// mmap'd bytes. If the host has no output device (a headless/service session),
// init fails gracefully and playback is a no-op — the game still runs.
#pragma once
#include <cstdint>
#include <string>

namespace ae1 {

class Audio {
public:
    Audio() = default;
    ~Audio();
    bool init(std::string& err);
    void shutdown();
    bool ok() const { return p_ != nullptr; }

    // Play encoded audio (MP3/WAV/FLAC) from memory. `data` must stay valid
    // while it plays (the AGP mapping does). Music passes loop=true — looping
    // voices route to the MUSIC bus, one-shots to the SFX bus, so the two
    // volumes below scale them independently (settings.js musicVolume/soundVolume).
    bool play(const uint8_t* data, size_t len, bool loop, float volume = 1.0f);

    // Settings buses. 0..1. setMuted silences the master without losing the
    // per-bus levels, so unmuting restores exactly what the sliders had.
    void setMusicVolume(float v);
    void setSoundVolume(float v);
    void setMuted(bool m);

private:
    struct Impl;
    Impl* p_ = nullptr;
};

} // namespace ae1
