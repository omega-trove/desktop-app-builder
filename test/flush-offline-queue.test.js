/* flushOfflineQueue as a whole: what it uploads, what it purges, and that only
   one run happens at a time. */
const test = require('node:test');
const assert = require('node:assert');
const { readSource, slice } = require('./helpers/load-source');
const { createFakeDb } = require('./helpers/fake-idb');

const END = "        updateSyncStatus(navigator.onLine ? 'online' : 'offline');\n    }\n}";

function loadFlush(db, { fetchImpl, online = true } = {}) {
    const src = readSource();
    const block = slice(src, 'let isFlushing = false;', END);

    const calls = { statuses: [] };
    // Every test supplies its own transport; this default only keeps the shape
    // valid if one ever forgets to.
    const fetchWithAuth = fetchImpl || (async () => ({
        ok: true, status: 200, json: async () => ({ mapped_ids: {} }),
    }));

    const factory = new Function(
        'offlineDb', 'fetchWithAuth', 'updateSyncStatus', 'navigator', 'API_BASE',
        'token', 'decryptScreenshot', 'FormData', 'console', 'calls',
        `${block}
         return { flushOfflineQueue, get isFlushing() { return isFlushing; } };`
    );

    const api = factory(
        db,
        fetchWithAuth,
        (s) => calls.statuses.push(s),
        { onLine: online },
        'https://example.test/api',
        'tok',
        async () => 'blob',
        class FormData { append() {} },
        { error() {}, warn() {}, log() {} },
        calls
    );
    return { api, calls };
}

test('an in-flight session (ended_at null) is neither uploaded nor purged', async () => {
    const db = createFakeDb({
        offline_sessions: [
            { client_id: 'local_inflight', started_at: '2026-08-19T09:00:00Z', ended_at: null, total_seconds: 0 },
        ],
    });

    const posted = [];
    const { api } = loadFlush(db, {
        fetchImpl: async (url, opts) => {
            posted.push({ url, body: opts && opts.body });
            return { ok: true, status: 200, json: async () => ({ mapped_ids: {} }) };
        },
    });

    await api.flushOfflineQueue();

    assert.strictEqual(
        posted.filter((p) => p.url.includes('sync-offline-sessions')).length,
        0,
        'the session being tracked right now must not be uploaded'
    );
    assert.strictEqual(
        db.stores.offline_sessions.length,
        1,
        'and it must still be there for stopTracking() to write its duration into'
    );
});

test('a closed session is uploaded and purged', async () => {
    const db = createFakeDb({
        offline_sessions: [
            { client_id: 'local_done', started_at: '2026-08-19T08:00:00Z', ended_at: '2026-08-19T09:00:00Z', total_seconds: 1800 },
        ],
    });

    const posted = [];
    const { api } = loadFlush(db, {
        fetchImpl: async (url, opts) => {
            posted.push({ url, body: opts && opts.body });
            return { ok: true, status: 200, json: async () => ({ mapped_ids: {} }) };
        },
    });

    await api.flushOfflineQueue();

    const sessionPost = posted.find((p) => p.url.includes('sync-offline-sessions'));
    assert.ok(sessionPost, 'a closed session should be uploaded');
    const sent = JSON.parse(sessionPost.body).sessions;
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].total_seconds, 1800, 'its accumulated seconds must survive');
    assert.deepStrictEqual(db.stores.offline_sessions, []);
});

test('a mixed queue uploads only the closed session', async () => {
    const db = createFakeDb({
        offline_sessions: [
            { client_id: 'local_done', ended_at: '2026-08-19T09:00:00Z', total_seconds: 600 },
            { client_id: 'local_inflight', ended_at: null, total_seconds: 0 },
        ],
    });

    const posted = [];
    const { api } = loadFlush(db, {
        fetchImpl: async (url, opts) => {
            posted.push({ url, body: opts && opts.body });
            return { ok: true, status: 200, json: async () => ({ mapped_ids: {} }) };
        },
    });

    await api.flushOfflineQueue();

    const sent = JSON.parse(posted.find((p) => p.url.includes('sync-offline-sessions')).body).sessions;
    assert.deepStrictEqual(sent.map((s) => s.client_id), ['local_done']);
    assert.deepStrictEqual(db.stores.offline_sessions.map((s) => s.client_id), ['local_inflight']);
});

test('overlapping flushes are serialised by the mutex', async () => {
    const db = createFakeDb({
        offline_sessions: [{ client_id: 'local_done', ended_at: '2026-08-19T09:00:00Z', total_seconds: 60 }],
    });

    let inFlight = 0;
    let maxConcurrent = 0;
    const { api } = loadFlush(db, {
        fetchImpl: async () => {
            inFlight++;
            maxConcurrent = Math.max(maxConcurrent, inFlight);
            await new Promise((r) => setTimeout(r, 40));
            inFlight--;
            return { ok: true, status: 200, json: async () => ({ mapped_ids: {} }) };
        },
    });

    await Promise.all([api.flushOfflineQueue(), api.flushOfflineQueue(), api.flushOfflineQueue()]);
    assert.strictEqual(maxConcurrent, 1, 'only one flush may be in flight at a time');
});

test('the mutex is released even when the flush throws', async () => {
    const db = createFakeDb({
        offline_sessions: [{ client_id: 'x', ended_at: '2026-08-19T09:00:00Z', total_seconds: 1 }],
    });
    const { api } = loadFlush(db, { fetchImpl: async () => { throw new Error('network down'); } });

    await api.flushOfflineQueue();
    assert.strictEqual(api.isFlushing, false, 'a thrown flush must not wedge the mutex shut');
});

test('offline short-circuits without touching the queue', async () => {
    const db = createFakeDb({ offline_sessions: [{ client_id: 'x', ended_at: '2026-08-19T09:00:00Z' }] });
    const { api, calls } = loadFlush(db, { online: false, fetchImpl: async () => { throw new Error('should not be called'); } });

    await api.flushOfflineQueue();
    assert.deepStrictEqual(calls.statuses, ['offline']);
    assert.strictEqual(db.stores.offline_sessions.length, 1);
});
