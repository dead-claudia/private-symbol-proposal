// There are two caveats with this polyfill:
//
// 1. This technically leaks every private symbol created. I can't avoid it much
//    at all, because I can't use symbols as weak map keys.
// 1. This will throw a `TypeError` any time `ownKeys` is called on a frozen
//    object with a private symbol. Avoiding this is *extremely* non-trivial
//    because the invariant for that method needs modified to exclude private
//    keys from the list it checks against, but because the spec doesn't call
//    `ownKeys` implicitly from syntax exposing symbols returned from it, I
//    *could* just overwrite all the methods that delegate to it. Of course,
//    this would double or even triple the size of the polyfill below, so I
//    ignored it for now.

;(function (global) {
    "use strict"

    if (typeof Symbol.private === "function") return

    const getOwnPropertySymbols = Object.getOwnPropertySymbols
    const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors
    const ownKeys = Reflect.ownKeys
    const OldProxy = Proxy
    const OldSymbol = Symbol
    const data = new Set()
    const markPrivate = data.add.bind(data)
    const isPrivate = data.has.bind(data)
    const call = Function.call.bind(Function.call)
    const objectCreate = Object.create
    const arrayFrom = Array.from
    const arrayConcat = Array.prototype.concat.bind([])
    const hooks = objectCreate(null)
    const lengthRef = objectCreate(null)

    function removePrivateKeys(array) {
        let count = 0
        for (let i = 0; i < array.length; i++) {
            if (!isPrivate(array[i])) array[count++] = array[i]
        }
        array.length = count
        return array
    }

    /** @this {keys} */
    function filterKey(_, i) {
        const key = this[i]

        if (isPrivate(key)) {
            throw new TypeError(
                "`ownKeys` on proxy: trap returned a private symbol as a key"
            )
        }

        return key
    }

    function filterProxy(handler) {
        function forward(method) {
            return function () {
                const body = handler[method]
                if (body != null) return call(body, handler, ...arguments)
                return hooks[method](...arguments)
            }
        }

        function filter(method) {
            return function (target, key) {
                if (!isPrivate(key)) {
                    const body = handler[method]
                    if (body != null) return call(body, handler, ...arguments)
                }
                return hooks[method](...arguments)
            }
        }

        return {
            apply: forward("apply"),
            construct: forward("construct"),
            isExtensible: forward("isExtensible"),
            preventExtensions: forward("preventExtensions"),
            getPrototypeOf: forward("getPrototypeOf"),
            setPrototypeOf: forward("setPrototypeOf"),
            defineProperty: filter("defineProperty"),
            deleteProperty: filter("deleteProperty"),
            get: filter("get"),
            getOwnPropertyDescriptor: filter("getOwnPropertyDescriptor"),
            has: filter("has"),
            set: filter("set"),

            ownKeys(target) {
                let body = handler.ownKeys

                if (body == null) return ownKeys(target)
                const keys = call(body, handler, target)

                lengthRef.length = keys.length
                return arrayFrom(lengthRef, filterKey, keys)
            },
        }
    }

    function defineMethods(root, methods) {
        for (const key of Object.keys(methods)) {
            Object.defineProperty(root, key, {
                configurable: true, enumerable: false, writable: true,
                value: methods[key],
            })
        }
    }

    defineMethods(Symbol, {
        private(name) {
            const sym = OldSymbol(name)
            markPrivate(sym)
            return sym
        },

        isPrivate(sym) {
            if (typeof sym === "symbol") return isPrivate(symbol)
            throw new TypeError("`sym` is not a symbol!")
        },
    })

    defineMethods(Object, {
        getOwnPropertySymbols(object) {
            return removePrivateKeys(getOwnPropertySymbols(object))
        },

        getOwnPropertyDescriptors(object) {
            const result = getOwnPropertyDescriptors(object)
            const keys = getOwnPropertySymbols(object)
            for (let i = 0; i < keys.length; i++) {
                if (isPrivate(keys[i])) delete result[keys[i]]
            }
            return result
        },
    })

    defineMethods(Reflect, {
        ownKeys(target) {
            return removePrivateKeys(ownKeys(target))
        },
    })

    for (const key of Object.getOwnPropertyNames(Reflect)) {
        hooks[key] = Reflect[key]
    }

    global.Proxy = class Proxy {
        constructor(target, handler) {
            return new OldProxy(target, filterProxy(handler))
        }

        static revocable(target, handler) {
            return OldProxy.revocable(target, filterProxy(handler))
        }
    }
})(this)
