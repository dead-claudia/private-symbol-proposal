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

- You can export private names from a module or scope (think: `protected` data) by simply exporting a function that reads/writes to it.
    - Super simple, nothing to spec here.
    - If you're frequently declaring data separately from where you create it, you're *probably* doing something wrong.

- Classes and object literals implicitly set defined in-scope private slots to `undefined` - there is no need to initialize them explicitly.
    - You can read and write variables via `object.#foo`.
    - Within object literals, you can still do `{ #foo: bar }` like you can with other properties.
    - Everything else works as you'd expect.

- Private methods and shorthand property assignments within classes and object literals are implicitly declared if they aren't already in scope.
    - This allows concise declaration of private methods.
    - You don't need to do `#foo;` (and it'd be illegal, anyways), but this lets you do `#foo = 1` still.
    - You can still declare a method that's semantically `protected` rather than `private` by simply defining it module-level and potentially exporting a function to read/write it.

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

- If you want to share private data across modules:

    ```js
    // create.js
    import { render, clicked } from "./update.js"
    private #elem, #x

    export function makeCounter(elem) {
        const state = { #elem: elem, #x: 0 }
        render(state)
        elem.onclick = () => clicked(state)
        return state
    }

    export function getElem(state) { return state.#elem }
    export function getX(state) { return state.#x }
    export function incrementX(state) { state.#x++ }

    // update.js
    import { getElem, getX, incrementX } from "./create.js"

    function render(state) {
        getElem(state).textContent = getX(state).toString()
    }

    function clicked(state) {
        incrementX(state)
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
    
    This just naturally falls out of the scope-based nature of the private fields.

## Spec implementation

1. Each module, class, function, and block scope gets a list of private keys it has, tracked by identity.
1. Each object gains a list of private key/value descriptors, set on creation.
    - On `super`, it also adds the private key/value descriptors required for the parent class. (This includes ES5-style constructors.)
1. Keys may be shadowed by an inner `private #foo`, where the outer scope has such a declaration, too.
    - Keys are referenced like variables, where `private #foo` is like a variable declaration.
1. Setting a private key on an object that doesn't have that key results in a `TypeError`.
1. To avoid ambiguity in sloppy mode, at least one declaration is required.

## Transpiler implementation

- A `WeakMap` is generated for each scope to hold its private fields' values.
- Every private field dereference translates into getting the field's value from the weak map.
- Every private field assignment translates into setting the field's value in the weak map.
- A transpiler may choose to reuse the same retrieved map for multiple field accesses, instead of repeating it in a naïve desugaring.

## Engine implementation

- It can just follow the spec a little more closely:
    - It could just allocate room for a creator scope pointer and values for the fields directly with the object in the same heap allocation. The fields can trivially translate to static offsets, so those don't need stored with the object.
    - For classes, you'll need to figure out how many slots to allocate based on the inheritance chain at class declaration time, but this does not affect the above optimization.
- Accessing private fields per above is as simple as reading an offset on the object (maybe two if it's behind a pointer) after asserting the creator is the scope or a parent of it (which you can eliminate in optimized code given type feedback, or worst case scenario, hard-code into a series of `test`/`je` branches testing static values). This can lead to *super* efficient code, especially after inlining.
    - Of course, caution is needed: this might be something that could be converted into Meltdown/Spectre-style vector if you aren't careful to limit the number of fields allocated *with* the object (in which you *could* either bail out to a key/value map or just introduce a hard cap if it is high enough to not be a problem.)
