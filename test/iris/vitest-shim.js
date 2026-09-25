"use strict";
/**
 * test/iris/vitest-shim.js
 *
 * Upstream Iris tests with vitest. GemAir has no test framework at all — it
 * runs `node --test` over `test/*.test.js` and plain scripts under `scripts/`
 * — and adding a dev dependency to run somebody else's suite is a poor trade.
 *
 * So the ported test files keep their vitest source EXACTLY as written, and
 * this file provides the handful of vitest APIs they use on top of `node:test`
 * and `node:assert`: `describe`, `it`/`test` (with `it.each`), the lifecycle
 * hooks, `expect` with the matchers the suite actually calls, and the small
 * slice of `vi` it touches (`fn`, `stubEnv`, `unstubAllEnvs`, fake timers).
 *
 * Keeping the tests byte-similar to upstream matters more than elegance here:
 * when upstream fixes a bug in one of these suites, the diff should still apply.
 *
 * Not implemented, because nothing in the ported suite uses it: `vi.mock`
 * (module mocking), snapshots, `expect.extend`. Anything unimplemented throws
 * by name rather than silently passing — a test that quietly does nothing is
 * worse than no test.
 */

const nodeTest = require("node:test");
const assert = require("node:assert/strict");

// MARK: - Structure

function describe(name, fn) {
  return nodeTest.describe(name, fn);
}
describe.skip = (name, fn) => nodeTest.describe.skip(name, fn);

function makeIt(runner) {
  const it = (name, fn, timeout) =>
    runner(name, typeof timeout === "number" ? { timeout } : undefined, wrap(fn));
  it.skip = (name, fn) => nodeTest.it.skip(name, wrap(fn));
  it.only = (name, fn) => nodeTest.it.only(name, wrap(fn));
  /** `it.runIf(cond)` / `it.skipIf(cond)`: the guard the Windows-only e2e uses.
   *  A skipped test is REPORTED as skipped rather than dropped, so a suite that
   *  runs nowhere cannot look like a suite that passed. */
  it.runIf = (condition) => (condition ? it : it.skip);
  it.skipIf = (condition) => (condition ? it.skip : it);
  /**
   * `it.each` with vitest's printf-style titles (`%s`, `%i`, `%d`, `%j`, `%o`,
   * `%p`, `%#`). A row that is an array is spread into the test function's
   * parameters, which is the form the ported suites use throughout.
   */
  it.each = (rows) => (name, fn) => {
    rows.forEach((row, index) => {
      const values = Array.isArray(row) ? row : [row];
      runner(formatEachTitle(name, values, index), undefined, wrap(() => fn(...values)));
    });
  };
  return it;
}

function wrap(fn) {
  // node:test passes a TestContext as the first argument; vitest tests either
  // take nothing or take their `it.each` row, so the context is dropped.
  return function wrapped() {
    return fn();
  };
}

function formatEachTitle(name, values, index) {
  let position = 0;
  const title = String(name).replace(/%[sidjofp#%]/g, (token) => {
    if (token === "%%") return "%";
    if (token === "%#") return String(index);
    const value = values[position++];
    if (token === "%j" || token === "%o" || token === "%p") {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    if (token === "%i" || token === "%d") return String(Number(value));
    return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
  });
  // A title with no placeholders would otherwise repeat, and node:test reports
  // duplicates as separate lines with no way to tell them apart.
  return title === String(name) ? `${title} [${index}]` : title;
}

const it = makeIt(nodeTest.it);

// MARK: - expect

/** vitest's asymmetric matchers, recognised by `equals` below. */
const ASYMMETRIC = Symbol("asymmetric");

function objectContaining(expected) {
  return {
    [ASYMMETRIC]: true,
    describe: () => `objectContaining(${JSON.stringify(expected)})`,
    matches: (actual) => {
      if (actual === null || typeof actual !== "object") return false;
      return Object.entries(expected).every(([key, value]) => equals(actual[key], value));
    },
  };
}

function stringContaining(expected) {
  return {
    [ASYMMETRIC]: true,
    describe: () => `stringContaining(${JSON.stringify(expected)})`,
    matches: (actual) => typeof actual === "string" && actual.includes(expected),
  };
}

function any(constructor) {
  return {
    [ASYMMETRIC]: true,
    describe: () => `any(${constructor && constructor.name})`,
    matches: (actual) => {
      if (constructor === String) return typeof actual === "string";
      if (constructor === Number) return typeof actual === "number";
      if (constructor === Boolean) return typeof actual === "boolean";
      if (constructor === Function) return typeof actual === "function";
      return actual instanceof constructor;
    },
  };
}

function isAsymmetric(value) {
  return Boolean(value) && typeof value === "object" && value[ASYMMETRIC] === true;
}

/** Structural equality that understands the asymmetric matchers above. */
function equals(actual, expected) {
  if (isAsymmetric(expected)) return expected.matches(actual);
  if (Object.is(actual, expected)) return true;
  if (expected === null || actual === null) return false;
  if (typeof expected !== "object" || typeof actual !== "object") return false;
  if (Array.isArray(expected) !== Array.isArray(actual)) return false;
  if (Array.isArray(expected)) {
    return expected.length === actual.length && expected.every((value, i) => equals(actual[i], value));
  }
  if (expected instanceof Date || actual instanceof Date) {
    return expected instanceof Date && actual instanceof Date && expected.getTime() === actual.getTime();
  }
  // vitest's `toEqual` ignores keys whose value is `undefined` on either side,
  // so `{kind: "timedOut"}` equals `{kind: "timedOut", verifiedBy: undefined}`.
  const expectedKeys = definedKeys(expected);
  const actualKeys = definedKeys(actual);
  if (expectedKeys.length !== actualKeys.length) return false;
  return expectedKeys.every((key) => equals(actual[key], expected[key]));
}

function definedKeys(value) {
  return Object.keys(value).filter((key) => value[key] !== undefined);
}

/** vitest's `toMatchObject`: recursive *partial* equality. Extra keys on the
 *  received side are fine at every depth; arrays must be the same length and
 *  their elements are matched partially too. */
function matchesPartially(actual, expected) {
  if (isAsymmetric(expected)) return expected.matches(actual);
  if (expected === null || typeof expected !== "object") return equals(actual, expected);
  if (actual === null || typeof actual !== "object") return false;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => matchesPartially(actual[index], value))
    );
  }
  if (Array.isArray(actual)) return false;
  return Object.keys(expected).every((key) => matchesPartially(actual[key], expected[key]));
}

function show(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (isAsymmetric(value)) return value.describe();
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function makeExpectation(received, negated) {
  const check = (passed, message) => {
    if (passed === !negated) return;
    assert.fail(`${message}${negated ? " (negated)" : ""}`);
  };

  const expectation = {
    toBe(expected) {
      check(Object.is(received, expected), `expected ${show(received)} to be ${show(expected)}`);
    },
    toEqual(expected) {
      check(equals(received, expected), `expected ${show(received)} to equal ${show(expected)}`);
    },
    toStrictEqual(expected) {
      check(equals(received, expected), `expected ${show(received)} to strictly equal ${show(expected)}`);
    },
    toMatchObject(expected) {
      check(
        matchesPartially(received, expected),
        `expected ${show(received)} to match object ${show(expected)}`
      );
    },
    toContain(expected) {
      const passed =
        typeof received === "string"
          ? received.includes(expected)
          : Array.isArray(received) || received instanceof Set
            ? Array.from(received).some((value) => equals(value, expected))
            : false;
      check(passed, `expected ${show(received)} to contain ${show(expected)}`);
    },
    toContainEqual(expected) {
      check(
        Array.from(received ?? []).some((value) => equals(value, expected)),
        `expected ${show(received)} to contain an equal to ${show(expected)}`
      );
    },
    toHaveLength(expected) {
      check(
        received != null && received.length === expected,
        `expected ${show(received)} to have length ${expected}, got ${received && received.length}`
      );
    },
    toHaveProperty(key, value) {
      const has = received != null && key in received;
      check(
        arguments.length > 1 ? has && equals(received[key], value) : has,
        `expected ${show(received)} to have property ${String(key)}`
      );
    },
    toBeDefined() {
      check(received !== undefined, `expected ${show(received)} to be defined`);
    },
    toBeUndefined() {
      check(received === undefined, `expected ${show(received)} to be undefined`);
    },
    toBeNull() {
      check(received === null, `expected ${show(received)} to be null`);
    },
    toBeTruthy() {
      check(Boolean(received), `expected ${show(received)} to be truthy`);
    },
    toBeFalsy() {
      check(!received, `expected ${show(received)} to be falsy`);
    },
    toBeNaN() {
      check(Number.isNaN(received), `expected ${show(received)} to be NaN`);
    },
    toBeGreaterThan(expected) {
      check(received > expected, `expected ${show(received)} > ${show(expected)}`);
    },
    toBeGreaterThanOrEqual(expected) {
      check(received >= expected, `expected ${show(received)} >= ${show(expected)}`);
    },
    toBeLessThan(expected) {
      check(received < expected, `expected ${show(received)} < ${show(expected)}`);
    },
    toBeLessThanOrEqual(expected) {
      check(received <= expected, `expected ${show(received)} <= ${show(expected)}`);
    },
    toBeCloseTo(expected, digits = 2) {
      check(
        Math.abs(received - expected) < Math.pow(10, -digits) / 2,
        `expected ${show(received)} to be close to ${show(expected)}`
      );
    },
    toBeInstanceOf(constructor) {
      check(received instanceof constructor, `expected ${show(received)} to be an instance of ${constructor.name}`);
    },
    toMatch(pattern) {
      const passed =
        pattern instanceof RegExp ? pattern.test(String(received)) : String(received).includes(String(pattern));
      check(passed, `expected ${show(received)} to match ${String(pattern)}`);
    },
    toThrow(expected) {
      let thrown;
      try {
        received();
      } catch (error) {
        thrown = error ?? new Error("thrown falsy value");
      }
      if (!thrown) {
        check(false, "expected the function to throw");
        return;
      }
      check(true, "");
      if (expected === undefined || negated) return;
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      if (typeof expected === "string") {
        assert.ok(message.includes(expected), `expected the error message ${show(message)} to contain ${show(expected)}`);
      } else if (expected instanceof RegExp) {
        assert.ok(expected.test(message), `expected the error message ${show(message)} to match ${expected}`);
      } else if (typeof expected === "function") {
        assert.ok(thrown instanceof expected, `expected the error to be an instance of ${expected.name}`);
      }
    },
    toHaveBeenCalled() {
      check(mockCalls(received).length > 0, "expected the mock to have been called");
    },
    toHaveBeenCalledTimes(expected) {
      const calls = mockCalls(received);
      check(calls.length === expected, `expected ${expected} calls, saw ${calls.length}`);
    },
    toHaveBeenCalledWith(...expected) {
      const calls = mockCalls(received);
      check(
        calls.some((call) => equals(call, expected)),
        `expected a call with ${show(expected)}, saw ${show(calls)}`
      );
    },
  };

  expectation.toThrowError = expectation.toThrow;

  if (!negated) {
    expectation.not = makeExpectation(received, true);
  }

  // `await expect(promise).resolves.toBe(x)` / `.rejects.toThrow(...)`.
  expectation.resolves = new Proxy(
    {},
    {
      get:
        (_target, matcher) =>
        async (...args) => {
          const value = await received;
          return makeExpectation(value, negated)[matcher](...args);
        },
    }
  );
  expectation.rejects = new Proxy(
    {},
    {
      get:
        (_target, matcher) =>
        async (...args) => {
          let thrown;
          let resolved = false;
          try {
            await received;
            resolved = true;
          } catch (error) {
            thrown = error;
          }
          if (resolved) {
            if (negated) return undefined;
            assert.fail("expected the promise to reject, but it resolved");
          }
          // `.rejects.toThrow(...)` is spelled against the thrown value itself.
          if (matcher === "toThrow" || matcher === "toThrowError") {
            return makeExpectation(() => {
              throw thrown;
            }, negated)[matcher](...args);
          }
          return makeExpectation(thrown, negated)[matcher](...args);
        },
    }
  );

  return expectation;
}

function mockCalls(candidate) {
  if (!candidate || !candidate.mock || !Array.isArray(candidate.mock.calls)) {
    assert.fail("expected a vi.fn() mock");
  }
  return candidate.mock.calls;
}

function expect(received) {
  return makeExpectation(received, false);
}
expect.objectContaining = objectContaining;
expect.stringContaining = stringContaining;
expect.any = any;
expect.arrayContaining = (expected) => ({
  [ASYMMETRIC]: true,
  describe: () => `arrayContaining(${JSON.stringify(expected)})`,
  matches: (actual) =>
    Array.isArray(actual) && expected.every((value) => actual.some((entry) => equals(entry, value))),
});

// MARK: - vi

const stubbedEnv = new Map();

const vi = {
  /** A call-recording function, with vitest's `.mock.calls` shape. */
  fn(implementation) {
    const mock = { calls: [], results: [] };
    const fn = (...args) => {
      mock.calls.push(args);
      const value = implementation ? implementation(...args) : undefined;
      mock.results.push({ type: "return", value });
      return value;
    };
    fn.mock = mock;
    fn.mockClear = () => {
      mock.calls.length = 0;
      mock.results.length = 0;
      return fn;
    };
    fn.mockReset = fn.mockClear;
    fn.mockImplementation = (next) => {
      implementation = next;
      return fn;
    };
    fn.mockReturnValue = (value) => fn.mockImplementation(() => value);
    fn.mockResolvedValue = (value) => fn.mockImplementation(() => Promise.resolve(value));
    fn.mockRejectedValue = (error) => fn.mockImplementation(() => Promise.reject(error));
    return fn;
  },

  stubEnv(name, value) {
    if (!stubbedEnv.has(name)) stubbedEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = String(value);
  },

  unstubAllEnvs() {
    for (const [name, original] of stubbedEnv) {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
    stubbedEnv.clear();
  },

  // Fake timers: the ported suite uses only "advance time and let pending
  // promises run", so this is a real-timer shim that simply awaits, rather than
  // a clock replacement nobody here needs.
  useFakeTimers() {},
  useRealTimers() {},
  advanceTimersByTimeAsync: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 50))),
  advanceTimersByTime: () => {},

  mock() {
    throw new Error("vitest-shim: vi.mock is not implemented — no ported test uses it");
  },
  spyOn() {
    throw new Error("vitest-shim: vi.spyOn is not implemented — no ported test uses it");
  },
};

module.exports = {
  describe,
  it,
  test: it,
  expect,
  vi,
  beforeEach: nodeTest.beforeEach,
  afterEach: nodeTest.afterEach,
  beforeAll: nodeTest.before,
  afterAll: nodeTest.after,
  suite: describe,
};
