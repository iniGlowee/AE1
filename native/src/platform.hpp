// platform.hpp — the native platform seam (window, input, timing, present).
//
// This is the interface docs/engine/20 calls the platform layer. Today the only
// implementation is Win32 + D3D11 (platform_win32.cpp), chosen because it needs
// ZERO third-party libraries — just the Windows SDK — so the Phase-A shell runs
// and is verifiable before we take the SDL3/bgfx download+vendoring step. When
// that step comes, an SDL3/bgfx implementation drops in behind THIS SAME header
// and nothing above it changes. That is the whole point of the seam.
//
// Scope for step 1: open a window, run a fixed-timestep loop, capture keyboard
// + mouse, clear the frame, present. No meshes yet — that is the renderer, a
// later increment layered on top of this.
#pragma once
#include <string>
#include <vector>
#include <cstdint>

namespace ae1 {

// ---- durable storage (save files + the localStorage KV) --------------------
// Beneath the platform seam because WHERE bytes durably land is host-specific
// (a Win32 file today; an SDL/XDG path, or a console storage API, later drop in
// behind this same header). The one rule that matters for a save system:
// storeWriteAtomic never leaves a half-written file. It writes a temp sibling,
// flushes it to the disk platter, then atomically renames it over the target —
// so a crash or power loss mid-save leaves EITHER the old bytes or the new,
// never a truncated ruin. The previous copy is kept as `<name>.bak`.
struct StoredFile { std::string name; uint64_t size = 0; double mtimeMs = 0; };
bool storeEnsureDir(const std::string& dir);
bool storeWriteAtomic(const std::string& path, const std::string& bytes);
bool storeRead(const std::string& path, std::string& out);
bool storeDelete(const std::string& path);
// Files in `dir` whose name ends with `suffix` (empty = all), newest first.
std::vector<StoredFile> storeList(const std::string& dir, const std::string& suffix);

// Key indices into FrameInput::down/pressed. These match Win32 virtual-key
// codes today (the Win32 impl fills the arrays by VK code, and ASCII letters/
// digits already equal their VK codes), but are named here so game/shell code
// never includes windows.h. This is the seed of the plan's input-name contract;
// SDL3 later maps its scancodes into the same indices behind the Platform seam.
namespace Key {
    enum {
        Escape = 0x1B, Space = 0x20,
        Left = 0x25, Up = 0x26, Right = 0x27, Down = 0x28,
        Shift = 0x10, Ctrl = 0x11, Alt = 0x12, Enter = 0x0D, Tab = 0x09,
        A = 'A', D = 'D', S = 'S', W = 'W',
    };
}

// Per-frame input snapshot. Key codes are Win32 virtual-key codes today; when
// SDL3 lands this maps to the same table (input3d's key-name contract, per the
// plan's Input seam). down = held this frame; pressed = went down THIS frame.
struct FrameInput {
    bool  down[256]    = {};
    bool  pressed[256] = {};
    int   mouseX = 0, mouseY = 0;   // client-area pixels
    int   mouseDX = 0, mouseDY = 0; // delta since last frame
    int   wheel = 0;                // notches this frame
    bool  mouseDown[3] = {};        // L, R, M
    bool  resized = false;          // client size changed this frame
    bool  quit = false;             // window closed / ALT+F4
};

// Gamepad snapshot (XInput pad 0). btn[] order matches the game's Pad* codes:
// A,B,X,Y, LB,RB, LT,RT, Start,Select, LS,RS, Up,Down,Left,Right (16).
struct Gamepad {
    bool  btn[16] = {};
    float lx = 0, ly = 0, rx = 0, ry = 0;   // sticks, -1..1, deadzone applied
    bool  connected = false;
};
// Read gamepad 0. Returns connected. No-op (connected=false) if none / no XInput.
bool pollGamepad(Gamepad& out);

class Platform {
public:
    Platform();
    ~Platform();
    Platform(const Platform&) = delete;
    Platform& operator=(const Platform&) = delete;

    // Create the window + graphics device. false + err on failure.
    bool create(const std::string& title, int width, int height, std::string& err);
    void destroy();

    // Drain OS messages and fill `in` with this frame's input. Returns false
    // when the app should exit (window closed).
    bool pump(FrameInput& in);

    // The OS window handle (HWND on Win32), opaque so callers need no windows.h.
    // The renderer (Gfx) creates its device/swapchain from this. Platform owns
    // the window, input, and time; rendering lives behind the Gfx seam.
    void* nativeHandle() const;

    void setTitle(const std::string& title);
    int  width()  const;
    int  height() const;

    // Pointer-lock for mouse-look: hide + confine the cursor and report relative
    // motion via FrameInput::mouseDX/DY (recentred each pump). Toggle off to
    // release the cursor. Idempotent.
    void captureMouse(bool on);

    // High-resolution wall clock, seconds since create(). The loop owns time
    // (plan's Timers/loop seam) — no script-visible clocks.
    double now() const;

    // Opaque implementation, defined in the platform .cpp. Public only so the
    // platform's own free-function window callback can name it; p_ stays private.
    struct Impl;
private:
    Impl* p_ = nullptr;
};

} // namespace ae1
