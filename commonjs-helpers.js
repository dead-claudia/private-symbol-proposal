"use strict"

// For importers:
// - `source` = imported source
// - `TE` = original global `%TypeError%`
// - `RE` = original global `%ReferenceError%`
// - This should be called at the top of the scope, to persist the references.
// - Returns an object `{get, set, init}`, where:
//   - `.get(O, key)` - Get a private `key`
//   - `.set(O, key, value)` - Set a private `key` to `value`
//   - `.init(mod, filename, keys)` - Initialize the private references, where:
//      - `mod` = the imported module
//      - `filename` = caller filename (can be compressed via build system)
//      - `keys` = a static array of keys
function getExportedKeys(source, TE, RE) {
    var result = String(source)

    return {
        init: function (mod, filename, keys) {
            if (mod == null || typeof mod !== "object") throw new TE("`mod` is not a module instance!")
            var exports = mod.exports
            if (exports == null || typeof exports !== "object") throw new TE("`mod` is not a module instance!")
            var exportedKeys = exports.__exportedKeys

            if (typeof exportedKeys === "function") {
                result = exportedKeys(filename, TE, keys)
            }

            if (typeof result === "string") throw new RE("Private key #" + keys[0] + " could not be referenced from '" + result + "'!")
        },

        get: function (O, key) {
            if (typeof result === "string") throw new RE("Private key #" + key + " could not be referenced from '" + result + "'!")
            return result.get(O, key)
        },

        set: function (O, key, value) {
            if (typeof result === "string") throw new RE("Private key #" + key + " could not be referenced from '" + result + "'!")
            return result.set(O, key, value)
        },
    }
}

// For exporters:
// - `internalRefs` is a key/value object where the keys are the private field
//   names, and the values are the object/value weak maps holding the fields'
//   values.
// - `req` is a reference to `require` (the global)
// - `all` is a list of private keys exposed to all modules
// - `scoped` is a key/value object, where the keys are the modules and the
//   values are the keys exposed to that module specifically. They are resolved
//   the same way as with `require`. `export { ... } to "./foo.js"` compiles
//   to this.
function makeExportedKeys(internalRefs, req, all, scoped) {
    // Save a bunch of references so we know they won't change when we go to
    // expose this to the hostile world. It's important to note this may be used
    // cross-realm and exposed to modules that aren't necessarily okay to trust
    // with everything.
    var weakHas = Function.call.bind(WeakMap.prototype.has)
    var weakGet = Function.call.bind(WeakMap.prototype.get)
    var weakSet = Function.call.bind(WeakMap.prototype.set)
    var mapGet = Function.call.bind(Map.prototype.get)
    var setHas = Function.call.bind(Set.prototype.has)
    var setAdd = Function.call.bind(Set.prototype.add)
    var toString = String, S = Set, E = Error

    var fallback = new Set(all)
    // Targets of `export { ... } to "./foo"`
    var resolved = new Map()
    var exported = new Map()

    // Warn and abort early against broken transpilers. I make a lot of internal
    // consistency assumptions that can't be exposed externally.
    function addExported(key) {
        if (!exported.has(key)) {
            var value = internalRefs[key]
            if (!(value instanceof WeakMap)) {
                throw new Error("Missing private key: #" + key)
            }
            exported.set(key, value)
        }
    }

    all.forEach(addExported)
    Object.keys(scoped).forEach(function (key) {
        var value = new Set(fallback)
        scoped[key].forEach(addExported)
        scoped[key].forEach(value.add, value)
        resolved.set(req.resolve(key), value)
    })

    return function (filename, TE, keys) {
        var allowed = mapGet(resolved, filename) || fallback
        var refs = new S()

        for (var i = 0; i < keys.length; i++) {
            var key = toString(keys[i])
            if (!setHas(allowed, key)) return key
            setAdd(refs, key)
        }

        function transact(O, key) {
            // Protect against accidental or malicious entry.
            if (!setHas(refs, key)) throw new E("Invalid private key: #" + key)

            var store = mapGet(exported, key)

            if (O == null || typeof O !== "object" && typeof O !== "function") {
                throw new TE("Private key #" + key + " cannot be referenced from non-object " + toString(O) + "!")
            }

            if (!weakHas(store, O)) {
                throw new TE("Private key #" + key + " does not exist on " + toString(O) + "!")
            }

            return store
        }

        return {
            get: function (O, K) { return weakGet(transact(O, K), O) },
            set: function (O, K, V) { weakSet(transact(O, K), O, V); return V }
        }
    }
}
