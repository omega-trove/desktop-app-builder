/* Reported activity must be measured, never invented.
 *
 * activity_percentage was Math.random()*40+60 and the input counts were random
 * too. Those values reach manager-facing reports and the server's automation
 * detector, so these tests pin down both that the new numbers come from real
 * idle-time samples and that the old fabrications cannot come back. */
const test = require('node:test');
const assert = require('node:assert');
const { readSource, slice } = require('./helpers/load-source');

function loadActivity({ idleSequence = [], idleThrows = false } = {}) {
    const src = readSource();
    const decls = slice(src, 'const ACTIVITY_SAMPLE_INTERVAL_MS = 15000;', 'let lastActivityReportAt = null;');
    const sample = slice(src, 'async function sampleActivity', '\n}');
    const consume = slice(src, 'async function consumeActivityPercentage', '\n}');
    const duration = slice(src, 'function consumeActivityDuration', '\n}');

    const state = { idle: idleSequence.slice(), calls: 0, warnings: 0, now: 1_000_000 };

    const factory = new Function('state', `
        const console = { warn() { state.warnings++; }, log() {} };
        const Date = { now: () => state.now };
        const window = {
            electronAPI: {
                getIdleTime: async () => {
                    state.calls++;
                    if (${idleThrows}) throw new Error('unavailable');
                    return state.idle.length ? state.idle.shift() : 0;
                },
            },
        };
        ${decls}
        ${sample}
        ${consume}
        ${duration}
        return {
            sampleActivity,
            consumeActivityPercentage,
            consumeActivityDuration,
            interval: ACTIVITY_SAMPLE_INTERVAL_MS,
            seed: () => { lastActivityReportAt = state.now; },
        };
    `);
    return { api: factory(state), state };
}

test('a sample counts as active only when the OS saw input inside the window', async () => {
    // 15s window: 2s and 14s idle mean input during it; 20s and 600s do not.
    const { api } = loadActivity({ idleSequence: [2, 14, 20, 600] });
    for (let i = 0; i < 4; i++) await api.sampleActivity();
    assert.strictEqual(await api.consumeActivityPercentage(), 50);
});

test('a fully active period reports 100 and a fully idle one reports 0', async () => {
    const active = loadActivity({ idleSequence: [1, 1, 1] });
    for (let i = 0; i < 3; i++) await active.api.sampleActivity();
    assert.strictEqual(await active.api.consumeActivityPercentage(), 100);

    const idle = loadActivity({ idleSequence: [99, 99, 99] });
    for (let i = 0; i < 3; i++) await idle.api.sampleActivity();
    assert.strictEqual(await idle.api.consumeActivityPercentage(), 0);
});

test('consuming resets the window so the next period is measured on its own', async () => {
    const { api } = loadActivity({ idleSequence: [1, 1, 99, 99] });
    await api.sampleActivity();
    await api.sampleActivity();
    assert.strictEqual(await api.consumeActivityPercentage(), 100);

    await api.sampleActivity();
    await api.sampleActivity();
    assert.strictEqual(await api.consumeActivityPercentage(), 0, 'the first period must not bleed into the second');
});

test('an empty window takes a sample rather than reporting a made-up number', async () => {
    const { api, state } = loadActivity({ idleSequence: [3] });
    assert.strictEqual(await api.consumeActivityPercentage(), 100);
    assert.strictEqual(state.calls, 1, 'exactly one on-demand sample');
});

test('unreadable idle time carries the last real reading instead of inventing one', async () => {
    const { api } = loadActivity({ idleSequence: [1, 1] });
    await api.sampleActivity();
    assert.strictEqual(await api.consumeActivityPercentage(), 100);

    // Now the platform stops answering entirely.
    const broken = loadActivity({ idleThrows: true });
    assert.strictEqual(await broken.api.consumeActivityPercentage(), 0,
        'with no reading ever taken, 0 is the only honest answer');
    assert.strictEqual(broken.state.warnings, 1, 'and it says so out loud');
});

test('duration reports the real elapsed period, not a constant', () => {
    const { api, state } = loadActivity({});
    api.seed();
    state.now += 60_000;
    assert.strictEqual(api.consumeActivityDuration(), 60);

    state.now += 90_000;
    assert.strictEqual(api.consumeActivityDuration(), 90, 'each period is measured from the previous report');
});

test('duration never reports zero seconds', () => {
    const { api } = loadActivity({});
    api.seed();
    assert.strictEqual(api.consumeActivityDuration(), 1);
});

test('no telemetry field is generated from Math.random', () => {
    const src = readSource();
    const payloadFields = [
        /activity_percentage['"]?\s*[,:]\s*Math\.random/,
        /keystrokes\s*:\s*Math\.random/,
        /mouse_clicks\s*:\s*Math\.random/,
    ];
    for (const pattern of payloadFields) {
        assert.doesNotMatch(src, pattern, `a reported metric is being fabricated: ${pattern}`);
    }
    // Scoped to the upload path: the prose above this test naturally quotes the
    // old label, so match on code, not on wording.
    const uploadBody = slice(src, 'async function uploadScreenshot', '\n}');
    assert.doesNotMatch(uploadBody, /Math\.random/,
        'the screenshot upload must carry the measured value, not a rolled one');
});

test('input counts are omitted rather than guessed', () => {
    const src = readSource();
    const activityPayload = slice(src, 'const activities = [{', '}];');
    assert.doesNotMatch(activityPayload, /keystrokes/,
        'the renderer cannot see system-wide input, so it must not report counts');
    assert.doesNotMatch(activityPayload, /mouse_clicks/);
    assert.match(activityPayload, /duration_seconds: consumeActivityDuration\(\)/);
});
