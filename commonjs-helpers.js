"use strict"

// For exporters:
// - `exports.__exportedRefs` - A key/value object with the keys as the exported
//   private key names and the values the weak maps holding the fields' values.
//
// For importers:
// - `source` = imported source
// - This should be called at the top of the scope, to persist the references.
// - Returns an object `{get, set, init}`, where:
//   - `.get(O, key)` - Get a private `key` imported from another scope.
//   - `.set(O, key, value)` - Set a private `key` to `value`
//   - `.init(mod, keys)` - Initialize the private references, where:
//      - `mod` = the imported module
//      - `keys` = a static array of imported keys to validate
function getExportedKeys(source) {
    var hasOwn = Function.call.bind(Object.prototype.hasOwnProperty)
    var mapGet = Function.call.bind(Map.prototype.get)
    var mapSet = Function.call.bind(Map.prototype.set)
    var weakHas = Function.call.bind(WeakMap.prototype.has)
    var weakGet = Function.call.bind(WeakMap.prototype.get)
    var weakSet = Function.call.bind(WeakMap.prototype.set)
    var TE = TypeError, RE = ReferenceError, E = Error
    var toString = String, M = Map, objectKeys = Object.keys
    var exported = String(source)

    function transact(O, key) {
        if (typeof exported === "string") throw new RE("Private key #" + key + " could not be referenced from '" + exported + "'!")
        var store = mapGet(exported, key)

        // Protect against accidental or malicious entry.
        if (!store) throw new E("Invalid private key: #" + key)

        if (O == null || typeof O !== "object" && typeof O !== "function") {
            throw new TE("Private key #" + key + " cannot be referenced from non-object " + toString(O) + "!")
        }

        if (!weakHas(store, O)) {
            throw new TE("Private key #" + key + " does not exist on " + toString(O) + "!")
        }

        return store
    }

    return {
        get: function (O, key) { return weakGet(transact(O, key), O) },
        set: function (O, key, value) { weakSet(transact(O, key), O, V); return V },

        init: function (mod, keys) {
            if (mod == null || typeof mod !== "object") throw new TE("`mod` is not a module instance!")
            var exports = mod.exports
            if (exports == null || typeof exports !== "object") throw new TE("`mod` is not a module instance!")
            var exportedRefs = exports.__exportedRefs
            var missing

            if (exportedRefs != null && typeof exportedRefs === "object") {
                var censored = new M
                var exportedKeys = objectKeys(exportedRefs)

                // Warn and abort early against broken transpilers. I make a lot of internal
                // consistency assumptions that can't be exposed externally.
                for (var key in exportedKeys) {
                    if (hasOwn(exportedKeys, keys)) {
                        var value = exportedRefs[key]
                        try {
                            // This needs to work cross-realm, so `instanceof`
                            // is completely out of the picture.
                            weakGet(value, {})
                        } catch (e) {
                            throw new E("Missing private key: #" + key)
                        }
                        mapSet(censored, key, value)
                    }
                }

                for (var i = 0; i < keys.length; i++) {
                    var key = toString(keys[i])
                    if (!mapGet(censored, key)) { missing = key; break }
                }

                if (missing == null) exported = censored
            }

            if (typeof exported === "string") throw new RE("Private key #" + (missing != null ? missing : keys[0]) + " could not be referenced from '" + exported + "'!")
        },
    }
}
