// qjs_main.cpp — ae1js: prove the engine's JavaScript runs natively.
//
// Usage: ae1js <agp-dir> <engine-dir>
//
// This is the heart of docs/engine/20's Phase A: "game scripts run unmodified —
// AngelScript bodies are JavaScript; the native player embeds a small JS engine
// (QuickJS) and runs the SAME model." Here we take the strongest honest first
// step: embed QuickJS, install a module loader that resolves the engine's own
// ES-module imports from disk, load the REAL engine AGS compiler
// (engine/ags/compiler.js -> reader.js) into it, and run it on the REAL game
// scripts pulled from the loaded AGP. If quickjs compiles every .ags.txt the
// browser does, the "same game, unmodified code" thesis holds in native.
//
// It does NOT yet execute script bodies against engine bindings (env3d/world) —
// that is the next increment. Compiling every script with the actual engine
// compiler is the milestone this binary owns.
extern "C" {
#include "quickjs.h"
}
#include "agp.hpp"
#include "json.hpp"

#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <string>
#include <map>
#include <vector>

using namespace ae1;

// ---- data shared with the JS bindings --------------------------------------
static std::map<std::string, std::string> g_scripts;   // name -> .ags.txt source

// ---- native functions exposed to JS ----------------------------------------

static JSValue js_print(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    for (int i = 0; i < argc; i++) {
        const char* s = JS_ToCString(ctx, argv[i]);
        if (s) { std::fputs(s, stdout); JS_FreeCString(ctx, s); }
        if (i + 1 < argc) std::fputc(' ', stdout);
    }
    std::fputc('\n', stdout);
    return JS_UNDEFINED;
}

static JSValue js_scriptNames(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    JSValue arr = JS_NewArray(ctx);
    uint32_t i = 0;
    for (auto& kv : g_scripts)
        JS_SetPropertyUint32(ctx, arr, i++, JS_NewString(ctx, kv.first.c_str()));
    return arr;
}

static JSValue js_scriptSource(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
    if (argc < 1) return JS_NULL;
    const char* n = JS_ToCString(ctx, argv[0]);
    if (!n) return JS_NULL;
    auto it = g_scripts.find(n);
    JSValue r = (it == g_scripts.end())
        ? JS_NULL
        : JS_NewStringLen(ctx, it->second.data(), it->second.size());
    JS_FreeCString(ctx, n);
    return r;
}

// ---- ES-module loader (resolves the engine's relative imports from disk) ----

static std::string dirOf(const std::string& p) {
    size_t s = p.find_last_of('/');
    return s == std::string::npos ? std::string() : p.substr(0, s);
}

// Resolve `name` (possibly "./x", "../x") against base directory `baseDir`,
// collapsing "." and ".." — the small slice of Node-ish resolution the engine
// modules need. Paths use forward slashes throughout.
static std::string resolvePath(const std::string& baseDir, const std::string& name) {
    std::string combined = (name[0] == '.') ? (baseDir + "/" + name) : name;
    std::vector<std::string> parts;
    size_t i = 0;
    while (i < combined.size()) {
        size_t j = combined.find('/', i);
        if (j == std::string::npos) j = combined.size();
        std::string seg = combined.substr(i, j - i);
        if (seg == "..") { if (!parts.empty()) parts.pop_back(); }
        else if (seg != "." && !seg.empty()) parts.push_back(seg);
        else if (parts.empty() && seg.empty() && i == 0) parts.push_back(""); // keep leading (unused on win)
        i = j + 1;
    }
    std::string out;
    for (size_t k = 0; k < parts.size(); k++) {
        if (k) out += '/';
        out += parts[k];
    }
    // Preserve a Windows drive prefix like "A:" (never gets a leading slash).
    return out;
}

static char* mod_normalize(JSContext* ctx, const char* base, const char* name, void*) {
    std::string res = (name[0] == '.') ? resolvePath(dirOf(base), name) : std::string(name);
    char* out = (char*)js_malloc(ctx, res.size() + 1);
    std::memcpy(out, res.c_str(), res.size() + 1);
    return out;
}

static JSModuleDef* mod_loader(JSContext* ctx, const char* name, void*) {
    std::string src, err;
    if (!readFile(name, src, err)) {
        JS_ThrowReferenceError(ctx, "cannot load module '%s'", name);
        return nullptr;
    }
    JSValue v = JS_Eval(ctx, src.c_str(), src.size(), name,
                        JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    if (JS_IsException(v)) return nullptr;
    JSModuleDef* m = (JSModuleDef*)JS_VALUE_GET_PTR(v);
    JS_FreeValue(ctx, v);
    return m;
}

// ---- helpers ----------------------------------------------------------------

static void dumpException(JSContext* ctx) {
    JSValue exc = JS_GetException(ctx);
    const char* s = JS_ToCString(ctx, exc);
    std::printf("  [JS exception] %s\n", s ? s : "(unknown)");
    if (s) JS_FreeCString(ctx, s);
    JSValue stack = JS_GetPropertyStr(ctx, exc, "stack");
    if (!JS_IsUndefined(stack)) {
        const char* st = JS_ToCString(ctx, stack);
        if (st) { std::printf("%s\n", st); JS_FreeCString(ctx, st); }
    }
    JS_FreeValue(ctx, stack);
    JS_FreeValue(ctx, exc);
}

// Run a module source to completion (drains the job queue that module
// evaluation and any promises schedule). Returns false on error.
static bool runModule(JSContext* ctx, JSRuntime* rt, const std::string& src,
                      const std::string& name) {
    JSValue v = JS_Eval(ctx, src.c_str(), src.size(), name.c_str(), JS_EVAL_TYPE_MODULE);
    if (JS_IsException(v)) { dumpException(ctx); JS_FreeValue(ctx, v); return false; }
    JS_FreeValue(ctx, v);
    // pump pending jobs
    for (;;) {
        JSContext* c1 = nullptr;
        int r = JS_ExecutePendingJob(rt, &c1);
        if (r < 0) { dumpException(c1 ? c1 : ctx); return false; }
        if (r == 0) break;
    }
    return true;
}

// The bootstrap module: imports the REAL engine compiler and runs it on every
// game script. Written as a string so this binary needs no extra JS on disk;
// its one import ('./ags/compiler.js') is resolved against the engine dir.
static const char* kBootstrap = R"JS(
import { compileAGS } from './ags/compiler.js';

const names = __scriptNames();
let ok = 0, failed = 0, withWarns = 0;
const failures = [];

for (const n of names) {
  const src = __scriptSource(n);
  try {
    const r = compileAGS(src, { file: n });
    const errs  = (r.diagnostics || []).filter(d => d.severity === 'error');
    const warns = (r.diagnostics || []).filter(d => d.severity === 'warning');
    if (r.ok && errs.length === 0) {
      ok++;
      if (warns.length) withWarns++;
    } else {
      failed++;
      failures.push(n + ' : ' + (errs[0] ? errs[0].message : 'compileAGS ok=false'));
    }
  } catch (e) {
    failed++;
    failures.push(n + ' : THREW ' + (e && e.message ? e.message : e));
  }
}

__print('compiled ' + ok + '/' + names.length + ' scripts with the engine AGS compiler'
        + (withWarns ? '  (' + withWarns + ' with warnings)' : ''));
if (failed) {
  __print(failed + ' FAILED:');
  for (const f of failures) __print('   - ' + f);
}

// Detail on one script, and prove the emitted factory actually builds a class.
const demo = names.indexOf('camera.ags.txt') >= 0 ? 'camera.ags.txt' : names[0];
const d = compileAGS(__scriptSource(demo), { file: demo });
__print('');
__print('detail [' + demo + ']:');
__print('   name    = ' + (d.def && d.def.name));
__print('   extends = ' + (d.def && d.def.extends));
__print('   methods = [' + (d.methodNames || []).join(', ') + ']');
if (typeof d.factory === 'function') {
  const Cls = d.factory(class Base {});   // new Function(...) — real code emission
  __print('   factory -> ' + (typeof Cls === 'function' ? 'built a class OK' : 'unexpected ' + typeof Cls));
}
globalThis.__ae1_failed = failed;
)JS";

int main(int argc, char** argv) {
    if (argc < 3) {
        std::printf("ae1js — run the engine's JavaScript natively (QuickJS)\n"
                    "usage: ae1js <agp-dir> <engine-dir>\n");
        return 2;
    }
    std::string agpDir = argv[1];
    std::string engineDir = argv[2];
    for (auto& c : engineDir) if (c == '\\') c = '/';
    while (!engineDir.empty() && engineDir.back() == '/') engineDir.pop_back();

    // ---- load the game's scripts from the AGP (native side) ----
    std::string err;
    std::string dataTxt;
    if (!readFile(agpDir + "\\data.json", dataTxt, err)) {
        std::printf("ERROR: %s\n", err.c_str());
        return 1;
    }
    try {
        Json data = Json::parse(dataTxt);
        const Json& scripts = data["scripts"];
        if (scripts.isObject())
            for (const auto& kv : scripts.obj())
                if (kv.second.isString()) g_scripts[kv.first] = kv.second.asString();
    } catch (const std::exception& ex) {
        std::printf("ERROR parsing data.json: %s\n", ex.what());
        return 1;
    }
    std::printf("Loaded %zu scripts from the package. Handing them to QuickJS...\n\n",
                g_scripts.size());

    // ---- stand up QuickJS ----
    JSRuntime* rt = JS_NewRuntime();
    if (!rt) { std::printf("ERROR: JS_NewRuntime failed\n"); return 1; }
    JS_SetModuleLoaderFunc(rt, mod_normalize, mod_loader, nullptr);
    JSContext* ctx = JS_NewContext(rt);
    if (!ctx) { std::printf("ERROR: JS_NewContext failed\n"); JS_FreeRuntime(rt); return 1; }

    // install native functions on the global object
    JSValue g = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, g, "__print",         JS_NewCFunction(ctx, js_print, "__print", 1));
    JS_SetPropertyStr(ctx, g, "__scriptNames",   JS_NewCFunction(ctx, js_scriptNames, "__scriptNames", 0));
    JS_SetPropertyStr(ctx, g, "__scriptSource",  JS_NewCFunction(ctx, js_scriptSource, "__scriptSource", 1));
    JS_FreeValue(ctx, g);

    // sanity: prove the JS engine itself is live and correct
    {
        static const char* kSanity =
            "globalThis.__sanity = (()=>{const a=[1,2,3].map(x=>x*x).reduce((p,c)=>p+c,0);"
            "const o=JSON.parse('{\"k\":41}'); return a + o.k + 1;})();";
        JSValue r = JS_Eval(ctx, kSanity, std::strlen(kSanity), "<sanity>", 0);
        if (JS_IsException(r)) { dumpException(ctx); }
        JS_FreeValue(ctx, r);
        JSValue gg = JS_GetGlobalObject(ctx);
        JSValue s = JS_GetPropertyStr(ctx, gg, "__sanity");
        int32_t v = -1; JS_ToInt32(ctx, &v, s);
        std::printf("JS engine sanity: (1+4+9) + 41 + 1 = %d  (expect 56)\n\n", v);
        JS_FreeValue(ctx, s); JS_FreeValue(ctx, gg);
    }

    // ---- run the real engine compiler on the real scripts ----
    // Give the bootstrap an absolute base name so its './ags/compiler.js'
    // import resolves against the engine dir.
    std::string bootName = engineDir + "/__ae1_boot.js";
    int rc = 0;
    if (!runModule(ctx, rt, kBootstrap, bootName)) {
        std::printf("\nERROR: bootstrap module failed.\n");
        rc = 1;
    } else {
        JSValue gg = JS_GetGlobalObject(ctx);
        JSValue f = JS_GetPropertyStr(ctx, gg, "__ae1_failed");
        int32_t failed = 0; JS_ToInt32(ctx, &failed, f);
        JS_FreeValue(ctx, f); JS_FreeValue(ctx, gg);
        std::printf("\n%s\n", failed == 0
            ? "RESULT: QuickJS compiled every game script with the engine's own compiler."
            : "RESULT: some scripts failed to compile (see above).");
        rc = failed == 0 ? 0 : 1;
    }

    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    return rc;
}
