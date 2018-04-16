# Private data proposal

I'd like to see private data done in a way that isn't so class-centric and isn't so limiting. Not everyone is using classes, some of us are still preferring (or in some cases, exclusively using) objects. Also, it'd be nice to be able to share those freely, especially across non-inheriting classes (think: module-internal slots) or even across modules (think: `protected` data or shared internal slots within a single package).

So here's my thought:

- New statement `private #foo, #bar, #baz`. This can be used in classes and in any scope as a statement, as well as in an object literal as a pseudo-property, and it declares a list of private slots that scope/class may carry.

    - Within classes, this defines class-specific private names that can only be used within that class.
    - Within object literals, this defines object-specific private names that can only be used within getters, setters, and shorthand methods on that object.
    - Within modules, this defines module-specific private names that can only be used within that module (unless exported - this will be addressed later)
    - Within inner scopes (basically, block scopes), this defines scope-specific private names that can only be used within that scope.
    - Order doesn't matter as long as you eventually declare it in the scope somewhere.
    - Private keys are *not* accessible via reflection at all. If you want something that is both private *and* inspectable, use symbols instead.

- You can export private names from a module (think: `protected` data) by exporting it like `export { #foo }`.
    - You may import them via `import { #foo } from "mod"`.
    - You can alias them as normal via `import { #foo as #bar } from "mod"`.

- Classes and object literals implicitly set defined in-scope private slots to `undefined` - there is no need to initialize them explicitly.
    - You can read and write variables via `object.#foo`.
    - Within object literals, you can still do `{ #foo: bar }` like you can with other properties.
    - Everything else works as you'd expect.

- Private methods and shorthand property assignments within classes and object literals are implicitly declared if they aren't already in scope.
    - This allows concise declaration of private methods.
    - You don't need to do `#foo;`, but this lets you do `#foo = 1` still.
    - You can still declare a method that's semantically `protected` rather than `private` by simply defining it module-level and potentially exporting it.

- Only objects created within classes and literals defined in the scope can have fields set using that scope's private keys.
    - Exception: subclass objects *may* have fields from its supertypes' scopes appended to it.
    - Note: private fields are *not* inheritable *nor* are they automatically accessible through proxies. Either they're on the raw object itself, or they aren't.
    - If you attempt to access an object without your private field defined on it, a `TypeError` is thrown.

The general rule of thumb is that a private field can be defined in (nearly) any set of curly braces, and it's visible both within that set of curly braces and any sets of curly braces contained within it. However, it's not defined in any set of curly braces above the one it's immediately defined in.

```js
// 0: no fields visible
{
    // 1: only #a visible
    private #a

    {
        // 2: #a, #b visible
        private #b

        {
            // 3: #a, #b visible
        }
    }
}
```

Also, the other rule of thumb is that private fields only exist within objects created where they're visible, and only exist for object literals and classes (nothing else). In the above example, an object literal created in 2 or 3 could have either `#a` or `#b` set in it, but an object created in 0 couldn't have either set, even if you're reading the object in 2 or 3. Similarly, an object literal created in 1 could have `#a`, but not `#b`, even if you're reading the object in 2 or 3.

## How will this handle the various needs for private data?

- It won't require as many changes as you might think when it comes to using private fields:

    ```js
    // This works as-is, and is almost directly copied from the existing class
    // method/field proposal's README: https://github.com/tc39/proposal-class-fields
    class Counter extends HTMLElement {
      #x = 0

      #clicked = () => {
        this.#x++
        window.requestAnimationFrame(() => this.#render())
      }

      constructor() {
        super()
        this.onclick = this.clicked
      }

      connectedCallback() { this.#render() }

      #render() {
        this.textContent = this.#x.toString()
      }
    }
    window.customElements.define('num-counter', Counter)
    ```

- If you want static fields, it will continue to work similarly to this: https://github.com/tc39/proposal-static-class-features/

- If you want to declare a field without immediately using it within a class, you can do this:

    ```js
    class LazyCounter extends HTMLElement {
      private #x

      #clicked = () => {
        if (this.#x == null) this.#x = 0
        this.#x++
        window.requestAnimationFrame(() => this.#render())
      };

      constructor() {
        super()
        this.onclick = this.#clicked
      }

      connectedCallback() { this.#render() }

      #render() {
        this.textContent = this.#x.toString()
      }
    }
    window.customElements.define('num-counter', Counter)
    ```

- If you want private data for an object, you can declare it this way:

    ```js
    private #elem, #x
    
    function makeCounter(elem) {
        const state = { #elem: elem, #x: 0 }
        render(state)
        elem.onclick = () => clicked(state)
        return state
    }

    function render(state) {
        state.#elem.textContent = state.#x.toString()
    }

    function clicked(state) {
        state.#x++
        window.requestAnimationFrame(() => render(state))
    }
    ```

- If you want to share private data across modules (this also features a circular dependency):

    ```js
    // create.js
    import {render, clicked} from "./update.js"
    private #elem, #x
    export { #elem, #x }
    
    function makeCounter(elem) {
        const state = { #elem: elem, #x: 0 }
        render(state)
        elem.onclick = () => clicked(state)
        return state
    }
    
    // update.js
    import { #elem, #x } from "./create.js"

    function render(state) {
        state.#elem.textContent = state.#x.toString()
    }

    function clicked(state) {
        state.#x++
        window.requestAnimationFrame(() => render(state))
    }
    ```

- Inner classes inherit access to private members from their outer classes:

    ```js
    class Foo {
        private #x
        
        bar() {
            const self = this
            
            return class Bar {
                get x() { return self.#x }
            }
        }
    }
    ```
    
    This just falls out of the scope-based nature of the private fields.

- For interop with dynamic/namespace imports, there exist one other statement:

    - `private { ...fields } from module` - Import a set of exported private keys from a module namespace object. A `TypeError` is thrown if `module` is not a module namespace object, and a `ReferenceError` is thrown if the object lacks one or more of those fields. In the event the statement throws, attempts to access those fields will also throw a `ReferenceError` (to warn about certain classes of bugs).
    - Note: fields defined in `private { ... } from module` declarations can't be exported (early rule), since they might not be available at module instantiation time. If you must, export a mutable function reference instead.
    - Note: `private { ... } from module` is *only* a statement. It is not a class or object member.

## Spec implementation

1. Each class, function, and block scope gets a list of private keys it has, tracked by identity.
1. Each object gains a list of private key/value descriptors, set on creation.
    - On `super`, it also adds the private key/value descriptors required for the parent class. (This includes ES5-style constructors.)
1. Keys may be shadowed by an inner `private { #foo }`, where the outer scope has such a declaration, too.
    - Keys are referenced like variables, where `private { #foo }` is like a variable declaration.
1. Setting a private key on an object that doesn't have that key results in a `TypeError`.
1. Scope environments also carry a [[RevokedPrivateKeys]] list for all dynamically referenced keys (via `private { #foo } from module`) that failed to be referenced for any reason.
1. To avoid ambiguity in sloppy mode, at least one declaration is required.

## Transpiler implementation

- A `WeakMap` is generated for each of the module's private slots.
- When transpiling, exported keys are exposed via an `__exportedRefs` property detailed [here](https://github.com/isiahmeadows/private-data-proposal/blob/master/commonjs-helpers.js).
    - The global level just immediately calls `.init` before importing or executing anything.
- For every local dereference, it translates into getting the value for the object in the field's weak map.
- For every imported dereference, it translates into getting the value for the object with the module's exported keys wrapper.
- Setting for each works similarly.
- For exported private methods, it works by a `get` + `.call` as appropriate.

## Engine implementation

- It can just follow the spec a little more closely:
    - For local fields, just allocate room for a creator scope pointer and a value. If preferred (like for larger objects), you may choose to model them like key/value pairs, like what imported/exported fields do.
    - For imported/exported fields, you'll need to keep an array of key/value field descriptors. This could be allocated separately on first use.
    - For object literals, you can just allocate a fixed number of local fields for the object, potentially within the same allocation as the object literal handle itself. You'll still need to allocate an array for imported/exported fields.
    - For classes, you'll need to figure out how many slots to allocate based on the inheritance chain at class declaration time, but you can make similar optimizations as with object literals after that.
- Accessing local fields is as simple as reading an offset on the object (maybe two if it's behind a pointer) after asserting the creator is the scope or a parent of it (unless you eliminate it using type feedback).
- Accessing imported/exported fields is just a basic iterative lookup given a known key.
- Fields are unique pointers with a reference to their key. You could use a pointer to the raw key's string as the key itself, or you could do other similar optimizations.
