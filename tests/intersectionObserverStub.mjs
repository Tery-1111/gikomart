// Controllable IntersectionObserver stub for jsdom.
//
// jsdom does not implement IntersectionObserver, so the REAL app.js under test
// normally takes its immediate-apply fallback (that is what
// tests/xssEscaping.test.mjs exercises, along with the escaping contract).
// Tests that must assert the DEFERRED path — background NOT applied until the
// element actually intersects — install this stub BEFORE importing app.js:
//
//   const io = installIntersectionObserverStub(globalThis);
//   await import('../public/assets/js/app.js');
//   ...
//   io.instances[0].trigger(coverEl);        // simulate >=10% visibility
//   io.instances[0].trigger(coverEl, false); // simulate an off-screen tick
//
// The stub never fires callbacks on its own: the test decides exactly when an
// element "intersects", which is what makes deferred behavior assertable.

export function createIntersectionObserverStub() {
  const instances = [];

  class IntersectionObserverStub {
    constructor(callback, options = {}) {
      if (typeof callback !== 'function') {
        throw new TypeError('IntersectionObserver: callback must be a function');
      }
      this.callback = callback;
      this.threshold = options.threshold ?? 0;
      this.rootMargin = options.rootMargin ?? '0px';
      // Elements currently watched. Holds strong refs on purpose so tests can
      // assert exactly what the observer would hold in the browser.
      this.observed = new Set();
      this.disconnected = false;
      instances.push(this);
    }

    observe(target) {
      if (this.disconnected) return;
      this.observed.add(target);
    }

    unobserve(target) {
      this.observed.delete(target);
    }

    disconnect() {
      this.observed.clear();
      this.disconnected = true;
    }

    takeRecords() {
      return [];
    }

    // Test control: fire the callback for one observed element (defaults to
    // the first still-observed one). Returns false when the element is not
    // observed — e.g. after the app's one-shot unobserve — so tests can
    // assert the "gone from the registry" property too.
    trigger(el, isIntersecting = true) {
      const target = el ?? [...this.observed][0];
      if (!target || !this.observed.has(target)) return false;
      this.callback(
        [{ target, isIntersecting, intersectionRatio: isIntersecting ? 0.2 : 0, time: 0 }],
        this,
      );
      return true;
    }

    triggerAll(isIntersecting = true) {
      for (const target of [...this.observed]) this.trigger(target, isIntersecting);
    }
  }

  return { IntersectionObserverStub, instances };
}

// Installs the stub class on `target` (default globalThis, which is what the
// app's `typeof IntersectionObserver` check resolves against under the node
// vitest environment) and returns { IntersectionObserver, instances }.
export function installIntersectionObserverStub(target = globalThis) {
  const { IntersectionObserverStub, instances } = createIntersectionObserverStub();
  target.IntersectionObserver = IntersectionObserverStub;
  return { IntersectionObserver: IntersectionObserverStub, instances };
}
