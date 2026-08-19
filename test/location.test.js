/* Location points must survive an outage like every other kind of telemetry.
 *
 * trackLocation() used to return early for an offline session, and a failed
 * online upload was simply dropped — so an offline stretch produced time,
 * screenshots and app activity, but no location trail at all. */
const test = require('node:test');
const assert = require('node:assert');
const { readSource, slice } = require('./helpers/load-source');
const { createFakeDb } = require('./helpers/fake-idb');

function loadLocation(db, { sessionId = 55, postFails = false, postStatus = 200 } = {}) {
    const src = readSource();
    const idb = slice(src, 'function idbRequest', 'function assertItemLevelFailure');
    const buffer = slice(src, 'async function bufferLocation', '\n}');
    const send = slice(src, 'async function sendLocationToServer', '\n}');

    const state = { posts: [] };

    const factory = new Function('offlineDb', 'state', `
        const console = { warn() {}, error() {}, log() {} };
        const API_BASE = 'https://example.test/api';
        const timeLogId = ${JSON.stringify(sessionId)};
        const pruneQueue = async () => 0;   // capped-queue behaviour is covered in lifecycle.test.js
        const fetchWithAuth = async (url, opts) => {
            state.posts.push({ url, body: JSON.parse(opts.body) });
            if (${postFails}) throw new Error('offline');
            return { ok: ${postStatus} < 400, status: ${postStatus} };
        };
        ${idb.slice(0, idb.lastIndexOf('function assertItemLevelFailure'))}
        ${buffer}
        ${send}
        return { sendLocationToServer };
    `);
    return { api: factory(db, state), state };
}

test('an online point goes straight to the server, with its capture time', async () => {
    const db = createFakeDb({ offline_locations: [] });
    const { api, state } = loadLocation(db);

    await api.sendLocationToServer(30.0444, 31.2357); // Cairo

    assert.strictEqual(state.posts.length, 1);
    assert.strictEqual(state.posts[0].body.time_log_id, 55);
    assert.strictEqual(state.posts[0].body.locations[0].latitude, 30.0444);
    assert.ok(state.posts[0].body.locations[0].captured_at, 'captured_at must be sent');
    assert.deepStrictEqual(db.stores.offline_locations, [], 'nothing to buffer when it lands');
});

test('an offline session buffers instead of posting', async () => {
    const db = createFakeDb({ offline_locations: [] });
    const { api, state } = loadLocation(db, { sessionId: 'local_9' });

    await api.sendLocationToServer(30.0444, 31.2357);

    assert.deepStrictEqual(state.posts, [], 'there is no server-side session to attach to yet');
    assert.strictEqual(db.stores.offline_locations.length, 1);
    assert.strictEqual(db.stores.offline_locations[0].time_log_id, 'local_9');
    assert.strictEqual(db.stores.offline_locations[0].latitude, 30.0444);
    assert.ok(db.stores.offline_locations[0].captured_at);
});

test('a point whose upload fails is kept, not lost', async () => {
    const db = createFakeDb({ offline_locations: [] });
    const { api } = loadLocation(db, { postFails: true });

    await api.sendLocationToServer(30.0444, 31.2357);
    assert.strictEqual(db.stores.offline_locations.length, 1);
});

test('a point the server rejects is kept for retry', async () => {
    const db = createFakeDb({ offline_locations: [] });
    const { api } = loadLocation(db, { postStatus: 503 });

    await api.sendLocationToServer(30.0444, 31.2357);
    assert.strictEqual(db.stores.offline_locations.length, 1);
});

test('the buffered capture time is preserved, not restamped on upload', () => {
    // The server honours captured_at on backfill precisely so a late backlog
    // cannot masquerade as a live position on the map.
    const drain = slice(readSource(), "await drainQueue('offline_locations'", '});');
    assert.match(drain, /captured_at: item\.captured_at/);
    assert.match(drain, /if \(String\(item\.time_log_id\)\.startsWith\('local_'\)\) throw new SyncUnavailableError\(\)/,
        'a point must wait for its session to get a real id');
});

test('queued locations are re-pointed when their offline session syncs', () => {
    const src = readSource();
    const repoint = slice(src, '// Re-point everything still addressed by a local session id.', '\n                    }');
    assert.match(repoint, /offline_screenshots/);
    assert.match(repoint, /offline_locations/, 'locations need the same id fix-up as screenshots');
});

test('offline sessions are no longer excluded from location tracking', () => {
    const guard = slice(readSource(), 'async function trackLocation', 'return;');
    assert.doesNotMatch(guard, /startsWith\('local_'\)/,
        'an offline session must still record where the work happened');
});
