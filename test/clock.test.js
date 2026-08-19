/* The counter must measure elapsed wall-clock, not count interval firings. */
const test = require('node:test');
const assert = require('node:assert');
const { readSource, slice } = require('./helpers/load-source');

function loadClock() {
    const src = readSource();
    const decls = slice(src, 'let lastTickMs = null;', 'const MAX_TICK_DELTA_MS = 90000;');
    const tick = slice(src, 'function incrementAndDisplay() {', '\n}');

    const sandbox = { seconds: 0, currentSessionSeconds: 0, now: 0, updates: 0 };
    const factory = new Function(
        'sandbox',
        `
        let seconds = sandbox.seconds;
        let currentSessionSeconds = sandbox.currentSessionSeconds;
        const Date = { now: () => sandbox.now };
        const updateTimerUI = () => { sandbox.updates++; };
        ${decls}
        ${tick}
        return {
            tick: incrementAndDisplay,
            read: () => ({ seconds, currentSessionSeconds }),
            anchor: (t) => { lastTickMs = t; tickRemainderMs = 0; },
            maxDelta: MAX_TICK_DELTA_MS,
        };
        `
    );
    return { api: factory(sandbox), sandbox };
}

test('first tick anchors without crediting time', () => {
    const { api, sandbox } = loadClock();
    sandbox.now = 1_000_000;
    api.tick();
    assert.deepStrictEqual(api.read(), { seconds: 0, currentSessionSeconds: 0 });
});

test('credits real elapsed time, not the number of ticks', () => {
    const { api, sandbox } = loadClock();
    sandbox.now = 0;
    api.tick(); // anchor

    // Ten firings that each actually took 1.4s — the old counter would have
    // credited 10 seconds for 14 seconds of work.
    for (let i = 1; i <= 10; i++) {
        sandbox.now = i * 1400;
        api.tick();
    }
    assert.strictEqual(api.read().seconds, 14);
    assert.strictEqual(api.read().currentSessionSeconds, 14);
});

test('carries the sub-second remainder instead of discarding it', () => {
    const { api, sandbox } = loadClock();
    sandbox.now = 0;
    api.tick();

    // Four 250ms slices make exactly one second.
    for (let i = 1; i <= 4; i++) {
        sandbox.now = i * 250;
        api.tick();
    }
    assert.strictEqual(api.read().seconds, 1);
});

test('a delta longer than the sleep threshold credits nothing', () => {
    const { api, sandbox } = loadClock();
    sandbox.now = 0;
    api.tick();

    sandbox.now = api.maxDelta + 60_000; // machine slept for over two minutes
    api.tick();
    assert.strictEqual(api.read().seconds, 0, 'suspended time must not be credited');

    // …and the clock keeps working afterwards.
    sandbox.now += 3000;
    api.tick();
    assert.strictEqual(api.read().seconds, 3);
});

test('a backwards clock step credits nothing and does not unwind', () => {
    const { api, sandbox } = loadClock();
    sandbox.now = 500_000;
    api.tick();
    sandbox.now = 400_000; // NTP correction / manual change
    api.tick();
    assert.strictEqual(api.read().seconds, 0);

    sandbox.now = 402_000;
    api.tick();
    assert.strictEqual(api.read().seconds, 2);
});
