// qjs_host.hpp — a small reusable QuickJS host for the AE1 native runtime.
//
// Wraps the runtime/context lifecycle, a `console`, native-function
// registration, and an ES-module loader that resolves the engine's relative
// imports from disk — with an optional STUB table so a module (e.g. a rendering
// element type that pulls in three.js) can be replaced by a synthesized stand-in
// while its dependents run for real. This is the glue every native tool that
// hosts engine JS shares, and the seed of the eventual runtime's script host.
#pragma once
extern "C" {
#include "quickjs.h"
}
#include <string>
#include <map>

namespace ae1 {

class QjsHost {
public:
    bool init(std::string& err);
    void shutdown();

    JSContext* ctx() const { return ctx_; }
    JSRuntime* rt()  const { return rt_; }

    // Register a native C function on the global object.
    void addGlobalFunction(const char* name, JSCFunction* fn, int argc);

    // Register a stub module: when `absPath` is imported, `source` is evaluated
    // instead of the file on disk. `absPath` must be the normalized (absolute,
    // forward-slash) path the importer resolves to.
    void addStubModule(const std::string& absPath, std::string source);

    // Evaluate module source to completion, draining the job queue. `name`
    // should be an absolute-ish path so its relative imports resolve. Returns
    // false and fills `err` on a JS error (also prints the exception).
    bool runModule(const std::string& source, const std::string& name, std::string& err);

    // Evaluate a classic (non-module) script. Returns false + err on error.
    bool evalScript(const std::string& source, const std::string& name, std::string& err);

    // Resolve a relative path the way the module loader does (exposed so callers
    // can compute stub keys that match the importer's resolution exactly).
    static std::string resolvePath(const std::string& baseDir, const std::string& name);
    static std::string dirOf(const std::string& p);

    // Internal, but must be reachable from the static loader callbacks.
    const std::string* stubFor(const std::string& path) const;

private:
    JSRuntime* rt_ = nullptr;
    JSContext* ctx_ = nullptr;
    std::map<std::string, std::string> stubs_;

    void installConsole();
    void installPlatformGlobals();
    void dumpException(JSContext* c);
};

} // namespace ae1
