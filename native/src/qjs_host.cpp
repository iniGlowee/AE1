// qjs_host.cpp — implementation of the reusable QuickJS host (see qjs_host.hpp).
#include "qjs_host.hpp"
#include "agp.hpp"   // readFile

#include <cstdio>
#include <cstring>
#include <vector>

namespace ae1 {

// ---- path helpers ----------------------------------------------------------

std::string QjsHost::dirOf(const std::string& p) {
    size_t s = p.find_last_of('/');
    return s == std::string::npos ? std::string() : p.substr(0, s);
}

std::string QjsHost::resolvePath(const std::string& baseDir, const std::string& name) {
    std::string combined = (name[0] == '.') ? (baseDir + "/" + name) : name;
    std::vector<std::string> parts;
    size_t i = 0;
    while (i < combined.size()) {
        size_t j = combined.find('/', i);
        if (j == std::string::npos) j = combined.size();
        std::string seg = combined.substr(i, j - i);
        if (seg == "..") { if (!parts.empty()) parts.pop_back(); }
        else if (seg != "." && !seg.empty()) parts.push_back(seg);
        i = j + 1;
    }
    std::string out;
    for (size_t k = 0; k < parts.size(); k++) { if (k) out += '/'; out += parts[k]; }
    return out;
}

const std::string* QjsHost::stubFor(const std::string& path) const {
    auto it = stubs_.find(path);
    return it == stubs_.end() ? nullptr : &it->second;
}

// ---- module loader callbacks (dispatch to the host via opaque) --------------

static char* host_normalize(JSContext* ctx, const char* base, const char* name, void*) {
    std::string res = (name[0] == '.')
        ? QjsHost::resolvePath(QjsHost::dirOf(base), name)
        : std::string(name);
    char* out = (char*)js_malloc(ctx, res.size() + 1);
    std::memcpy(out, res.c_str(), res.size() + 1);
    return out;
}

static JSModuleDef* host_loader(JSContext* ctx, const char* name, void* opaque) {
    QjsHost* host = (QjsHost*)opaque;
    std::string src;
    const std::string* stub = host->stubFor(name);
    if (stub) {
        src = *stub;
    } else {
        std::string err;
        if (!readFile(name, src, err)) {
            JS_ThrowReferenceError(ctx, "cannot load module '%s'", name);
            return nullptr;
        }
    }
    JSValue v = JS_Eval(ctx, src.c_str(), src.size(), name,
                        JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    if (JS_IsException(v)) return nullptr;
    JSModuleDef* m = (JSModuleDef*)JS_VALUE_GET_PTR(v);
    JS_FreeValue(ctx, v);
    return m;
}

// ---- console ---------------------------------------------------------------

static JSValue console_write(JSContext* ctx, int argc, JSValueConst* argv, FILE* out) {
    for (int i = 0; i < argc; i++) {
        const char* s = JS_ToCString(ctx, argv[i]);
        if (s) { std::fputs(s, out); JS_FreeCString(ctx, s); }
        if (i + 1 < argc) std::fputc(' ', out);
    }
    std::fputc('\n', out);
    return JS_UNDEFINED;
}
static JSValue console_log (JSContext* c, JSValueConst, int n, JSValueConst* a) { return console_write(c, n, a, stdout); }
static JSValue console_err (JSContext* c, JSValueConst, int n, JSValueConst* a) { return console_write(c, n, a, stderr); }

void QjsHost::installConsole() {
    JSValue g = JS_GetGlobalObject(ctx_);
    JSValue console = JS_NewObject(ctx_);
    JS_SetPropertyStr(ctx_, console, "log",   JS_NewCFunction(ctx_, console_log, "log", 1));
    JS_SetPropertyStr(ctx_, console, "info",  JS_NewCFunction(ctx_, console_log, "info", 1));
    JS_SetPropertyStr(ctx_, console, "debug", JS_NewCFunction(ctx_, console_log, "debug", 1));
    JS_SetPropertyStr(ctx_, console, "warn",  JS_NewCFunction(ctx_, console_err, "warn", 1));
    JS_SetPropertyStr(ctx_, console, "error", JS_NewCFunction(ctx_, console_err, "error", 1));
    JS_SetPropertyStr(ctx_, g, "console", console);
    JS_FreeValue(ctx_, g);
}

// ---- lifecycle -------------------------------------------------------------

bool QjsHost::init(std::string& err) {
    rt_ = JS_NewRuntime();
    if (!rt_) { err = "JS_NewRuntime failed"; return false; }
    JS_SetModuleLoaderFunc(rt_, host_normalize, host_loader, this);
    ctx_ = JS_NewContext(rt_);
    if (!ctx_) { err = "JS_NewContext failed"; JS_FreeRuntime(rt_); rt_ = nullptr; return false; }
    installConsole();
    installPlatformGlobals();
    return true;
}

// Browser/Node globals the engine expects that base QuickJS doesn't provide.
// These are the platform seam in miniature — a real runtime would back them
// properly; for hosting engine logic the lightweight forms suffice.
void QjsHost::installPlatformGlobals() {
    std::string e;
    // structuredClone: element props are plain JSON data, so a round-trip clones them.
    evalScript("globalThis.structuredClone ||= (v) => v == null ? v : JSON.parse(JSON.stringify(v));",
               "<platform>", e);
    // Minimal window / performance so engine modules that reference them at load
    // don't throw. Real behavior comes through the loop's dt and the platform seams.
    evalScript("globalThis.window = globalThis.window || globalThis;"
               "globalThis.performance = globalThis.performance || { now: () => 0 };"
               "globalThis.URLSearchParams = globalThis.URLSearchParams || "
               "class { constructor(){} get(){return null;} has(){return false;} getAll(){return [];} };"
               "globalThis.location = globalThis.location || { search:'', href:'', hash:'' };",
               "<platform>", e);
}

void QjsHost::shutdown() {
    if (ctx_) { JS_FreeContext(ctx_); ctx_ = nullptr; }
    if (rt_)  { JS_FreeRuntime(rt_);  rt_ = nullptr; }
}

void QjsHost::addGlobalFunction(const char* name, JSCFunction* fn, int argc) {
    JSValue g = JS_GetGlobalObject(ctx_);
    JS_SetPropertyStr(ctx_, g, name, JS_NewCFunction(ctx_, fn, name, argc));
    JS_FreeValue(ctx_, g);
}

void QjsHost::addStubModule(const std::string& absPath, std::string source) {
    stubs_[absPath] = std::move(source);
}

void QjsHost::dumpException(JSContext* c) {
    JSValue exc = JS_GetException(c);
    const char* s = JS_ToCString(c, exc);
    std::printf("  [JS exception] %s\n", s ? s : "(unknown)");
    if (s) JS_FreeCString(c, s);
    JSValue stack = JS_GetPropertyStr(c, exc, "stack");
    if (!JS_IsUndefined(stack)) {
        const char* st = JS_ToCString(c, stack);
        if (st) { std::printf("%s\n", st); JS_FreeCString(c, st); }
    }
    JS_FreeValue(c, stack);
    JS_FreeValue(c, exc);
}

bool QjsHost::runModule(const std::string& source, const std::string& name, std::string& err) {
    JSValue v = JS_Eval(ctx_, source.c_str(), source.size(), name.c_str(), JS_EVAL_TYPE_MODULE);
    if (JS_IsException(v)) { dumpException(ctx_); JS_FreeValue(ctx_, v); err = "module eval threw"; return false; }
    // Drain the job queue (module evaluation and any promises schedule here).
    for (;;) {
        JSContext* c1 = nullptr;
        int r = JS_ExecutePendingJob(rt_, &c1);
        if (r < 0) { dumpException(c1 ? c1 : ctx_); JS_FreeValue(ctx_, v); err = "pending job threw"; return false; }
        if (r == 0) break;
    }
    // A module that throws at top level does NOT surface as an exception here —
    // JS_Eval(MODULE) returns a PROMISE that ends up rejected. Check it, or a
    // top-level throw is silently masked as success.
    bool ok = true;
    if (JS_IsObject(v) && JS_PromiseState(ctx_, v) == JS_PROMISE_REJECTED) {
        JSValue reason = JS_PromiseResult(ctx_, v);
        JS_Throw(ctx_, reason);          // takes ownership; sets the exception
        dumpException(ctx_);
        err = "module rejected at top level";
        ok = false;
    }
    JS_FreeValue(ctx_, v);
    return ok;
}

bool QjsHost::evalScript(const std::string& source, const std::string& name, std::string& err) {
    JSValue v = JS_Eval(ctx_, source.c_str(), source.size(), name.c_str(), 0);
    bool ok = !JS_IsException(v);
    if (!ok) { dumpException(ctx_); err = "script eval threw"; }
    JS_FreeValue(ctx_, v);
    return ok;
}

} // namespace ae1
