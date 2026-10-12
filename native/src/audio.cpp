// audio.cpp — miniaudio implementation of the Audio seam (see audio.hpp).
#include "audio.hpp"
#include "miniaudio.h"   // declarations only; the impl is in ma_impl.c

#include <vector>

#pragma comment(lib, "ole32.lib")   // WASAPI (CoInitialize) on Windows

namespace ae1 {

struct Voice { ma_decoder dec; ma_sound snd; };

struct Audio::Impl {
    ma_engine engine;
    ma_sound_group music;         // looping voices route here
    ma_sound_group sfx;           // one-shots route here
    bool  groupsOK = false;
    float musicVol = 1.0f, sfxVol = 1.0f;
    bool  muted = false;
    std::vector<Voice*> voices;   // kept alive while playing (decoder must outlive the sound)
};

Audio::~Audio() { shutdown(); }

bool Audio::init(std::string& err) {
    Impl* d = new Impl();
    if (ma_engine_init(nullptr, &d->engine) != MA_SUCCESS) {
        delete d;
        err = "no audio device (ma_engine_init failed)";
        return false;   // headless / no speakers — caller treats audio as absent
    }
    // Two buses under the engine master. If group init fails on some driver,
    // fall back to routing straight to the engine (groupsOK stays false).
    if (ma_sound_group_init(&d->engine, 0, nullptr, &d->music) == MA_SUCCESS &&
        ma_sound_group_init(&d->engine, 0, nullptr, &d->sfx)   == MA_SUCCESS) {
        d->groupsOK = true;
    }
    p_ = d;
    return true;
}

void Audio::shutdown() {
    if (!p_) return;
    for (Voice* v : p_->voices) {
        ma_sound_uninit(&v->snd);
        ma_decoder_uninit(&v->dec);
        delete v;
    }
    p_->voices.clear();
    if (p_->groupsOK) { ma_sound_group_uninit(&p_->music); ma_sound_group_uninit(&p_->sfx); }
    ma_engine_uninit(&p_->engine);
    delete p_;
    p_ = nullptr;
}

bool Audio::play(const uint8_t* data, size_t len, bool loop, float volume) {
    if (!p_ || !data || !len) return false;
    Voice* v = new Voice();
    if (ma_decoder_init_memory(data, len, nullptr, &v->dec) != MA_SUCCESS) { delete v; return false; }
    ma_sound_group* grp = p_->groupsOK ? (loop ? &p_->music : &p_->sfx) : nullptr;
    if (ma_sound_init_from_data_source(&p_->engine, &v->dec, 0, grp, &v->snd) != MA_SUCCESS) {
        ma_decoder_uninit(&v->dec); delete v; return false;
    }
    ma_sound_set_looping(&v->snd, loop ? MA_TRUE : MA_FALSE);
    ma_sound_set_volume(&v->snd, volume);
    if (ma_sound_start(&v->snd) != MA_SUCCESS) {
        ma_sound_uninit(&v->snd); ma_decoder_uninit(&v->dec); delete v; return false;
    }
    p_->voices.push_back(v);
    return true;
}

void Audio::setMusicVolume(float vol) {
    if (!p_) return;
    p_->musicVol = vol < 0 ? 0 : (vol > 1 ? 1 : vol);
    if (p_->groupsOK) ma_sound_group_set_volume(&p_->music, p_->musicVol);
}
void Audio::setSoundVolume(float vol) {
    if (!p_) return;
    p_->sfxVol = vol < 0 ? 0 : (vol > 1 ? 1 : vol);
    if (p_->groupsOK) ma_sound_group_set_volume(&p_->sfx, p_->sfxVol);
}
void Audio::setMuted(bool m) {
    if (!p_) return;
    p_->muted = m;
    ma_engine_set_volume(&p_->engine, m ? 0.0f : 1.0f);   // master gate, per-bus levels preserved
}

} // namespace ae1
