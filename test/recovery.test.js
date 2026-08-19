/* Recovering a session the previous run was killed in the middle of.
 *
 * stopTracking() covers every exit the app controls. It does not control being
 * terminated — an NSIS upgrade replacing the running app, a power cut, Task
 * Manager. /tracking/today-stats counts only sessions carrying an ended_at, so
 * an interrupted session used to disappear from the daily total completely,
 * which is why the counter read 00:00:00 after installing a new version. */
const test = require('node:test');
const assert = require('node:assert');
const { readSource, slice } = require('./helpers/load-source');
const { createFakeDb } = require('./helpers/fake-idb');

function loadRecovery(db, { stopFails = false, dbUsable = true } = {}) {
    const src = readSource();
    const idb = slice(src, 'function idbRequest', 'function assertItemLevelFailure');
    const mirror = slice(src, 'const ACTIVE_SESSION_KEY', '// Awaited by stopTracking');
    const saver = slice(src, 'async function saveOfflineStop', '\n}');

    const state = { posts: [], warnings: 0 };

    const factory = new Function('offlineDb', 'state', 'dbUsable', `
        const console = { warn() { state.warnings++; }, error() {}, log() {} };
        const API_BASE = 'https://example.test/api';
        const offlineDbReady = Promise.resolve(dbUsable);
        let timeLogId = null;
        let currentSessionSeconds = 0;
        const setInterval = () => 1;
        const clearInterval = () => {};
        const setTimeout = (fn, ms) => globalThis.setTimeout(fn, ms);
        const clearTimeout = (t) => globalThis.clearTimeout(t);
        const fetchWithAuth = async (url, opts) => {
            state.posts.push({ url, body: JSON.parse(opts.body) });
            if (${stopFails}) throw new Error('offline');
            return { ok: true };
        };
        ${idb.slice(0, idb.lastIndexOf('function assertItemLevelFailure'))}
        ${mirror.slice(0, mirror.lastIndexOf('// Awaited by stopTracking'))}
        ${saver}
        return { recoverInterruptedSession, writeActiveSession, clearActiveSession,
                 setSession: (id, secs) => { timeLogId = id; currentSessionSeconds = secs; } };
    `);
    return { api: factory(db, state, dbUsable), state };
}

test('a clean previous run leaves nothing to recover', async () => {
    const db = createFakeDb({ active_session: [], offline_stops: [] });
    const { api, state } = loadRecovery(db);

    await api.recoverInterruptedSession();
    assert.deepStrictEqual(state.posts, [], 'nothing should be sent');
    assert.deepStrictEqual(db.stores.offline_stops, []);
});

test('an interrupted server session is closed at its last heartbeat', async () => {
    const db = createFakeDb({
        active_session: [{ id: 'current', time_log_id: 77, total_seconds: 1500, updated_at: '2026-08-20T09:30:00.000Z' }],
        offline_stops: [],
    });
    const { api, state } = loadRecovery(db);

    await api.recoverInterruptedSession();

    assert.strictEqual(state.posts.length, 1);
    assert.match(state.posts[0].url, /\/tracking\/session\/77\/stop$/);
    assert.strictEqual(state.posts[0].body.total_seconds, 1500);
    assert.strictEqual(state.posts[0].body.ended_at, '2026-08-20T09:30:00.000Z',
        'it ended when the heartbeat stopped, not when we noticed');
    assert.deepStrictEqual(db.stores.active_session, [], 'the marker is consumed');
    assert.deepStrictEqual(db.stores.offline_stops, [], 'no queue entry needed, it went straight through');
});

test('if the server cannot be reached the stop is queued with the real end time', async () => {
    const db = createFakeDb({
        active_session: [{ id: 'current', time_log_id: 88, total_seconds: 600, updated_at: '2026-08-20T07:00:00.000Z' }],
        offline_stops: [],
    });
    const { api } = loadRecovery(db, { stopFails: true });

    await api.recoverInterruptedSession();

    assert.strictEqual(db.stores.offline_stops.length, 1);
    assert.deepStrictEqual(db.stores.offline_stops[0], {
        time_log_id: 88,
        total_seconds: 600,
        stopped_at: '2026-08-20T07:00:00.000Z',
    });
    assert.deepStrictEqual(db.stores.active_session, [], 'still consumed — the retry lives in the queue now');
});

test('an interrupted offline session is closed so the sync engine will take it', async () => {
    const db = createFakeDb({
        active_session: [{ id: 'current', time_log_id: 'local_1', total_seconds: 900, updated_at: '2026-08-20T11:00:00.000Z' }],
        offline_sessions: [{ client_id: 'local_1', started_at: '2026-08-20T10:00:00.000Z', ended_at: null, total_seconds: 0 }],
    });
    const { api, state } = loadRecovery(db);

    await api.recoverInterruptedSession();

    const sess = db.stores.offline_sessions[0];
    assert.strictEqual(sess.ended_at, '2026-08-20T11:00:00.000Z');
    assert.strictEqual(sess.total_seconds, 900, 'the accumulated active seconds, not the wall-clock span');
    assert.deepStrictEqual(state.posts, [], 'a local session is never stopped over the network');
});

test('an already-closed offline session is left alone', async () => {
    const db = createFakeDb({
        active_session: [{ id: 'current', time_log_id: 'local_2', total_seconds: 10, updated_at: '2026-08-20T11:00:00.000Z' }],
        offline_sessions: [{ client_id: 'local_2', ended_at: '2026-08-20T10:30:00.000Z', total_seconds: 1800 }],
    });
    const { api } = loadRecovery(db);

    await api.recoverInterruptedSession();
    assert.strictEqual(db.stores.offline_sessions[0].total_seconds, 1800, 'must not be overwritten');
});

test('the marker is consumed before the close is attempted, so it cannot replay forever', async () => {
    const db = createFakeDb({
        active_session: [{ id: 'current', time_log_id: 99, total_seconds: 60, updated_at: '2026-08-20T08:00:00.000Z' }],
        offline_stops: [],
    });
    db.failures.write.add('offline_stops'); // queueing fails too
    const { api } = loadRecovery(db, { stopFails: true });

    await api.recoverInterruptedSession();
    assert.deepStrictEqual(db.stores.active_session, []);

    // A second launch must not try again — the record is gone.
    const { state } = loadRecovery(db);
    await api.recoverInterruptedSession();
    assert.deepStrictEqual(state.posts, []);
});

test('an unusable database is skipped rather than throwing at boot', async () => {
    const { api } = loadRecovery(undefined, { dbUsable: false });
    await api.recoverInterruptedSession();
});

test('the heartbeat records the running session and stopping clears it', async () => {
    const db = createFakeDb({ active_session: [] });
    const { api } = loadRecovery(db);

    api.setSession(1234, 42);
    await api.writeActiveSession();

    assert.strictEqual(db.stores.active_session.length, 1);
    assert.strictEqual(db.stores.active_session[0].time_log_id, 1234);
    assert.strictEqual(db.stores.active_session[0].total_seconds, 42);
    assert.ok(db.stores.active_session[0].updated_at);

    await api.clearActiveSession();
    assert.deepStrictEqual(db.stores.active_session, []);
});

test('nothing is mirrored before a session has an id', async () => {
    const db = createFakeDb({ active_session: [] });
    const { api } = loadRecovery(db);

    await api.writeActiveSession(); // timeLogId is still null
    assert.deepStrictEqual(db.stores.active_session, []);
});
