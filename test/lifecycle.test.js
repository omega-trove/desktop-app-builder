/* Day rollover and offline-queue bounds. */
const test = require('node:test');
const assert = require('node:assert');
const { readSource, slice } = require('./helpers/load-source');
const { createFakeDb } = require('./helpers/fake-idb');

/* ---------------------------------------------------------------- day key */

function loadDayLogic({ today, statsSeconds = 0, statsFails = false }) {
    const src = readSource();
    const dayKey = slice(src, 'function localDayKey', '\n}');
    const reconcile = slice(src, 'async function reconcileDailyTotal', '\n}');
    const rollover = slice(src, 'async function checkDayRollover', '\n}');

    const state = { seconds: 500, updates: 0, fetches: 0, caches: 0, now: today };

    const factory = new Function('state', `
        let seconds = state.seconds;
        let counterDayKey = null;
        const API_BASE = 'https://example.test/api';
        const Date = function () { return new global.Date(state.now); };
        Date.now = () => new global.Date(state.now).getTime();
        const updateTimerUI = () => { state.updates++; };
        const cacheDailyTotal = () => { state.caches++; };
        const console = { log() {}, warn() {} };
        const fetchWithAuth = async () => {
            state.fetches++;
            if (${statsFails}) throw new Error('offline');
            return { json: async () => ({ today_total_seconds: ${statsSeconds} }) };
        };
        ${dayKey}
        ${reconcile}
        ${rollover}
        return {
            checkDayRollover,
            setDay: (k) => { counterDayKey = k; },
            getDay: () => counterDayKey,
            read: () => seconds,
        };
    `);
    return { api: factory(state), state };
}

test('first check adopts the current day without resetting', async () => {
    const { api } = loadDayLogic({ today: '2026-08-19T10:00:00' });
    const rolled = await api.checkDayRollover();
    assert.strictEqual(rolled, false);
    assert.strictEqual(api.getDay(), '2026-08-19');
    assert.strictEqual(api.read(), 500, 'nothing should be reset on the first observation');
});

test('same day is a no-op', async () => {
    const { api, state } = loadDayLogic({ today: '2026-08-19T23:59:00' });
    api.setDay('2026-08-19');
    assert.strictEqual(await api.checkDayRollover(), false);
    assert.strictEqual(state.fetches, 0, 'must not hit the network when nothing changed');
    assert.strictEqual(api.read(), 500);
});

test('crossing midnight resets the daily total and re-fetches it', async () => {
    const { api, state } = loadDayLogic({ today: '2026-08-20T00:00:30', statsSeconds: 0 });
    api.setDay('2026-08-19');

    assert.strictEqual(await api.checkDayRollover(), true);
    assert.strictEqual(api.getDay(), '2026-08-20');
    assert.strictEqual(state.fetches, 1, 'the server is the source of truth for the new day');
    assert.strictEqual(api.read(), 0, "yesterday's total must not survive midnight");
});

test('the server value wins, not a blind zero', async () => {
    // Someone already worked 20 minutes today before the rollover was noticed.
    const { api } = loadDayLogic({ today: '2026-08-20T00:05:00', statsSeconds: 1200 });
    api.setDay('2026-08-19');
    await api.checkDayRollover();
    assert.strictEqual(api.read(), 1200);
});

test('a failed reconcile still leaves the counter reset, not stale', async () => {
    const { api } = loadDayLogic({ today: '2026-08-20T00:01:00', statsFails: true });
    api.setDay('2026-08-19');
    await api.checkDayRollover();
    assert.strictEqual(api.read(), 0, "a network failure must not leave yesterday's figure on screen");
    assert.strictEqual(api.getDay(), '2026-08-20', 'and must not retry the reset every tick');
});

/* ------------------------------------------------------------ queue caps */

function loadPrune(db) {
    const src = readSource();
    const block = slice(src, 'const MAX_SYNC_ATTEMPTS = 5;', 'async function flushOfflineQueue');
    const body = block.slice(0, block.lastIndexOf('async function flushOfflineQueue'));
    return new Function('offlineDb', 'console', `${body}; return { pruneQueue, QUEUE_CAPS };`)(
        db, { error() {}, warn() {}, log() {} }
    );
}

test('a store under its cap is untouched', async () => {
    const db = createFakeDb({ offline_screenshots: [{ id: 1, timestamp: 1 }, { id: 2, timestamp: 2 }] });
    const q = loadPrune(db);
    assert.strictEqual(await q.pruneQueue('offline_screenshots'), 0);
    assert.strictEqual(db.stores.offline_screenshots.length, 2);
});

test('an over-cap store is trimmed oldest-first', async () => {
    const cap = 50;
    const rows = Array.from({ length: cap + 12 }, (_, i) => ({ id: i + 1, timestamp: (i + 1) * 1000 }));
    const db = createFakeDb({ offline_screenshots: rows });
    const q = loadPrune(db);

    const dropped = await q.pruneQueue('offline_screenshots');

    assert.strictEqual(dropped, 12);
    assert.strictEqual(db.stores.offline_screenshots.length, cap);
    const kept = db.stores.offline_screenshots.map((r) => r.id);
    assert.strictEqual(Math.min(...kept), 13, 'the oldest rows go first');
    assert.strictEqual(Math.max(...kept), cap + 12, 'the newest evidence is kept');
});

test('out-of-order timestamps are still pruned by age', async () => {
    const rows = [
        { id: 1, timestamp: 9000 },
        { id: 2, timestamp: 1000 },  // oldest despite a later id
        { id: 3, timestamp: 5000 },
    ];
    const db = createFakeDb({ offline_activities: rows });
    const q = loadPrune(db);
    q.QUEUE_CAPS.offline_activities = 2;

    await q.pruneQueue('offline_activities');
    assert.deepStrictEqual(db.stores.offline_activities.map((r) => r.id).sort(), [1, 3]);
});

test('a store with no configured cap is never pruned', async () => {
    const db = createFakeDb({ offline_sessions: Array.from({ length: 500 }, (_, i) => ({ client_id: `s${i}` })) });
    const q = loadPrune(db);
    assert.strictEqual(await q.pruneQueue('offline_sessions'), 0);
    assert.strictEqual(db.stores.offline_sessions.length, 500, 'sessions are irreplaceable and uncapped');
});
