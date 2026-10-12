// platform_win32.cpp — Win32 + D3D11 implementation of the Platform seam.
//
// Uses only the Windows SDK (no SDL, no bgfx yet). D3D11 was picked over raw
// GL/D3D12 for step 1 because it stands up a window + swapchain + clear in the
// least code while being a real GPU path. The render backend here is
// deliberately minimal (clear + present); the actual renderer — matching
// three.js material/lighting semantics over a bgfx-style RHI — is a later
// increment that will sit behind a gfx interface, not in this file.
#include "platform.hpp"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <windowsx.h>   // GET_X_LPARAM
#include <Xinput.h>
#include <algorithm>    // std::sort (storeList)

#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "xinput9_1_0.lib")

namespace ae1 {

bool pollGamepad(Gamepad& out) {
    XINPUT_STATE st = {};
    if (XInputGetState(0, &st) != ERROR_SUCCESS) { out = Gamepad{}; return false; }
    out.connected = true;
    const XINPUT_GAMEPAD& g = st.Gamepad;
    WORD b = g.wButtons;
    out.btn[0]  = (b & XINPUT_GAMEPAD_A) != 0;
    out.btn[1]  = (b & XINPUT_GAMEPAD_B) != 0;
    out.btn[2]  = (b & XINPUT_GAMEPAD_X) != 0;
    out.btn[3]  = (b & XINPUT_GAMEPAD_Y) != 0;
    out.btn[4]  = (b & XINPUT_GAMEPAD_LEFT_SHOULDER) != 0;
    out.btn[5]  = (b & XINPUT_GAMEPAD_RIGHT_SHOULDER) != 0;
    out.btn[6]  = g.bLeftTrigger  > 40;
    out.btn[7]  = g.bRightTrigger > 40;
    out.btn[8]  = (b & XINPUT_GAMEPAD_START) != 0;
    out.btn[9]  = (b & XINPUT_GAMEPAD_BACK) != 0;
    out.btn[10] = (b & XINPUT_GAMEPAD_LEFT_THUMB) != 0;
    out.btn[11] = (b & XINPUT_GAMEPAD_RIGHT_THUMB) != 0;
    out.btn[12] = (b & XINPUT_GAMEPAD_DPAD_UP) != 0;
    out.btn[13] = (b & XINPUT_GAMEPAD_DPAD_DOWN) != 0;
    out.btn[14] = (b & XINPUT_GAMEPAD_DPAD_LEFT) != 0;
    out.btn[15] = (b & XINPUT_GAMEPAD_DPAD_RIGHT) != 0;
    auto axis = [](SHORT v, SHORT dz) -> float {
        float f = v / 32767.0f;
        float d = dz / 32767.0f;
        if (f > -d && f < d) return 0.0f;
        return f;
    };
    out.lx = axis(g.sThumbLX, XINPUT_GAMEPAD_LEFT_THUMB_DEADZONE);
    out.ly = axis(g.sThumbLY, XINPUT_GAMEPAD_LEFT_THUMB_DEADZONE);
    out.rx = axis(g.sThumbRX, XINPUT_GAMEPAD_RIGHT_THUMB_DEADZONE);
    out.ry = axis(g.sThumbRY, XINPUT_GAMEPAD_RIGHT_THUMB_DEADZONE);
    return true;
}

// UTF-8 (AE1's JSON/title encoding) -> UTF-16 for the Win32 W APIs. A naive
// char->wchar widen would mangle any non-ASCII (e.g. the em dash in titles).
static std::wstring widen(const std::string& s) {
    if (s.empty()) return std::wstring();
    int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
    std::wstring w(n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), &w[0], n);
    return w;
}
static std::string narrow(const std::wstring& w) {
    if (w.empty()) return std::string();
    int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    std::string s(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), &s[0], n, nullptr, nullptr);
    return s;
}

// ---- durable storage (see platform.hpp) ------------------------------------
bool storeEnsureDir(const std::string& dir) {
    std::wstring w = widen(dir);
    if (CreateDirectoryW(w.c_str(), nullptr)) return true;
    return GetLastError() == ERROR_ALREADY_EXISTS;
}

bool storeWriteAtomic(const std::string& path, const std::string& bytes) {
    // temp sibling → write → flush to platter → atomic rename over the target.
    std::wstring wpath = widen(path);
    std::wstring wtmp  = widen(path + ".tmp");
    HANDLE h = CreateFileW(wtmp.c_str(), GENERIC_WRITE, 0, nullptr,
                           CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    const char* p = bytes.data(); size_t left = bytes.size(); bool ok = true;
    while (left) {
        DWORD chunk = (DWORD)(left > 0x40000000u ? 0x40000000u : left), wrote = 0;
        if (!WriteFile(h, p, chunk, &wrote, nullptr) || wrote == 0) { ok = false; break; }
        p += wrote; left -= wrote;
    }
    if (ok) FlushFileBuffers(h);   // durability: bytes are on the disk before the rename
    CloseHandle(h);
    if (!ok) { DeleteFileW(wtmp.c_str()); return false; }
    // Keep the prior copy as .bak (best-effort — a corrupt/lost target still recovers).
    std::wstring wbak = widen(path + ".bak");
    if (GetFileAttributesW(wpath.c_str()) != INVALID_FILE_ATTRIBUTES)
        MoveFileExW(wpath.c_str(), wbak.c_str(), MOVEFILE_REPLACE_EXISTING);
    // The atomic step: NTFS replaces the directory entry in one operation.
    if (!MoveFileExW(wtmp.c_str(), wpath.c_str(),
                     MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        DeleteFileW(wtmp.c_str());
        return false;
    }
    return true;
}

bool storeRead(const std::string& path, std::string& out) {
    HANDLE h = CreateFileW(widen(path).c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    LARGE_INTEGER sz; if (!GetFileSizeEx(h, &sz)) { CloseHandle(h); return false; }
    out.resize((size_t)sz.QuadPart);
    size_t off = 0; bool ok = true;
    while (off < out.size()) {
        DWORD chunk = (DWORD)((out.size()-off) > 0x40000000u ? 0x40000000u : (out.size()-off)), got = 0;
        if (!ReadFile(h, &out[off], chunk, &got, nullptr) || got == 0) { ok = (got==0 && off==out.size()); break; }
        off += got;
    }
    CloseHandle(h);
    return ok || off == out.size();
}

bool storeDelete(const std::string& path) {
    return DeleteFileW(widen(path).c_str()) != 0;
}

std::vector<StoredFile> storeList(const std::string& dir, const std::string& suffix) {
    std::vector<StoredFile> out;
    WIN32_FIND_DATAW fd;
    HANDLE h = FindFirstFileW(widen(dir + "/*").c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE) return out;
    do {
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
        std::string name = narrow(fd.cFileName);
        if (!suffix.empty() && (name.size() < suffix.size() ||
             name.compare(name.size()-suffix.size(), suffix.size(), suffix) != 0)) continue;
        StoredFile f; f.name = name;
        f.size = ((uint64_t)fd.nFileSizeHigh << 32) | fd.nFileSizeLow;
        ULARGE_INTEGER t; t.LowPart = fd.ftLastWriteTime.dwLowDateTime; t.HighPart = fd.ftLastWriteTime.dwHighDateTime;
        // FILETIME is 100 ns ticks since 1601; convert to ms since the Unix epoch.
        f.mtimeMs = (double)((t.QuadPart - 116444736000000000ULL) / 10000ULL);
        out.push_back(std::move(f));
    } while (FindNextFileW(h, &fd));
    FindClose(h);
    std::sort(out.begin(), out.end(), [](const StoredFile& a, const StoredFile& b){ return a.mtimeMs > b.mtimeMs; });
    return out;
}

struct Platform::Impl {
    HWND hwnd = nullptr;
    HINSTANCE hinst = nullptr;

    int width = 0, height = 0;

    // input accumulation between pumps
    bool down[256] = {};
    bool prevDown[256] = {};
    int  mouseX = 0, mouseY = 0, prevMouseX = 0, prevMouseY = 0;
    int  wheelAccum = 0;
    bool mouseDown[3] = {};
    bool sizePending = false;
    bool quit = false;
    bool mouseCaptured = false;   // pointer-lock for mouse-look

    // timing
    LARGE_INTEGER freq{}, start{};
};

// ---- window proc -----------------------------------------------------------

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    Platform::Impl* p =
        (Platform::Impl*)GetWindowLongPtrW(hwnd, GWLP_USERDATA);
    switch (msg) {
        case WM_CLOSE:
            if (p) p->quit = true;
            return 0;
        case WM_DESTROY:
            PostQuitMessage(0);
            return 0;
        case WM_SIZE:
            if (p && wp != SIZE_MINIMIZED) {
                p->sizePending = true;
                p->width  = LOWORD(lp);
                p->height = HIWORD(lp);
            }
            return 0;
        case WM_KEYDOWN: case WM_SYSKEYDOWN:
            if (p && wp < 256) p->down[wp] = true;
            return 0;
        case WM_KEYUP: case WM_SYSKEYUP:
            if (p && wp < 256) p->down[wp] = false;
            return 0;
        case WM_MOUSEMOVE:
            if (p) { p->mouseX = GET_X_LPARAM(lp); p->mouseY = GET_Y_LPARAM(lp); }
            return 0;
        case WM_LBUTTONDOWN: if (p) p->mouseDown[0] = true;  return 0;
        case WM_LBUTTONUP:   if (p) p->mouseDown[0] = false; return 0;
        case WM_RBUTTONDOWN: if (p) p->mouseDown[1] = true;  return 0;
        case WM_RBUTTONUP:   if (p) p->mouseDown[1] = false; return 0;
        case WM_MBUTTONDOWN: if (p) p->mouseDown[2] = true;  return 0;
        case WM_MBUTTONUP:   if (p) p->mouseDown[2] = false; return 0;
        case WM_MOUSEWHEEL:
            if (p) p->wheelAccum += GET_WHEEL_DELTA_WPARAM(wp) / WHEEL_DELTA;
            return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

// ---- Platform --------------------------------------------------------------

Platform::Platform()  : p_(new Impl()) {}
Platform::~Platform() { destroy(); delete p_; p_ = nullptr; }

bool Platform::create(const std::string& title, int width, int height, std::string& err) {
    Impl& d = *p_;
    d.hinst = GetModuleHandleW(nullptr);

    WNDCLASSEXW wc = {};
    wc.cbSize = sizeof wc;
    wc.style = CS_HREDRAW | CS_VREDRAW | CS_OWNDC;
    wc.lpfnWndProc = WndProc;
    wc.hInstance = d.hinst;
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.lpszClassName = L"AE1PlayerWindow";
    if (!RegisterClassExW(&wc)) { err = "RegisterClassEx failed"; return false; }

    RECT r = {0, 0, width, height};
    AdjustWindowRect(&r, WS_OVERLAPPEDWINDOW, FALSE);

    // Fixed spawn position (not CW_USEDEFAULT) so tooling can locate the window
    // deterministically on a headless/service desktop where window enumeration
    // is unavailable. Harmless for normal play; the user can move it.
    std::wstring wtitle = widen(title);
    d.hwnd = CreateWindowExW(0, wc.lpszClassName, wtitle.c_str(),
                             WS_OVERLAPPEDWINDOW,
                             80, 60,
                             r.right - r.left, r.bottom - r.top,
                             nullptr, nullptr, d.hinst, nullptr);
    if (!d.hwnd) { err = "CreateWindow failed"; return false; }
    SetWindowLongPtrW(d.hwnd, GWLP_USERDATA, (LONG_PTR)&d);

    d.width = width; d.height = height;

    QueryPerformanceFrequency(&d.freq);
    QueryPerformanceCounter(&d.start);

    ShowWindow(d.hwnd, SW_SHOW);
    UpdateWindow(d.hwnd);
    SetForegroundWindow(d.hwnd);   // grab keyboard focus even when launched detached
    SetFocus(d.hwnd);
    return true;
}

void Platform::destroy() {
    if (!p_) return;
    Impl& d = *p_;
    if (d.hwnd) { DestroyWindow(d.hwnd); d.hwnd = nullptr; }
}

void* Platform::nativeHandle() const { return (void*)p_->hwnd; }

bool Platform::pump(FrameInput& in) {
    Impl& d = *p_;

    // snapshot previous for edge detection
    for (int i = 0; i < 256; i++) d.prevDown[i] = d.down[i];
    d.prevMouseX = d.mouseX; d.prevMouseY = d.mouseY;
    d.wheelAccum = 0;
    d.sizePending = false;

    MSG msg;
    while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
        if (msg.message == WM_QUIT) d.quit = true;
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    // fill snapshot
    in = FrameInput{};
    for (int i = 0; i < 256; i++) {
        in.down[i]    = d.down[i];
        in.pressed[i] = d.down[i] && !d.prevDown[i];
    }
    in.mouseX = d.mouseX; in.mouseY = d.mouseY;
    in.mouseDX = d.mouseX - d.prevMouseX;
    in.mouseDY = d.mouseY - d.prevMouseY;
    // Pointer-lock: delta is measured from the client centre, then the cursor is
    // recentred so mouse-look never runs into a screen edge.
    if (d.mouseCaptured && d.hwnd) {
        POINT c = { d.width / 2, d.height / 2 };
        POINT cur; GetCursorPos(&cur); ScreenToClient(d.hwnd, &cur);
        in.mouseDX = cur.x - c.x; in.mouseDY = cur.y - c.y;
        POINT ctr = c; ClientToScreen(d.hwnd, &ctr); SetCursorPos(ctr.x, ctr.y);
        d.mouseX = c.x; d.mouseY = c.y;   // keep prev == centre next frame
    }
    in.wheel = d.wheelAccum;
    for (int i = 0; i < 3; i++) in.mouseDown[i] = d.mouseDown[i];
    in.resized = d.sizePending;
    in.quit = d.quit;

    return !d.quit;
}

void Platform::setTitle(const std::string& title) {
    SetWindowTextW(p_->hwnd, widen(title).c_str());
}

int Platform::width()  const { return p_->width; }
int Platform::height() const { return p_->height; }

void Platform::captureMouse(bool on) {
    Impl& d = *p_;
    if (on == d.mouseCaptured) return;
    d.mouseCaptured = on;
    ShowCursor(on ? FALSE : TRUE);
    if (on && d.hwnd) {
        POINT c = { d.width / 2, d.height / 2 };
        ClientToScreen(d.hwnd, &c); SetCursorPos(c.x, c.y);
        d.mouseX = d.width / 2; d.mouseY = d.height / 2;
    }
}

double Platform::now() const {
    LARGE_INTEGER c;
    QueryPerformanceCounter(&c);
    return double(c.QuadPart - p_->start.QuadPart) / double(p_->freq.QuadPart);
}

} // namespace ae1
