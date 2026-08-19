/* Enough of IndexedDB for the drain loop: getAll / put / delete over in-memory
   stores, using the same event-callback shape as the real API so the promisified
   wrappers under test are exercised exactly as written. */
const KEY_FIELDS = {
    offline_screenshots: 'id',
    offline_activities: 'id',
    offline_stops: 'time_log_id',
    offline_sessions: 'client_id',
};

function createFakeDb(initial = {}) {
    const stores = {};
    for (const [name, rows] of Object.entries(initial)) stores[name] = rows.map((r) => ({ ...r }));

    const failures = { read: new Set(), write: new Set() };
    const keyField = (n) => KEY_FIELDS[n] || 'id';

    return {
        stores,
        failures,
        transaction(name) {
            const ops = [];
            const tx = {
                objectStore() {
                    return {
                        getAll() {
                            const req = {};
                            queueMicrotask(() => {
                                if (failures.read.has(name)) {
                                    req.error = new Error('read failed');
                                    if (req.onerror) req.onerror();
                                    return;
                                }
                                req.result = (stores[name] || []).map((r) => ({ ...r }));
                                if (req.onsuccess) req.onsuccess();
                            });
                            return req;
                        },
                        delete(key) {
                            ops.push(() => {
                                stores[name] = (stores[name] || []).filter((r) => r[keyField(name)] !== key);
                            });
                        },
                        put(value) {
                            ops.push(() => {
                                const kf = keyField(name);
                                const list = stores[name] || (stores[name] = []);
                                const i = list.findIndex((r) => r[kf] === value[kf]);
                                if (i === -1) list.push({ ...value });
                                else list[i] = { ...value };
                            });
                        },
                    };
                },
            };
            queueMicrotask(() => {
                if (failures.write.has(name)) {
                    tx.error = new Error('write failed');
                    if (tx.onerror) tx.onerror();
                    return;
                }
                ops.forEach((op) => op());
                if (tx.oncomplete) tx.oncomplete();
            });
            return tx;
        },
    };
}

module.exports = { createFakeDb, KEY_FIELDS };
