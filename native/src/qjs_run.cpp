// qjs_run.cpp — ae1run: tick the engine's element/dispatch model natively.
//
// Usage: ae1run <agp-dir> <engine-dir>
//
// The next step past "scripts compile" (ae1js): actually RUN the engine's
// scheduler. This loads the REAL engine runtime (engine/ags/runtime.js:
// compileAll, rehydrate, buildSchedule, dispatch) and the REAL scene container
// (engine/scene.js) into QuickJS, builds the entry scene from the loaded AGP,
// compiles the game's scripts into classes, rehydrates the scene onto those
// classes, builds the scheduler tables, and dispatches run modes — including
// repeated onTick frames.
//
// runtime.js normally imports ~30 rendering element types (three.js, DOM). Those
// are the renderer's job (the next increment), so here they are replaced by
// synthesized STUB modules — empty classes extending the real AE1Element — while
// the scheduler itself runs authentically. dispatch() wraps each call, so a
// method that reaches for a not-yet-bound renderer simply counts as "needs
// bindings" rather than stopping the tick. What this proves: the engine's own
// element/dispatch model runs, unmodified, on the real game, in native code.
#include "qjs_host.hpp"
#include "agp.hpp"
#include "json.hpp"

#include <cstdio>
#include <string>
#include <vector>

using namespace ae1;

// ---- data handed to JS ------------------------------------------------------
static std::string g_dataJson;     // full data.json text
static std::string g_entryScene;   // entry scene file name

static JSValue js_dataJSON(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    return JS_NewStringLen(ctx, g_dataJson.data(), g_dataJson.size());
}
static JSValue js_entryScene(JSContext* ctx, JSValueConst, int, JSValueConst*) {
    return JS_NewStringLen(ctx, g_entryScene.data(), g_entryScene.size());
}

// ---- parse the `import { A, B } from '...'` lines of a module ---------------
struct ImportLine { std::string path; std::vector<std::string> names; };

static std::vector<ImportLine> parseImports(const std::string& src) {
    std::vector<ImportLine> out;
    size_t i = 0;
    while (i < src.size()) {
        size_t nl = src.find('\n', i);
        if (nl == std::string::npos) nl = src.size();
        std::string line = src.substr(i, nl - i);
        i = nl + 1;

        size_t imp = line.find("import");
        size_t br0 = line.find('{');
        size_t br1 = line.find('}');
        size_t from = line.find("from");
        if (imp == std::string::npos || br0 == std::string::npos ||
            br1 == std::string::npos || from == std::string::npos || br1 < br0)
            continue;

        // path between the quotes after `from`
        size_t q0 = line.find_first_of("'\"", from);
        if (q0 == std::string::npos) continue;
        size_t q1 = line.find_first_of("'\"", q0 + 1);
        if (q1 == std::string::npos) continue;

        ImportLine il;
        il.path = line.substr(q0 + 1, q1 - q0 - 1);

        std::string names = line.substr(br0 + 1, br1 - br0 - 1);
        size_t p = 0;
        while (p < names.size()) {
            size_t c = names.find(',', p);
            if (c == std::string::npos) c = names.size();
            std::string nm = names.substr(p, c - p);
            // trim
            size_t a = nm.find_first_not_of(" \t\r");
            size_t b = nm.find_last_not_of(" \t\r");
            if (a != std::string::npos) {
                nm = nm.substr(a, b - a + 1);
                if (!nm.empty()) il.names.push_back(nm);
            }
            p = c + 1;
        }
        if (!il.names.empty()) out.push_back(std::move(il));
    }
    return out;
}

// The harness module: real engine scheduler, real scene, real scripts.
static const char* kRun = R"JS(
import { AE1Scene } from './scene.js';
import { compileAll, rehydrate, buildSchedule, dispatch } from './ags/runtime.js';

const data = JSON.parse(__dataJSON());
const sceneData = data.scenes[__entryScene()];
const scripts = data.scripts;

const scene = new AE1Scene(sceneData);
console.log('scene "' + (sceneData.name || __entryScene()) + '": ' + scene.size + ' elements');

const { classes, diagnostics } = compileAll(scripts);
const errs = (diagnostics || []).filter(d => d.severity === 'error');
console.log('compileAll: ' + classes.size + ' classes from ' + Object.keys(scripts).length +
            ' scripts' + (errs.length ? '  (' + errs.length + ' errors)' : ''));

const changed = rehydrate(scene, classes);
let scripted = 0;
for (const el of scene.all()) if (el.constructor && el.constructor.agsDef) scripted++;
console.log('rehydrate: ' + (changed ? 'upgraded' : 'no change') +
            ' — ' + scripted + '/' + scene.size + ' elements now on a script class');

const tables = buildSchedule(scene.all());
const nonEmpty = Object.keys(tables).filter(m => tables[m] && tables[m].length);
console.log('buildSchedule: ' +
            (nonEmpty.length ? nonEmpty.map(m => m + '=' + tables[m].length).join('  ') : '(no hooks)'));

// dispatch a mode, counting ran-vs-threw without spewing per-throw errors.
function fire(mode, ...args) {
  const total = (tables[mode] || []).length;
  if (!total) return;
  const realErr = console.error;
  let threw = 0;
  console.error = () => { threw++; };
  const res = dispatch(tables, mode, ...args);
  console.error = realErr;
  console.log('  dispatch ' + mode + ': ' + res.length + '/' + total + ' ran' +
              (threw ? ', ' + threw + ' need bindings' : ''));
}

console.log('');
console.log('--- ticking the model ---');
fire('onLoad');
for (let f = 1; f <= 3; f++) {
  console.log('frame ' + f + ':');
  fire('onTick', 1 / 60);
}

globalThis.__ran = true;
)JS";

int main(int argc, char** argv) {
    if (argc < 3) {
        std::printf("ae1run — tick the engine's element/dispatch model natively\n"
                    "usage: ae1run <agp-dir> <engine-dir>\n");
        return 2;
    }
    std::string agpDir = argv[1];
    std::string engineDir = argv[2];
    for (auto& c : engineDir) if (c == '\\') c = '/';
    while (!engineDir.empty() && engineDir.back() == '/') engineDir.pop_back();

    // ---- load data.json from the package ----
    std::string err;
    if (!readFile(agpDir + "\\data.json", g_dataJson, err)) {
        std::printf("ERROR: %s\n", err.c_str());
        return 1;
    }
    try {
        Json data = Json::parse(g_dataJson);
        g_entryScene = data["entryScene"].str();
        if (g_entryScene.empty()) { std::printf("ERROR: no entryScene in data.json\n"); return 1; }
    } catch (const std::exception& ex) {
        std::printf("ERROR parsing data.json: %s\n", ex.what());
        return 1;
    }

    // ---- stand up the host ----
    QjsHost host;
    if (!host.init(err)) { std::printf("ERROR: %s\n", err.c_str()); return 1; }
    host.addGlobalFunction("__dataJSON",   js_dataJSON, 0);
    host.addGlobalFunction("__entryScene", js_entryScene, 0);

    // ---- stub the rendering element modules runtime.js pulls in ----
    // Keep element.js and compiler.js real; replace the rest with empty classes
    // extending the real AE1Element so the scheduler links and runs.
    std::string runtimeSrc;
    if (!readFile(engineDir + "/ags/runtime.js", runtimeSrc, err)) {
        std::printf("ERROR: %s\n", err.c_str());
        return 1;
    }
    const std::string elementAbs  = engineDir + "/element.js";
    const std::string compilerAbs = engineDir + "/ags/compiler.js";
    int stubbed = 0;
    for (const auto& imp : parseImports(runtimeSrc)) {
        std::string abs = QjsHost::resolvePath(engineDir + "/ags", imp.path);
        if (abs == elementAbs || abs == compilerAbs) continue;  // real
        std::string stub = "import { AE1Element } from '" + elementAbs + "';\n";
        for (const auto& n : imp.names)
            stub += "export class " + n + " extends AE1Element {}\n";
        host.addStubModule(abs, std::move(stub));
        stubbed++;
    }
    std::printf("Hosting the engine scheduler in QuickJS "
                "(%d rendering modules stubbed pending the renderer).\n\n", stubbed);

    // ---- run ----
    std::string bootName = engineDir + "/__ae1_run.js";
    int rc = 0;
    if (!host.runModule(kRun, bootName, err)) {
        std::printf("\nERROR: %s\n", err.c_str());
        rc = 1;
    } else {
        std::printf("\nRESULT: the engine's element/dispatch model ran natively on the real game.\n");
    }

    host.shutdown();
    return rc;
}
