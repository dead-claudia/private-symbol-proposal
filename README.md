# Private symbol proposal

I'd like to see private data done in a way that isn't so class-centric and isn't so limiting. Not everyone is using classes, some of us are still preferring (or in some cases, exclusively using) objects. Also, it'd be nice to be able to share those freely, especially across non-inheriting classes (think: module-internal slots) or even across modules (think: `protected` data or shared internal slots within a single package).

So here's my thought: let's use private symbols instead.

- `Symbol.private(desc = "")` is how you create a private symbol.
- `Symbol.isPrivate(sym)` returns `true` if the symbol is private, `false` otherwise. It allows for easy introspection without too much fuss.
- Private symbol accesses ignore proxy hooks, instead delegating straight to their target (recursively if necessary).
- The \[[OwnPropertyKeys]] essential internal method does *not* include private symbols in its output, and a new proxy invariant would be added to ensure that handlers don't return them from `ownKeys`.
    - This implies that `Reflect.ownKeys()`, `Object.getOwnPropertySymbols()`, and similar can't include any private symbols in their output, either.
    - This invariant exists to prevent people from enumerating private symbols on any object. This enables several optimizations, as I will discuss later.
- Absent the above, private symbols are like any other symbol property.

Yes, it's that simple. If you understand the above, you understand the entire proposal.

### Pros and cons

There are several perks to this:

1. It is mostly polyfillable, even up to and including proxy support. It requires no new syntax - no, really.
1. This avoids the need for membranes in most cases, and it can even penetrate through prototypes.
1. Support for things like decorators, private methods, static private fields, private object literal fields, etc. naturally fall out of the grid without requiring any special support.
1. Support for private expando properties are supported, useful for things like stateful mixins.
1. Privacy control is as simple as "do you export it". If you want to restrict a symbol to specific types, you have to do it yourself.
1. It largely reuses the same pipeline engines already use to optimize symbol property accesses, so it'll be fast from the gate.
1. It doesn't further propagate the absurd abuse of weak maps for private data. Weak maps are designed for key/value stores, *not* property keys, and we shouldn't be encouraging people to see them that way.
1. Private symbols are stored weakly, and if a symbol becomes collectable, an object could open it up for a new symbol to use, avoiding almost all overhead of adding the property.

And of course, there are cons:

1. If you attempt to read or write a private symbol on a field that shouldn't have it, nobody is stopping you. (This is a direct result of supporting private expando properties.)
    - A follow-on proposal below is suggested to encourage people to use a syntax that *isn't* as susceptible to this issue.
1. You don't easily get "private", "protected", or "friend". You only get "public", "hard private", or "soft private".
1. The syntax still uses that blasted dynamic lookup syntax. For private method calls, it looks much weirder than the current proposal.
    - This is part of why I created the follow-on proposal detailed later. It still uses this behind the scenes, but it's to this as `async`/`await` is to promises and generators are to iterables - it takes most of the grief and boilerplate out of the common case, while still letting you dive deep when you need to.
1. When prototypes are involved, updating fields may result in a lot of the same weirdness you'd get with normal properties - consider `this.foo += 5` when `Object.getPrototypeOf(this).foo` is 5. In that scenario, you'd wind up defining a *new* property on `this.foo` where `this.foo` is set to 10, but `Object.getPrototypeOf(this).foo` is still 5. So if you want to remain safe against prototypes, you still have to use a single `this[_data] = {...}` object.
    - Or, the moral of the story is: prototypes are weird, and approach `Object.create(proto)` with caution when you don't control the creation of `proto`. Private symbols are only going to add more ammunition for that.

My proposal isn't the only one that suffers from some of these cons. [@zenparsing](https://github.com/zenparsing)'s [abstract references proposal](https://github.com/zenparsing/proposal-abstract-references) also has the first two issues, which is part of why he uses a single `data` field idiomatically.

### Examples

Here's the counter example from the [private methods proposal](https://github.com/tc39/proposal-private-methods), adapted to use private symbols.

```js
const _x = Symbol.private("x")
const _xValue = Symbol.private("xValue")
const _render = Symbol.private("render")

class Counter extends HTMLElement {
    [_xValue] = 0

    onclick = () => {
        this[_x]++
    }

    get [_x]() { return this[_xValue] }
    set [_x](value) {
        this[_xValue] = value
        window.requestAnimationFrame(() => this[_render]())
    }

    connectedCallback() {
        this[_render]()
    }

    [_render]() {
        this.textContent = this[_x].toString()
    }
}
window.customElements.define("num-counter", Counter)
```

If you want to emulate the existing [class field proposal](https://github.com/tc39/proposal-class-fields), you can create a wrapper to check the object appropriately:

```js
const {data, makeParent} = newPrivateSet("Point", "x", "y")

class Point extends makeParent() {
    constructor(x, y) {
        data(this).x = x
        data(this).y = y
    }

    get x() { return data(this).x }
    get y() { return data(this).y }

    toString() {
        return `Point(${data(this).x}, ${data(this).y})`
    }
}
```

For comparison, here's how that works in the other two primary proposals:

- Class fields proposal:

    ```js
    class Point {
        #x, #y

        constructor(x, y) {
            this.#x = x
            this.#y = y
        }

        get x() { return this.#x }
        get y() { return this.#y }

        toString() {
            return `Point(${this.#x}, ${this.#y})`
        }
    }
    ```

- Abstract references proposal

    ```js
    // What the abstract refs proposal would have you do currently:
    const data = new WeakMap()

    class Point {
        constructor(x, y) {
            this::data = {x, y}
        }

        get x() { return this::data.x }
        get y() { return this::data.y }

        toString() {
            return `Point(${this::data.x}, ${this::data.y})`
        }
    }
    ```

Here's the various helpers used within the examples:

```js
function newPrivateSet(name, ...fields) {
    const symbols = fields.map(key => Symbol.private(key))
    const symbolTable = Object.create(null)

    for (let i = 0; i < fields.length; i++) {
        symbolTable[fields[i]] = symbols[i]
    }

    Object.seal(symbolTable)

    class Handler {
        constructor(target) {
            this.target = target
        }

        maybeResolve(key) {
            const sym = symbolTable[key]

            if (sym == null) {
                throw new TypeError(`\`${key}\` does not exist in ${name}!`)
            }

            return sym in this.target ? sym : undefined
        }

        resolve(key) {
            const sym = this.maybeResolve(key)

            if (sym == null) {
                throw new TypeError(`\`this\` is not a ${name}!`)
            }

            return sym
        }

        has(_, key) {
            return this.maybeResolve(key) != null
        }

        get(_, key, receiver) {
            return Reflect.get(this.target, this.resolve(key), receiver)
        }

        set(_, key, value, receiver) {
            return Reflect.set(
                this.target, this.resolve(key), value, receiver
            )
        }

        getOwnPropertyDescriptor(_, key) {
            const sym = this.maybeResolve(key)
            let desc

            if (sym != null) {
                desc = Reflect.getOwnPropertyDescriptor(this.target, sym)
                if (desc != null) desc.configurable = false
            }

            return desc
        }

        defineProperty(_, key, desc) {
            const sym = this.maybeResolve(key)

            return sym != null && !desc.configurable && desc.writable &&
                Reflect.defineProperty(this.target, sym, desc)
        }
    }

    return {
        data: inst => new Proxy(symbolTable, new Handler(inst)),
        makeParent: Super => class Parent extends Super {
            constructor(...args) {
                super(...args)
                for (const sym of symbols) this[sym] = undefined
            }
        },
    }
}
```

### Past discussion

If you're familiar with some historical discussion, [this might seem familiar](https://esdiscuss.org/topic/proposal-about-private-symbol). I also get that there is some well-deserved hesitation for private symbol proposals, since most of them involve black magic that really doesn't make sense. I do feel it's sufficiently different, and it *does* address most of the various pitfalls in the other past "private symbol" proposals, in part by *not* doing much:

- Semantically, it operates more like weak maps than it does a standard property. In fact, converting from weak maps to private symbols is 100% equivalent assuming 1. the `WeakMap` methods are unmodified, and 2. proxies aren't involved (which change the `this` value). Not only that, but [you can even polyfill weak maps and weak sets in terms of private symbols](https://gist.github.com/isiahmeadows/a8494868c4b193dfbf7139589f472ad8), thanks to the object key restriction.
- It does forward through proxies, but it critically *does not* allow proxy hooks to observe their existence. This avoids the issue [of a "set" on one side not necessarily reflecting a "get" on the other side of a membrane](https://github.com/zenparsing/es-abstract-refs/issues/11#issuecomment-65723350).

## Follow-up proposals

There's a couple follow-up proposals related to this that I also have.

### Internal slot conversion

Most internal slots could be converted to instead use private, well-known, cross-realm symbols. This opens them up for better interop with proxies, since they'd just read their values through them as if they didn't exist. Indirectly, this would also remove 99% of the need for membrane proxies, by just letting the types read what they need more directly. An implementation might choose to store them differently, but in general, the use of private symbols in the spec would make the language quite a bit more consistent from spec to ordinary JS code.

And of course, after that, the WHATWG people might choose to switch up WebIDL, the DOM, and the HTML specs to do similar, use private symbols instead of internal slots for state.

And finally, using private symbols instead of normal slots would just mean that most host-dependent fields would simply disappear in favor of a generalized "HostInitializeState(*type*, *object*)" hook for implementations to just expose whatever they need in an implementation-defined (and optionally host-defined) manner.

### Private field syntax sugar

This would be to the private symbol proposal as `async`/`await` is to promises. It would remove almost all of the boilerplate and verification you'd need to do otherwise, just doing the sane thing each time. However, it's not all-powerful, and that's why it's simply *sugar* over what you could technically do already.

The general idea is to desugar `this.#foo` and similar to `this[_foo]`, but it does a bit of extra work so you don't need to worry *as much* about names conflicting with others out of scope.

There are perks to making it pure syntax sugar:

1. Decorator semantics are *incredibly* obvious, and would be more or less the same as if you just used normal public symbol properties. There's nothing to design for - literally nothing.
1. It's more optimizable, and engines could choose to implement it in a way that doesn't actually involve private symbols. This is similar to how `async`/`await` doesn't require an engine to allocate a full promise in the middle - it's all just callbacks and microtasks internally in just about every implementation.
1. In the more arcane scenarios, like a method being passed by reference or with inherited fields through proxies, there's nothing extra to spec. You just need to test that engines do the right thing in each of those cases, and that they don't optimize away more than they should.

Of course, the sugar is limited:

1. You can't mix `this.#xValue` and `this[_xValue]` and expect them to refer to the same value. The private symbol sugar names are generated per-name, per-scope.
1. You can't export them or even access the underlying symbols themselves. If you need to expose them to subclasses or friend classes, you should use normal private symbols and export them instead. Similarly, you'd need to use raw private symbols directly if you wish to modify the private symbols' descriptors.

So here's a rundown of what that sugar is like:

*Note: `_vars` in the transpiled code are really unique names that are unobservable to outside code.*

- Normal private symbols, with no syntax sugar.

    ```js
    const _x = Symbol.private("x")
    const _xValue = Symbol.private("xValue")
    const _render = Symbol.private("render")

    class Counter extends HTMLElement {
        [_xValue] = 0

        onclick = () => {
            this[_x]++
        }

        get [_x]() { return this[_xValue] }
        set [_x](value) {
            this[_xValue] = value
            window.requestAnimationFrame(() => this[_render]())
        }

        connectedCallback() {
            this[_render]()
        }

        [_render]() {
            this.textContent = this[_x].toString()
        }
    }
    window.customElements.define("num-counter", Counter)

    const _x = Symbol.private("x")
    const _y = Symbol.private("y")

    class Point {
        constructor(x, y) {
            this[_x] = x
            this[_y] = y
        }

        get x() { return this[_x] }
        get y() { return this[_y] }

        toString() {
            return `Point(${this[_x]}, ${this[_y]})`
        }
    }
    ```

- The sugar proposed here:

    ```js
    class Counter extends HTMLElement {
        #xValue = 0

        onclick = () => {
            this.#x++
        }

        get #x() { return this.#xValue }
        set #x(value) {
            this.#xValue = value
            window.requestAnimationFrame(() => this.#render())
        }

        connectedCallback() {
            this.#render()
        }

        #render() {
            this.textContent = this.#x.toString()
        }
    }
    window.customElements.define("num-counter", Counter)

    class Point {
        #x, #y

        constructor(x, y) {
            this.#x = x
            this.#y = y
        }

        get x() { return this.#x }
        get y() { return this.#y }

        toString() {
            return `Point(${this.#x}, ${this.#y})`
        }
    }
    ```

- The sugar transpiled to the most naïve form:

    ```js
    const _Object$defineProperty$ = Object.defineProperty

    function _lazySet$(inst, key, value) {
        _Object$defineProperty$(inst, key, {
            configurable: true, enumerable: true, writable: true, value,
        })
    }

    function _checkFactory$(type, name, tag) {
        return inst => {
            if (tag in inst) return inst
            throw new TypeError(`\`${type}\` is not an instance of \`${name}\`!`)
        }
    }

    const _brand$Counter$ = Symbol.private("Counter tag")
    const _staticBrand$Counter$ = Symbol.private("Counter static tag")
    const _sym$Counter$x$ = Symbol.private("Counter.#x")
    const _sym$Counter$xValue$ = Symbol.private("Counter.#xValue")
    const _sym$Counter$render$ = Symbol.private("Counter.#render")
    const _check$Counter$this$ = _checkFactory$("Counter", "this", _brand$Counter$)

    class Counter extends HTMLElement {
        static get [_staticBrand$Counter$]() {}

        constructor(...args) {
            super(...args)
            this[_brand$Counter$] = undefined
            this[_sym$Counter$xValue$] = 0
        }

        onclick = () => {
            _check$Counter$this$(this)[_sym$Counter$x$]++
        }

        // Yes, `this` doesn't have to be an instance of the class in getters,
        // setters, and methods. The brand checks just need to exist when you use
        // other private slots.
        get [_sym$Counter$x$]() {
            return _check$Counter$this$(this)[_sym$Counter$xValue$]
        }
        set [_sym$Counter$x$](value) {
            _check$Counter$this$(this)[_sym$Counter$xValue$] = value
            window.requestAnimationFrame(() =>
                _check$Counter$this$(this)[_sym$Counter$render$]()
            )
        }

        connectedCallback() {
            _check$Counter$this$(this)[_sym$Counter$render$]()
        }

        [_sym$Counter$render$]() {
            this.textContent = _check$Counter$this$(this)[_sym$Counter$x$].toString()
        }
    }
    window.customElements.define("num-counter", Counter)

    const _brand$Point$ = Symbol.private("Point tag")
    const _staticBrand$Point$ = Symbol.private("Point static tag")
    const _sym$Point$x$ = Symbol.private("Point.#x")
    const _sym$Point$y$ = Symbol.private("Point.#y")
    const _check$Point$this$ = _checkFactory$("Point", "this", _brand$Point$)

    class Point {
        static get [_staticBrand$Point$]() {}

        constructor(x, y) {
            this[_brand$Point$] = undefined
            _check$Point$this$(this)[_sym$Point$x$] = x
            _check$Point$this$(this)[_sym$Point$y$] = y
        }

        get x() { return _check$Point$this$(this)[_sym$Point$x$] }
        get y() { return _check$Point$this$(this)[_sym$Point$y$] }

        toString() {
            return `Point(${
                _check$Point$this$(this)[_sym$Point$x$]
            }, ${
                _check$Point$this$(this)[_sym$Point$y$]
            })`
        }
    }
    ```

- The sugar transpiled to an optimized form:

    ```js
    const _Object$defineProperty$ = Object.defineProperty

    function _lazySet$(inst, key, value) {
        _Object$defineProperty$(inst, key, {
            configurable: true, enumerable: true, writable: true, value,
        })
    }

    function _checkFactory$(type, name, tag) {
        return inst => {
            if (tag in inst) return inst
            throw new TypeError(`\`${type}\` is not an instance of \`${name}\`!`)
        }
    }

    const _brand$Counter$ = Symbol.private("Counter tag")
    const _sym$Counter$xValue$ = Symbol.private("Counter.#x")
    const _check$Counter$this$ = _checkFactory$("Counter", "this", _brand$Counter$)

    function _genGet$Counter$x(_this) {
        return _this[_sym$Counter$xValue$]
    }

    function _genSet$Counter$x(_this, value) {
        _this[_sym$Counter$xValue$] = value
        window.requestAnimationFrame(() => _genMethod$Counter$render(_this))
    }

    function _genMethod$Counter$render(_this) {
        _this.textContent = _genGet$Counter$x(_this).toString()
    }

    class Counter extends HTMLElement {
        constructor(...args) {
            super(...args)
            this[_brand$Counter$] = undefined
            this[_sym$Counter$xValue$] = 0
        }

        onclick = () => {
            _check$Counter$this$(this)
            _genSet$Counter$x(this, _genGet$Counter$x(this) + 1)
        }

        connectedCallback() {
            _genMethod$Counter$render(_check$Counter$this$(this))
        }
    }
    window.customElements.define("num-counter", Counter)

    const _brand$Point$ = Symbol.private("Point tag")
    const _sym$Point$x$ = Symbol.private("Point.#x")
    const _sym$Point$y$ = Symbol.private("Point.#y")
    const _check$Point$this$ = _checkFactory$("Point", "this", _brand$Point$)

    class Point {
        constructor(x, y) {
            this[_brand$Point$] = undefined
            this[_sym$Point$x$] = x
            this[_sym$Point$y$] = y
        }

        get x() { return _check$Point$this$(this)[_sym$Point$x$] }
        get y() { return _check$Point$this$(this)[_sym$Point$y$] }

        toString() {
            _check$Point$this$(this)
            return `Point(${this[_sym$Point$x$]}, ${this[_sym$Point$y$]})`
        }
    }
    ```

There are a few optimizations you can make to the transpiler output, as I demonstrated above in the last example:

- Instead of checking multiple times in a single code path, you can wait until the first observable access in each one and compress them all.
- If a getter, setter, or method is private and never accessed directly (only possible with methods), you can factor them out as functions rather than reifying them as actual properties. Also, within these getters, setters, and methods, you don't need to check at all before accessing private properties, since you couldn't get there in the first place without such a check.
- You can omit tags and fields that aren't used. They're not observable, so there's no need to keep them unless you need to check them.
