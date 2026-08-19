/* Ending a session must be durable before the app is allowed to go away.
 *
 * /tracking/today-stats sums only sessions that carry an ended_at, so a stop
 * request that never completed deleted the whole session from the day's total.
 * That was the "quit the app, reopen it, timer reads 00:00:00" bug: the quit
 * path awaited stopTracking(), which returned with the request still in flight,
 * and app.exit(0) killed the renderer before it landed. */
const test = require('node:test');
const assert = require('node:assert');
const { readSource, slice } = require('./helpers/load-source');
const { createFakeDb } = require('./helpers/fake-idb');

function loadStopHelpers(db) {
    const src = readSource();
    const idb = slice(src, 'function idbRequest', 'function assertItemLevelFailure');
    const saver = slice(src, 'async function saveOfflineStop', '\n}');

    const factory = new Function('offlineDb', 'console', `
        ${idb.slice(0, idb.lastIndexOf('function assertItemLevelFailure'))}
        ${saver}
        return { saveOfflineStop, idbRequest, putInto };
    `);
    return factory(db, { error() {}, warn() {}, log() {} });
}

test('a deferred stop is committed, not merely started', async () => {
    const db = createFakeDb({ offline_stops: [] });
    const api = loadStopHelpers(db);

    await api.saveOfflineStop(4321, 1800);

    // Awaiting must be enough: nothing further may need to run for the row to
    // exist, because on the quit path the process exits straight afterwards.
    assert.strictEqual(db.stores.offline_stops.length, 1);
    assert.strictEqual(db.stores.offline_stops[0].time_log_id, 4321);
    assert.strictEqual(db.stores.offline_stops[0].total_seconds, 1800);
    assert.ok(db.stores.offline_stops[0].stopped_at, 'the stop time is recorded for the server');
});

test('a failed write is swallowed rather than blocking the exit', async () => {
    const db = createFakeDb({ offline_stops: [] });
    db.failures.write.add('offline_stops');
    const api = loadStopHelpers(db);

    await api.saveOfflineStop(1, 60); // must resolve, not reject
    assert.deepStrictEqual(db.stores.offline_stops, []);
});

test('no offline database means no crash', async () => {
    const api = loadStopHelpers(undefined);
    await api.saveOfflineStop(1, 60);
});

/* The shape of stopTracking() itself is what the bug lived in, so guard it
   structurally: the whole point is that these calls are awaited. */
test('stopTracking awaits the server stop and its offline fallback', () => {
    const body = slice(readSource(), 'async function stopTracking', '\nasync function saveOfflineStop');
    const stop = body.slice(0, body.indexOf('\n// Awaited by stopTracking'));

    assert.match(stop, /await fetchWithAuth\(`\$\{API_BASE\}\/tracking\/session\/\$\{targetLogId\}\/stop`/,
        'the session stop must be awaited, not fire-and-forget');
    assert.match(stop, /await saveOfflineStop\(targetLogId, targetSeconds\)/,
        'queueing the retry must complete before the process may exit');
    assert.match(stop, /await putInto\('offline_sessions', sess\)/,
        'closing a local session must be committed too');
});

test('logging out waits for the session to close before navigating away', () => {
    const src = readSource();
    const handler = slice(src, "document.getElementById('logoutBtn')", '\n});');

    const stopAt = handler.indexOf('await stopTracking()');
    const navAt = handler.indexOf("navigateTo('login')");
    assert.ok(stopAt !== -1, 'logout must await the stop');
    assert.ok(navAt !== -1);
    assert.ok(stopAt < navAt, 'the stop has to finish before the renderer is torn down');
});

test('the daily total survives a launch where the server cannot be reached', () => {
    const src = readSource();
    const key = slice(src, 'const DAILY_TOTAL_CACHE_KEY', ';');
    const cache = slice(src, 'function cacheDailyTotal', '\n}');
    const read = slice(src, 'function readCachedDailyTotal', '\n}');

    const store = {};
    const factory = new Function('store', `
        const localStorage = {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
        };
        let seconds = 0;
        const localDayKey = () => '2026-08-19';
        ${key}
        ${cache}
        ${read}
        return {
            write: (s) => { seconds = s; cacheDailyTotal(); },
            read: readCachedDailyTotal,
        };
    `);
    const api = factory(store);

    assert.strictEqual(api.read(), null, 'nothing cached yet');

    api.write(7200);
    assert.strictEqual(api.read(), 7200, "today's total is restored before the network is consulted");

    // A zero total is a real value on a fresh day and must survive the round trip.
    api.write(0);
    assert.strictEqual(api.read(), 0);

    // Yesterday's figure must never be shown as today's.
    store['tracker_daily_total'] = JSON.stringify({ day: '2026-08-18', seconds: 9999 });
    assert.strictEqual(api.read(), null);

    store['tracker_daily_total'] = 'not json';
    assert.strictEqual(api.read(), null, 'a corrupt cache is ignored, not thrown');
});
