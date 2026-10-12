// json.hpp — a compact recursive-descent JSON reader for the AE1 native runtime.
//
// Scope: AE1's own machine-generated JSON (manifest.json, data.json, the aepack
// TOC). It parses the full JSON grammar (objects, arrays, strings with escapes
// incl. \uXXXX, numbers, true/false/null) into a tagged Value. It is a READER:
// no serialization, no mutation helpers beyond what the runtime needs. Kept
// dependency-free and header-only so every native tool can include it.
//
// Not a general-purpose lib: errors throw std::runtime_error with a byte offset;
// numbers are stored as double (AE1 JSON has no bigints). Good enough — and
// honest about it — for the game package. If we ever need speed here, the TOC
// and manifest are tiny; data.json is ~80KB. Parse-once at boot.
#pragma once
#include <string>
#include <vector>
#include <map>
#include <memory>
#include <stdexcept>
#include <cstdint>
#include <cstdio>

namespace ae1 {

class Json {
public:
    enum class Type { Null, Bool, Number, String, Array, Object };

    Json() : t_(Type::Null) {}

    Type type() const { return t_; }
    bool isNull()   const { return t_ == Type::Null; }
    bool isBool()   const { return t_ == Type::Bool; }
    bool isNumber() const { return t_ == Type::Number; }
    bool isString() const { return t_ == Type::String; }
    bool isArray()  const { return t_ == Type::Array; }
    bool isObject() const { return t_ == Type::Object; }

    bool        asBool()   const { return b_; }
    double      asNumber() const { return n_; }
    long long   asInt()    const { return (long long)n_; }
    const std::string& asString() const { return s_; }

    const std::vector<Json>& arr() const { return arr_; }
    const std::map<std::string, Json>& obj() const { return obj_; }

    size_t size() const {
        if (t_ == Type::Array)  return arr_.size();
        if (t_ == Type::Object) return obj_.size();
        return 0;
    }

    // Object lookup. Returns a static Null Json when absent (never throws) so
    // callers can chain: doc["game"]["title"].asString(). has() distinguishes.
    bool has(const std::string& k) const {
        return t_ == Type::Object && obj_.find(k) != obj_.end();
    }
    const Json& operator[](const std::string& k) const {
        static const Json kNull;
        if (t_ != Type::Object) return kNull;
        auto it = obj_.find(k);
        return it == obj_.end() ? kNull : it->second;
    }
    const Json& operator[](size_t i) const {
        static const Json kNull;
        if (t_ != Type::Array || i >= arr_.size()) return kNull;
        return arr_[i];
    }

    // Convenience with defaults (parsing config-shaped data).
    std::string str(const std::string& def = "") const {
        return t_ == Type::String ? s_ : def;
    }
    double num(double def = 0.0) const {
        return t_ == Type::Number ? n_ : def;
    }
    bool boolean(bool def = false) const {
        return t_ == Type::Bool ? b_ : def;
    }

    static Json parse(const char* data, size_t len) {
        Parser p{data, len, 0};
        p.skipWs();
        Json v = p.parseValue();
        p.skipWs();
        if (p.i != p.n)
            p.fail("trailing content after top-level value");
        return v;
    }
    static Json parse(const std::string& s) { return parse(s.data(), s.size()); }

private:
    Type t_;
    bool b_ = false;
    double n_ = 0.0;
    std::string s_;
    std::vector<Json> arr_;
    std::map<std::string, Json> obj_;

    static Json mkBool(bool v)   { Json j; j.t_ = Type::Bool;   j.b_ = v; return j; }
    static Json mkNum(double v)  { Json j; j.t_ = Type::Number; j.n_ = v; return j; }
    static Json mkStr(std::string v) { Json j; j.t_ = Type::String; j.s_ = std::move(v); return j; }
    static Json mkArr()          { Json j; j.t_ = Type::Array;  return j; }
    static Json mkObj()          { Json j; j.t_ = Type::Object; return j; }

    struct Parser {
        const char* d;
        size_t n;
        size_t i;

        [[noreturn]] void fail(const char* msg) const {
            char buf[128];
            std::snprintf(buf, sizeof buf, "JSON parse error at byte %zu: %s", i, msg);
            throw std::runtime_error(buf);
        }
        char peek() const { return i < n ? d[i] : '\0'; }
        char get()  { return i < n ? d[i++] : '\0'; }
        void skipWs() {
            while (i < n) {
                char c = d[i];
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') i++;
                else break;
            }
        }
        void expect(char c) {
            if (get() != c) { i--; fail("unexpected character"); }
        }

        Json parseValue() {
            skipWs();
            char c = peek();
            switch (c) {
                case '{': return parseObject();
                case '[': return parseArray();
                case '"': return mkStr(parseString());
                case 't': case 'f': return parseBool();
                case 'n': return parseNull();
                default:
                    if (c == '-' || (c >= '0' && c <= '9')) return parseNumber();
                    fail("unexpected token");
            }
        }

        Json parseObject() {
            expect('{');
            Json o = mkObj();
            skipWs();
            if (peek() == '}') { i++; return o; }
            for (;;) {
                skipWs();
                if (peek() != '"') fail("expected object key string");
                std::string key = parseString();
                skipWs();
                expect(':');
                o.obj_.emplace(std::move(key), parseValue());
                skipWs();
                char c = get();
                if (c == ',') continue;
                if (c == '}') break;
                i--; fail("expected ',' or '}' in object");
            }
            return o;
        }

        Json parseArray() {
            expect('[');
            Json a = mkArr();
            skipWs();
            if (peek() == ']') { i++; return a; }
            for (;;) {
                a.arr_.push_back(parseValue());
                skipWs();
                char c = get();
                if (c == ',') continue;
                if (c == ']') break;
                i--; fail("expected ',' or ']' in array");
            }
            return a;
        }

        Json parseBool() {
            if (i + 4 <= n && std::string(d + i, 4) == "true")  { i += 4; return mkBool(true); }
            if (i + 5 <= n && std::string(d + i, 5) == "false") { i += 5; return mkBool(false); }
            fail("invalid literal");
        }
        Json parseNull() {
            if (i + 4 <= n && std::string(d + i, 4) == "null") { i += 4; return Json(); }
            fail("invalid literal");
        }

        Json parseNumber() {
            size_t start = i;
            if (peek() == '-') i++;
            while (i < n) {
                char c = d[i];
                if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' ||
                    c == '+' || c == '-') i++;
                else break;
            }
            std::string num(d + start, i - start);
            try { return mkNum(std::stod(num)); }
            catch (...) { i = start; fail("invalid number"); }
        }

        std::string parseString() {
            expect('"');
            std::string out;
            for (;;) {
                if (i >= n) fail("unterminated string");
                char c = d[i++];
                if (c == '"') break;
                if (c == '\\') {
                    if (i >= n) fail("unterminated escape");
                    char e = d[i++];
                    switch (e) {
                        case '"':  out += '"';  break;
                        case '\\': out += '\\'; break;
                        case '/':  out += '/';  break;
                        case 'b':  out += '\b'; break;
                        case 'f':  out += '\f'; break;
                        case 'n':  out += '\n'; break;
                        case 'r':  out += '\r'; break;
                        case 't':  out += '\t'; break;
                        case 'u':  appendUnicode(out); break;
                        default:   i--; fail("invalid string escape");
                    }
                } else {
                    out += c;
                }
            }
            return out;
        }

        unsigned hex4() {
            if (i + 4 > n) fail("truncated \\u escape");
            unsigned v = 0;
            for (int k = 0; k < 4; k++) {
                char c = d[i++];
                v <<= 4;
                if (c >= '0' && c <= '9') v |= (c - '0');
                else if (c >= 'a' && c <= 'f') v |= (c - 'a' + 10);
                else if (c >= 'A' && c <= 'F') v |= (c - 'A' + 10);
                else { i--; fail("invalid hex in \\u escape"); }
            }
            return v;
        }
        void appendUtf8(unsigned cp, std::string& out) {
            if (cp <= 0x7F) out += (char)cp;
            else if (cp <= 0x7FF) {
                out += (char)(0xC0 | (cp >> 6));
                out += (char)(0x80 | (cp & 0x3F));
            } else if (cp <= 0xFFFF) {
                out += (char)(0xE0 | (cp >> 12));
                out += (char)(0x80 | ((cp >> 6) & 0x3F));
                out += (char)(0x80 | (cp & 0x3F));
            } else {
                out += (char)(0xF0 | (cp >> 18));
                out += (char)(0x80 | ((cp >> 12) & 0x3F));
                out += (char)(0x80 | ((cp >> 6) & 0x3F));
                out += (char)(0x80 | (cp & 0x3F));
            }
        }
        void appendUnicode(std::string& out) {
            unsigned cp = hex4();
            // UTF-16 surrogate pair.
            if (cp >= 0xD800 && cp <= 0xDBFF) {
                if (i + 2 <= n && d[i] == '\\' && d[i + 1] == 'u') {
                    i += 2;
                    unsigned lo = hex4();
                    if (lo >= 0xDC00 && lo <= 0xDFFF)
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    else fail("invalid low surrogate");
                } else fail("expected low surrogate");
            }
            appendUtf8(cp, out);
        }
    };
};

} // namespace ae1
