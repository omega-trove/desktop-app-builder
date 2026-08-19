/* The offline drain must not lose data, must not stall on one bad item, and
   must not quarantine a healthy queue when the server is simply down. */
const test = require('node:test');
const assert = require('node:assert');
const { readSource, slice } = require('./helpers/load-source');
const { createFakeDb } = require('./helpers/fake-idb');

function loadQueue(db) {
    const src = readSource();
    const block = slice(src, 'const MAX_SYNC_ATTEMPTS = 5;', 'async function flushOfflineQueue');
    const body = block.slice(0, block.lastIndexOf('async function flushOfflineQueue'));

    const factory = new Function(
        'offlineDb',
        'console',
        `
        ${body}
        return { drainQueue, recordItemFailure, assertItemLevelFailure, SyncUnavailableError,
                 readAll, removeFrom, putInto, MAX_SYNC_ATTEMPTS };
        `
    );
    return factory(db, { error() {}, warn() {}, log() {} });
}

test('a synced item is purged from the queue', async () => {
    const db = createFakeDb({ offline_activities: [{ id: 1 }, { id: 2 }] });
    const q = loadQueue(db);

    await q.drainQueue('offline_activities', 'id', async () => {});
    assert.deepStrictEqual(db.stores.offline_activities, []);
});

test('one rejected item does not block the rest of the queue', async () => {
    const db = createFakeDb({ offline_activities: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const q = loadQueue(db);

    const sent = [];
    await q.drainQueue('offline_activities', 'id', async (item) => {
        sent.push(item.id);
        if (item.id === 2) throw new Error('undecryptable'); // item-level failure
    });

    // The old implementation broke out of the loop here and never reached 3.
    assert.deepStrictEqual(sent, [1, 2, 3]);
    assert.deepStrictEqual(db.stores.offline_activities.map((r) => r.id), [2]);
    assert.strictEqual(db.stores.offline_activities[0].sync_attempts, 1);
});

test('a persistently rejected item is dropped after the attempt limit', async () => {
    const db = createFakeDb({ offline_activities: [{ id: 7 }] });
    const q = loadQueue(db);

    for (let i = 0; i < q.MAX_SYNC_ATTEMPTS; i++) {
        await q.drainQueue('offline_activities', 'id', async () => { throw new Error('rejected'); });
    }
    assert.deepStrictEqual(db.stores.offline_activities, [], 'poison item should be quarantined');
});

test('a server outage does not consume retries or drop anything', async () => {
    const db = createFakeDb({ offline_activities: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const q = loadQueue(db);

    for (let i = 0; i < q.MAX_SYNC_ATTEMPTS + 3; i++) {
        await q.drainQueue('offline_activities', 'id', async () => {
            throw new q.SyncUnavailableError();
        });
    }

    assert.strictEqual(db.stores.offline_activities.length, 3, 'nothing may be dropped while the server is down');
    for (const row of db.stores.offline_activities) {
        assert.strictEqual(row.sync_attempts, undefined, 'an outage is not the item\'s fault');
    }
});

test('an outage abandons the cycle rather than hammering every item', async () => {
    const db = createFakeDb({ offline_activities: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const q = loadQueue(db);

    let attempts = 0;
    await q.drainQueue('offline_activities', 'id', async () => {
        attempts++;
        throw new q.SyncUnavailableError();
    });
    assert.strictEqual(attempts, 1, 'should stop at the first transport failure');
});

test('assertItemLevelFailure treats 5xx as transport, 4xx as the item', () => {
    const q = loadQueue(createFakeDb());
    assert.throws(() => q.assertItemLevelFailure({ status: 503 }), q.SyncUnavailableError);
    assert.throws(() => q.assertItemLevelFailure(null), q.SyncUnavailableError);
    assert.doesNotThrow(() => q.assertItemLevelFailure({ status: 422 }));
});

test('a failed IndexedDB read settles instead of hanging', async () => {
    const db = createFakeDb({ offline_activities: [{ id: 1 }] });
    db.failures.read.add('offline_activities');
    const q = loadQueue(db);

    // The old code awaited a promise with no reject path and no onerror, so this
    // never returned and every later flush piled up behind it.
    await assert.doesNotReject(
        Promise.race([
            q.drainQueue('offline_activities', 'id', async () => {}),
            new Promise((_, rej) => setTimeout(() => rej(new Error('drain hung')), 1000)),
        ])
    );
});
