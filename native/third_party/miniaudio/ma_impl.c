/* ma_impl.c — the single translation unit that compiles miniaudio's
   implementation (built once into build/miniaudio.lib). MP3/WAV/FLAC decoding
   is on by default, which is all the AGP's transcoded audio needs. */
#define MA_IMPLEMENTATION
#include "miniaudio.h"
