let API_BASE = 'https://hrm.omegatrack.ai/api';
let isTracking = false;
let timeLogId = null;
let seconds = 0;
let currentSessionSeconds = 0;

// Wall-clock anchor for the counter. `seconds` used to be a count of how many
// times a 1s interval had fired, which is not the same thing as elapsed time:
// every tick carries scheduling latency, and under load or while the machine is
// asleep ticks are dropped entirely. The error only ever accumulates in one
// direction, and because the server clamps a reported duration to
// min(clientSeconds, wallClock) the short client value always won — so the drift
// came out of the employee's paid time. The counter is now derived from
// Date.now() deltas, with the sub-second remainder carried between ticks.
let lastTickMs = null;
let tickRemainderMs = 0;
// A delta larger than this means the machine slept, hibernated or froze rather
// than that the user worked through it. Discarding it preserves the behaviour of
// the old tick counter (no ticks fired while suspended) without pretending the
// time was worked. Genuine sleep/wake handling is tracked separately.
const MAX_TICK_DELTA_MS = 90000;

// The calendar day the daily counter currently represents. The counter was only
// ever re-baselined at launch or on a manual start, so an app left running over
// midnight kept yesterday's total on the clock indefinitely — the server-side
// day-window fix corrected which sessions belong to today, but nothing told a
// long-running client that the day had turned.
//
// Detection uses the CLIENT's local date, while the authoritative daily total is
// whatever the server returns for its own company-timezone day. Those can
// disagree by the UTC offset, so the transition is a trigger to re-fetch, never
// a source of truth: the value always comes from /tracking/today-stats.
let counterDayKey = null;

function localDayKey(date) {
    const d = date || new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
let dailyTargetHours = 8.0;
let uiInterval = null;
let trackingInterval = null;
let rulesRefreshInterval = null;
let taskListInterval = null;      // always-on periodic refresh of the task dropdown
let offlineSessionStartTime = null;

// ── HRM → Desktop timer sync ────────────────────────────────────────────────
// externalTimeLogId is the HRM-created time_log_id we are currently *mirroring*
// (a timer started from the web app). It is null whenever we are idle or running
// a manual desktop session that we own ourselves. We only ever auto-stop / switch
// a session when this is non-null, so a manual session is never disturbed.
let externalTimeLogId = null;
let timerCommandInterval = null;  // always-on 5s poll of /tracking/timer-command
let timerSyncBusy = false;        // reentrancy guard so overlapping polls can't race

// Flip to true (or set localStorage 'timer_sync_debug' = '1' and reload) to log
// every sync decision to the DevTools console during live testing.
const TIMER_SYNC_DEBUG = (typeof localStorage !== 'undefined' && localStorage.getItem('timer_sync_debug') === '1');
function syncLog(...args) { if (TIMER_SYNC_DEBUG) console.log('%c[timer-sync]', 'color:#4f46e5;font-weight:bold', ...args); }

// Live Streaming Engine Params
let streamActive = false;
let streamInterval = null;
let shouldStreamCheckInterval = null;
let currentPollRate = 10000; // Default to 10s when idle/not streaming

// WebRTC Streaming Params
let webrtcPeerConnection = null;
let webrtcStream = null;
let activeScreenIndex = 0;
let isStreaming = false;

// Anti Cheat Engine Params
let antiCheatInterval = null;
let antiCheatCountdownInterval = null;
let expectedCaptcha = '';
let lastLocationTrackTime = 0;

// Persistent Distraction Blocker Params
// distractionGuardInterval runs continuously (independent of the tracking
// timer) so a Distracting app is force-closed every time it is reopened.
let distractionGuardInterval = null;
let distractionLockShown = false;      // a warning overlay is currently up
let distractionBusy = false;           // re-entrancy guard for the async tick
let lastViolationReportAt = 0;         // throttle /tracking/violation spam

// Adaptive Anti-Cheat Params
let lastKeyboardInputTime = Date.now();
let lastMouseActivityTime = Date.now();
let adaptiveAntiCheatInterval = null;

// Dynamic Prohibited Apps BlockList
let blockList = ['netflix', 'facebook', 'youtube', 'مباراة', 'game'];

// Parse tenant configuration dynamically
let IDLE_TIMEOUT_SECONDS = parseInt(localStorage.getItem('tracker_idle_timeout') || 300); // Defaults to 5 minutes (300 seconds)
let IDLE_TIMEOUT_MINUTES = Math.ceil(IDLE_TIMEOUT_SECONDS / 60);

// Initialize Offline Sync Database
let offlineDb;
const request = indexedDB.open("OmegaTrackerDB", 4);
request.onupgradeneeded = event => {
    offlineDb = event.target.result;
    if (!offlineDb.objectStoreNames.contains('offline_screenshots')) {
        offlineDb.createObjectStore('offline_screenshots', { keyPath: 'id', autoIncrement: true });
    }
    if (!offlineDb.objectStoreNames.contains('offline_sessions')) {
        offlineDb.createObjectStore('offline_sessions', { keyPath: 'client_id' });
    }
    if (!offlineDb.objectStoreNames.contains('offline_activities')) {
        offlineDb.createObjectStore('offline_activities', { keyPath: 'id', autoIncrement: true });
    }
    if (!offlineDb.objectStoreNames.contains('offline_stops')) {
        offlineDb.createObjectStore('offline_stops', { keyPath: 'time_log_id' });
    }
};
request.onsuccess = event => {
    offlineDb = event.target.result;
    setInterval(flushOfflineQueue, 20000); // Attempt sync every 20 seconds
};

// On a full exit (X → "Exit completely" or tray Exit), main asks us to flush the
// offline queue first, then we tell it to finish the teardown.
if (window.electronAPI && window.electronAPI.onFlushAndQuit) {
    window.electronAPI.onFlushAndQuit(async () => {
        try {
            if (isTracking) { await stopTracking(); }  // properly end the active session first
            await flushOfflineQueue();                 // then push anything still queued
        } catch (e) { /* never block exit */ }
        window.electronAPI.confirmClose();
    });
}

// Initialize Identity
let token = null;

document.getElementById('userNameLabel').innerText = localStorage.getItem('user_name') || 'Team Member';

document.getElementById('logoutBtn').addEventListener('click', () => {
    if(isTracking) stopTracking();
    // Release any active distraction lock and stop the guard before leaving the
    // tracker, so the login screen is never left in a locked/always-on-top state.
    try { dismissDistractionWarning(); } catch (e) {}
    if (distractionGuardInterval) { clearInterval(distractionGuardInterval); distractionGuardInterval = null; }
    if (rulesRefreshInterval) { clearInterval(rulesRefreshInterval); rulesRefreshInterval = null; }
    if (timerCommandInterval) { clearInterval(timerCommandInterval); timerCommandInterval = null; }
    if (taskListInterval) { clearInterval(taskListInterval); taskListInterval = null; }
    externalTimeLogId = null;
    localStorage.removeItem('user_name');
    window.electronAPI.clearToken();
    window.electronAPI.navigateTo('login');
});

const getHeaders = () => ({
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
});

async function fetchWithAuth(url, options = {}) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        ...options.headers
    };
    if (!(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
    }
    options.headers = headers;

    // Hard timeout so a stalled connection (TCP opens but the server / proxy /
    // VPN never sends a response) can never hang the caller forever. Without this
    // a single pending request leaves the UI frozen with no error — e.g. pressing
    // Start would do nothing at all because startTracking() awaits this call before
    // it shows any feedback or starts the timer. On timeout we abort, which rejects
    // the fetch and lets callers fall into their offline path.
    const { timeoutMs = 15000, ...fetchOptions } = options;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    if (!fetchOptions.signal) fetchOptions.signal = controller.signal;

    let res;
    try {
        res = await fetch(url, fetchOptions);
    } finally {
        clearTimeout(timeoutId);
    }
    if (res.status === 401) {
        console.warn('Session expired or unauthorized. Redirecting to login...');
        if (isTracking) {
            try {
                await stopTracking();
            } catch (e) {
                console.error('Error stopping tracking during 401 redirect:', e);
            }
        }
        localStorage.removeItem('user_name');
        if (window.electronAPI) {
            window.electronAPI.clearToken();
            window.electronAPI.navigateTo('login');
        }
        throw new Error('Session expired. Please log in again.');
    }
    return res;
}

// Fetch current day time from server on boot
async function initDailyTime() {
    // Attempt local target bounds extraction from memory if offline
    let storedTarget = localStorage.getItem('daily_target_hours');
    if(storedTarget) dailyTargetHours = parseFloat(storedTarget);

    try {
        const res = await fetchWithAuth(`${API_BASE}/tracking/today-stats`);
        const data = await res.json();
        
        if (data.daily_target_hours) {
            dailyTargetHours = data.daily_target_hours;
            localStorage.setItem('daily_target_hours', dailyTargetHours);
        }
        if (data.tracker_idle_timeout) {
            localStorage.setItem('tracker_idle_timeout', data.tracker_idle_timeout);
            IDLE_TIMEOUT_SECONDS = parseInt(data.tracker_idle_timeout);
            IDLE_TIMEOUT_MINUTES = Math.ceil(IDLE_TIMEOUT_SECONDS / 60);
        }
        if (data.tracker_anticheat_interval) {
            localStorage.setItem('tracker_anticheat_interval', data.tracker_anticheat_interval);
        }
        
        // Must be a type check, not a truthiness check: on the first launch of a
        // new day the server legitimately reports 0, and `if (0)` would skip the
        // assignment and leave yesterday's total on the clock.
        if (typeof data.today_total_seconds === 'number') {
            seconds = data.today_total_seconds;
            counterDayKey = localDayKey();
        }
        updateTimerUI();
    } catch(e) {
        console.warn('Could not sync initial time (Network down), relying on local cache.', e);
        updateTimerUI();
    }
}

// Fetches the assigned task list and rebuilds the dropdown IN PLACE, preserving
// whatever the user (or the HRM sync) currently has selected. Runs on boot and
// on a short always-on interval (see startTaskListSync), so a task created in the
// web app shows up here within seconds — no app restart required.
async function loadTasks() {
    try {
        const res = await fetchWithAuth(`${API_BASE}/tracking/tasks`);
        const tasks = await res.json();

        const select = document.getElementById('taskSelect');
        if (!select) return;

        // Remember the current selection so a periodic refresh never yanks the
        // task out from under an in-progress session or a mid-selection user.
        const prevValue = select.value;
        const prevSelected = select.options[select.selectedIndex] || null;
        const prevText = prevSelected ? prevSelected.text : '';

        // Keep only "-- Choose Task --" and "General Work"
        while (select.options.length > 2) {
            select.remove(2);
        }

        let matchedPrev = false;
        if (Array.isArray(tasks)) {
            tasks.forEach(task => {
                const opt = document.createElement('option');
                opt.value = String(task.id);
                opt.text = `${task.title} [${task.priority}]`;
                select.add(opt);
                if (opt.value === prevValue) matchedPrev = true;
            });
        }

        // Restore the previous selection. If it was a real task id that the fresh
        // list no longer contains (e.g. an HRM-mirrored task not in "my tasks", or
        // one just marked done elsewhere), re-inject it so the active session's
        // label is never lost while it is still running/selected.
        if (prevValue && prevValue !== '' && prevValue !== 'general_work' && !matchedPrev) {
            const keep = document.createElement('option');
            keep.value = prevValue;
            keep.text = prevText || prevValue;
            select.add(keep);
        }
        if (prevValue !== null && prevValue !== undefined) {
            select.value = prevValue;
        }
    } catch (e) {
        console.error('Failed to load tasks:', e);
    }
}

// Poll the task list on a short interval so newly-created web tasks appear in the
// dropdown live. Selection is preserved by loadTasks(), so this is safe to run
// even while a session is active.
function startTaskListSync() {
    if (taskListInterval) clearInterval(taskListInterval);
    taskListInterval = setInterval(loadTasks, 20000);
}

// Add task selection listener
document.getElementById('taskSelect').addEventListener('change', (e) => {
    const titleInput = document.getElementById('taskTitle');
    if (!titleInput) return;
    if (e.target.value === 'general_work' || e.target.value === '') {
        titleInput.disabled = false;
        titleInput.value = '';
    } else {
        const selectedOption = e.target.options[e.target.selectedIndex];
        titleInput.value = selectedOption.text.split(' [')[0];
        titleInput.disabled = true;
    }
});

// ── HRM → Desktop timer sync helpers ────────────────────────────────────────

// Select a task in the dropdown by id, refreshing the list once if it isn't
// there yet, and injecting a temporary option as a last resort so the UI always
// reflects what HRM is tracking. taskId === null means "no specific task".
async function selectTaskInDropdown(taskId, taskTitle) {
    const select = document.getElementById('taskSelect');
    const titleInput = document.getElementById('taskTitle');
    if (!select) return;

    const pick = () => {
        const opt = Array.from(select.options).find(o => o.value === String(taskId));
        if (opt) { select.value = opt.value; return true; }
        return false;
    };

    if (taskId === null || taskId === undefined) {
        select.value = '';
    } else if (!pick()) {
        try { await loadTasks(); } catch (e) { /* offline — fall through */ }
        if (!pick()) {
            const tmp = document.createElement('option');
            tmp.value = String(taskId);
            tmp.text = (taskTitle || 'Task') + ' [HRM]';
            select.add(tmp);
            select.value = String(taskId);
        }
    }

    if (titleInput) {
        titleInput.value = taskTitle || '';
        titleInput.disabled = true;
    }
}

// Revert the task picker to the "-- Choose Task --" state after an HRM stop.
function resetTaskSelectionUI() {
    const select = document.getElementById('taskSelect');
    const titleInput = document.getElementById('taskTitle');
    if (select) select.value = '';
    if (titleInput) { titleInput.value = ''; titleInput.disabled = false; }
}

// Point the task picker at "General Work" (no specific task) so the follow-up
// startTracking() opens a desktop-owned General Work session. Falls back to the
// blank "-- Choose Task --" value if the General Work option isn't present; both
// resolve to a null task_id in startTracking().
function selectGeneralWorkInDropdown() {
    const select = document.getElementById('taskSelect');
    const titleInput = document.getElementById('taskTitle');
    if (select) {
        const hasGeneral = Array.from(select.options).some(o => o.value === 'general_work');
        select.value = hasGeneral ? 'general_work' : '';
    }
    if (titleInput) { titleInput.value = ''; titleInput.disabled = false; }
}

// One tick of the HRM → Desktop sync. The server's timer-command endpoint is the
// single source of truth; we simply reconcile our local state to it.
async function pollTimerCommand() {
    if (!token || timerSyncBusy) return;
    timerSyncBusy = true;
    try {
        const res = await fetchWithAuth(`${API_BASE}/tracking/timer-command`, { timeoutMs: 8000 });
        if (!res.ok) { syncLog('poll skipped — HTTP', res.status); return; }
        const cmd = await res.json();
        syncLog('poll →', cmd, `| local: isTracking=${isTracking} external=${externalTimeLogId}`);

        if (cmd.action === 'start') {
            // Idempotent: already mirroring this exact HRM session → do nothing.
            if (externalTimeLogId === cmd.time_log_id) {
                syncLog('start: already mirroring', cmd.time_log_id, '→ no-op (idempotent)');
                return;
            }

            // A new HRM session, or a task switch to a different time_log_id. If we
            // are currently tracking anything, tear it down WITHOUT re-stopping it
            // on the server (the web start already closed the previous log), then
            // attach to the new one. This is the graceful task-switch transition.
            if (isTracking) {
                syncLog(externalTimeLogId !== null
                    ? `start: switching mirror ${externalTimeLogId} → ${cmd.time_log_id} (stop-skip + reattach)`
                    : `start: HRM overrode a manual session → detaching (stop-skip) then attaching ${cmd.time_log_id}`);
                await stopTracking({ skipServerStop: true });
            } else {
                syncLog('start: attaching to HRM session', cmd.time_log_id, `(task "${cmd.task_title}")`);
            }
            await selectTaskInDropdown(cmd.task_id, cmd.task_title);
            await startTracking({ attachTimeLogId: cmd.time_log_id });
            syncLog('start: attached ✓ external=', externalTimeLogId);

        } else if (cmd.action === 'stop') {
            // A web/slack TASK timer was stopped (or ended) server-side. We only
            // react while we were MIRRORING it (externalTimeLogId set) — a manual
            // desktop session reports as 'none', never 'stop', so a local session
            // is never touched here.
            //
            // Product decision: stopping a task on the web must NOT halt the
            // desktop timer. So we detach from the (already-closed) task session
            // WITHOUT re-stopping it on the server, then seamlessly CONTINUE on a
            // fresh, desktop-owned General Work session. The big timer keeps
            // counting; only the task association is dropped.
            if (externalTimeLogId !== null) {
                syncLog('stop: web ended task session', externalTimeLogId, '→ detaching + continuing as General Work');
                await stopTracking({ skipServerStop: true });
                selectGeneralWorkInDropdown();
                // New local session (source=desktop) → timer-command returns
                // 'none' next tick, so this does not loop back on itself.
                // keepSeconds: hand the daily counter over untouched so it flows
                // continuously instead of snapping back by the poll-gap seconds.
                await startTracking({ keepSeconds: true });
                syncLog('stop: now tracking General Work locally (external=', externalTimeLogId, ')');
            } else {
                syncLog('stop: not mirroring anything → no-op');
            }
        } else {
            // action === 'none' (manual desktop session / legacy null row): do nothing.
            syncLog('none: manual/legacy session → no-op (staying out of the way)');
        }
    } catch (e) {
        // Transient network error — the next tick self-heals. Never throw here.
        syncLog('poll error (will retry next tick):', e && e.message);
    } finally {
        timerSyncBusy = false;
    }
}

// Always-on 5s poll so an HRM-started timer is picked up even while idle.
function startTimerCommandSync() {
    if (timerCommandInterval) clearInterval(timerCommandInterval);
    timerCommandInterval = setInterval(pollTimerCommand, 5000);
    pollTimerCommand(); // fire immediately on boot
}

// ── macOS permission pre-flight (renderer side) ─────────────────────────────
// No-op on Windows/Linux. On macOS: shows a one-time native guided dialog when
// Screen Recording / Accessibility are missing, plus a persistent banner with
// deep-link buttons so the user can fix it and re-check without restarting.
let macPermsPrompted = false;

function removePermissionBanner() {
    const el = document.getElementById('macPermBanner');
    if (el) el.remove();
}

function renderPermissionBanner(status) {
    const ar = (typeof currentLocale !== 'undefined' && currentLocale === 'ar');
    removePermissionBanner();

    const bar = document.createElement('div');
    bar.id = 'macPermBanner';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#b91c1c;color:#fff;'
        + 'padding:10px 14px;font-size:13px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;'
        + 'box-shadow:0 2px 8px rgba(0,0,0,.3);' + (ar ? 'direction:rtl;' : '');

    const msg = document.createElement('span');
    msg.style.cssText = 'flex:1;min-width:200px;';
    msg.textContent = ar
        ? '⚠️ أذونات macOS مطلوبة — بعض ميزات التتبع معطّلة حتى تفعيلها.'
        : '⚠️ macOS permissions needed — some tracking features are disabled until granted.';
    bar.appendChild(msg);

    const mkBtn = (label, onClick) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = 'background:#fff;color:#b91c1c;border:none;border-radius:6px;padding:6px 10px;'
            + 'font-size:12px;font-weight:600;cursor:pointer;';
        b.addEventListener('click', onClick);
        return b;
    };

    if (status.screen !== 'granted') {
        bar.appendChild(mkBtn(ar ? 'تسجيل الشاشة' : 'Screen Recording',
            () => window.electronAPI.openPrivacyPane('screen')));
    }
    if (!status.accessibility) {
        bar.appendChild(mkBtn(ar ? 'الإتاحة' : 'Accessibility',
            () => window.electronAPI.openPrivacyPane('accessibility')));
    }
    bar.appendChild(mkBtn(ar ? 'إعادة الفحص' : 'Re-check', () => initMacPermissions()));

    document.body.appendChild(bar);
}

async function initMacPermissions() {
    if (!window.electronAPI || !window.electronAPI.checkMacPermissions) return;
    let status;
    try { status = await window.electronAPI.checkMacPermissions(); } catch (e) { return; }
    if (!status || !status.isMac) return; // Windows/Linux: nothing to do

    if (status.ok) { removePermissionBanner(); return; }

    // Native guided dialog once per launch; the banner persists for follow-up.
    if (!macPermsPrompted) {
        macPermsPrompted = true;
        try { await window.electronAPI.guideMacPermissions(); } catch (e) {}
    }
    renderPermissionBanner(status);
}

// Re-check when the user returns to the app (e.g. after toggling a permission in
// System Settings), so the banner clears itself without a restart.
window.addEventListener('focus', () => { initMacPermissions(); });

async function boot() {
    token = await window.electronAPI.getToken();
    if (!token) {
        window.electronAPI.navigateTo('login');
        return;
    }

    try {
        const base = await window.electronAPI.getApiBase();
        if (base) {
            API_BASE = base.startsWith('http') ? base.replace(/\/$/, '') : 'https://' + base.replace(/\/$/, '');
            console.log('✅ API_BASE loaded:', API_BASE);
        }
        await initDailyTime();
        await loadTasks();
        await loadDistractingApps();
        initFocusMode();
        startTrackerReminder();
    } catch (e) {
        console.error('❌ Failed to load API_BASE config:', e);
        await initDailyTime();
        await loadTasks();
        await loadDistractingApps();
        initFocusMode();
        startTrackerReminder();
    }

    // Keep the rule set fresh and the distraction guard interval armed. The guard
    // only enforces while a tracking session is live (see enforceDistractionBlock),
    // so arming it here is safe even before the user starts tracking.
    if (rulesRefreshInterval) clearInterval(rulesRefreshInterval);
    rulesRefreshInterval = setInterval(loadDistractingApps, 30000);
    startDistractionGuard();

    // Keep the task dropdown in sync with the web app so tasks created there show
    // up here within seconds instead of only after a full restart.
    startTaskListSync();

    // Start mirroring HRM-initiated timers (web → desktop). Always-on, so a timer
    // started from the web app is followed even when the desktop is sitting idle.
    startTimerCommandSync();

    // macOS: verify Screen Recording / Accessibility are granted and guide the
    // user if not. No-op on Windows/Linux.
    initMacPermissions();
}
boot();

async function checkStreamStatus() {
    if (!isTracking) return;
    try {
        const response = await fetchWithAuth(`${API_BASE}/tracking/should-stream`);
        const data = await response.json();
        const stream_active = data.stream_active;
        const webrtc_request = data.webrtc_request;
        
        // Enforce Meeting Mode Limit
        const toggle = document.getElementById('meetingModeToggle');
        if (data.meeting_mode_limit_exceeded) {
            if (toggle) {
                if (toggle.checked) {
                    toggle.checked = false;
                    console.warn("Meeting mode limit reached for today. Disabling meeting mode.");
                    showToast("Meeting mode limit reached for today! Mode disabled.", { variant: 'warn' });
                }
                toggle.disabled = true;
            }
        } else {
            if (toggle) toggle.disabled = false;
        }

        // Handle Remote Commands (e.g. switch active screen or click)
        if (data.remote_commands && data.remote_commands.length > 0) {
            data.remote_commands.forEach(cmd => {
                if (cmd.type === 'switch_screen') {
                    console.log(`WebRTC Remote Command: Switch screen to index ${cmd.screen}`);
                    activeScreenIndex = parseInt(cmd.screen);
                    if (isStreaming) {
                        initiateWebRTCStream(); // Restart stream with the new screen
                    }
                } else if (cmd.type === 'click') {
                    const xPercent = parseFloat(cmd.x_percent) || 0;
                    const yPercent = parseFloat(cmd.y_percent) || 0;
                    const x = Math.round(xPercent * window.screen.width);
                    const y = Math.round(yPercent * window.screen.height);
                    console.log(`WebRTC Remote Click: Simulating mouse click at ${x}, ${y}`);
                    if (window.electronAPI && window.electronAPI.simulateMouseClick) {
                        window.electronAPI.simulateMouseClick(x, y);
                    }
                }
            });
        }

        streamActive = stream_active;
        if (streamActive) {
            startMjpegStream();
        } else {
            stopMjpegStream();
        }

        if (webrtc_request && !isStreaming) {
            initiateWebRTCStream();
        } else if (!stream_active && isStreaming) {
            stopWebRTCStream();
        }

        // Adaptive Polling Rate: Poll faster (3s) when active, slower (10s) when idle
        const targetRate = (streamActive || isStreaming || webrtc_request) ? 3000 : 10000;
        if (targetRate !== currentPollRate) {
            currentPollRate = targetRate;
            startStreamPolling(); // Re-arm interval with new rate
        }
    } catch(e) {
        console.error('should-stream error:', e);
    }
}

function startStreamPolling() {
    if (shouldStreamCheckInterval) clearInterval(shouldStreamCheckInterval);
    shouldStreamCheckInterval = setInterval(checkStreamStatus, currentPollRate);
}

// options.attachTimeLogId : when set, ATTACH to an HRM-created session instead of
//   creating a new one — we adopt that time_log_id and never call session/start
//   (doing so would spawn a duplicate log and break the sync loop).
async function startTracking(options = {}) {
    if (isTracking) return;
    const attachTimeLogId = options.attachTimeLogId ?? null;
    // options.keepSeconds : when true, DON'T snap the big daily counter back to the
    //   server's completed-only total on session start. Used by the seamless
    //   "web task Stop → continue as General Work" hand-off, where the server total
    //   lags by the ~5s poll gap and snapping to it makes the timer jump backwards.
    const keepSeconds = options.keepSeconds === true;
    isTracking = true;
    if (window.electronAPI && window.electronAPI.setTrackingActive) {
        window.electronAPI.setTrackingActive(true);   // close (X) now hides & keeps tracking
    }
    remindersMuted = false;
    stopTrackerReminder();
    if (window.electronAPI && window.electronAPI.closeReminderWindow) {
        window.electronAPI.closeReminderWindow();
    }
    
    const trackBtn = document.getElementById('trackBtn');
    if (trackBtn) trackBtn.disabled = true;
    
    // Clear any existing leftover intervals to avoid duplicates
    stopCounterTicking();
    if (trackingInterval) clearInterval(trackingInterval);
    if (shouldStreamCheckInterval) clearInterval(shouldStreamCheckInterval);
    if (streamInterval) clearInterval(streamInterval);
    if (antiCheatInterval) clearTimeout(antiCheatInterval);
    if (antiCheatCountdownInterval) clearInterval(antiCheatCountdownInterval);

    try {
        const taskSelect = document.getElementById('taskSelect');
        const taskId = taskSelect && taskSelect.value !== 'general_work' && taskSelect.value !== '' ? parseInt(taskSelect.value) : null;
        const taskTitle = document.getElementById('taskTitle').value || __('general_task');
        currentSessionSeconds = 0; // Reset session time

        // Optimistic UI + timer: flip the controls and START COUNTING immediately,
        // BEFORE the network round-trip. The session-start request below is
        // best-effort — it can be slow, time out, or fail while offline — and none
        // of that must delay the visible feedback. Previously every UI change and
        // the timer ran only AFTER awaiting the server, so a stalled request made
        // pressing Start look completely dead. timeLogId / seconds are reconciled
        // once the server (or the offline fallback) responds.
        if (taskSelect) taskSelect.disabled = true;
        document.getElementById('taskTitle').disabled = true;
        if (trackBtn) {
            trackBtn.classList.add('active');
            document.getElementById('btnIcon').innerText = '⏸';
            document.getElementById('btnText').innerText = __('btn_stop');
            trackBtn.disabled = false;
        }
        document.getElementById('statusText').innerText = __('tracking_active');
        startCounterTicking();

        if (attachTimeLogId !== null) {
            // ATTACH MODE (HRM → Desktop sync): the server already created this
            // session when the user pressed Start in the web app. We adopt its
            // time_log_id for all screenshot/activity uploads and DO NOT call
            // session/start — a second session would duplicate the log and flip
            // the sync endpoint to `none`, orphaning the HRM timer.
            timeLogId = attachTimeLogId;
            externalTimeLogId = attachTimeLogId;
            document.getElementById('statusText').innerText = __('tracking_active');

            // Attach skips session/start (where `seconds` is normally reconciled),
            // so pull today's total explicitly to keep the daily counter accurate
            // in the UI while mirroring. Best-effort — the live uiInterval keeps
            // ticking regardless if this fails.
            try {
                const statsRes = await fetchWithAuth(`${API_BASE}/tracking/today-stats`, { timeoutMs: 8000 });
                const stats = await statsRes.json();
                if (typeof stats.today_total_seconds === 'number') {
                    seconds = stats.today_total_seconds;
                }
            } catch (e) {
                console.warn('today-stats refresh on attach failed (keeping current value):', e && e.message);
            }
        } else {
            // MANUAL/LOCAL SESSION — we own it. Clear any external-mirror marker.
            externalTimeLogId = null;

            // Network session start (best-effort; reconciles state when it returns).
            try {
                const response = await fetchWithAuth(`${API_BASE}/tracking/session/start`, {
                    method: 'POST',
                    body: JSON.stringify({ project_id: null, task_id: taskId, task_title: taskTitle })
                });
                const data = await response.json();
                if(!response.ok) throw new Error(data.message || 'Failed to start session');

                timeLogId = data.time_log_id;
                // Keep the daily counter flowing on a seamless auto-continue; only a
                // fresh manual start reconciles to the authoritative today total.
                if (!keepSeconds) {
                    // `|| seconds` would reject a legitimate 0 at the start of a
                    // new day and keep the previous day's total (see loadInitialTime).
                    seconds = typeof data.today_total_seconds === 'number'
                        ? data.today_total_seconds
                        : seconds;
                }
                document.getElementById('statusText').innerText = __('tracking_active');

            } catch(netErr) {
                console.warn("Offline! creating shadow local session", netErr);
                // Secure client UUID bound to precise timestamp and random noise
                timeLogId = 'local_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
                offlineSessionStartTime = new Date().toISOString();
                document.getElementById('statusText').innerText = __('offline_tracking_active');

                // Insert unclosed session record locally
                if(offlineDb) {
                    const tx = offlineDb.transaction('offline_sessions', 'readwrite');
                    tx.objectStore('offline_sessions').put({
                        client_id: timeLogId,
                        task_id: taskId,
                        task_title: taskTitle,
                        started_at: offlineSessionStartTime,
                        ended_at: null,
                        total_seconds: 0
                    });
                }
            }
        }

        
        // Background interval (Runs every 1 minute)
        trackingInterval = setInterval(async () => {
            // Midnight may have passed since the last tick.
            await checkDayRollover();

            const inMeeting = document.getElementById('meetingModeToggle') && document.getElementById('meetingModeToggle').checked;

            // Check native Idle Time
            try {
                const idleSeconds = await window.electronAPI.getIdleTime();
                if (idleSeconds > IDLE_TIMEOUT_SECONDS && !inMeeting) {
                    console.log(`User idle for ${idleSeconds}s. Stopping tracker automatically.`);
                    showToast(__('idle_stopped', IDLE_TIMEOUT_MINUTES), { variant: 'warn' });
                    stopTracking();
                    return; // Exit the loop
                }
            } catch(e) {}

            syncTelemetry();

            // (A decorative progress bar used to be driven by Math.random() here,
            // "to simulate health activity". It signified nothing and is gone;
            // the real daily progress bar is updated by updateTimerUI().)
        }, 60000);
        // -------------------------
        // LIVE VIDEO STREAMING ENGINE (WebRTC & Command Listener)
        // -------------------------
        currentPollRate = 10000; // Reset to standard 10s rate on session start
        startStreamPolling();
        
        // Take immediate initial snapshot
        syncTelemetry();
        
        // Start Anti-Cheat engine
        startAntiCheat();

        // Start Adaptive Anti-Cheat (checking every 30s)
        lastKeyboardInputTime = Date.now();
        lastMouseActivityTime = Date.now();
        adaptiveAntiCheatInterval = setInterval(() => {
            if (!isTracking) return;
            const now = Date.now();
            // Trigger Captcha check if mouse is active but keyboard idle for 15+ minutes
            if (now - lastKeyboardInputTime > 15 * 60 * 1000 && now - lastMouseActivityTime < 60 * 1000) {
                console.warn("⚠️ Adaptive Anti-Cheat: Keyboard idle but mouse active. Captcha triggered.");
                lastKeyboardInputTime = now; // Prevent loop
                if (document.getElementById('antiCheatOverlay').style.display !== 'flex') {
                    clearTimeout(antiCheatInterval);
                    triggerAntiCheat();
                }
            }
        }, 30000);
    } catch (error) {
        // The timer/UI are now started optimistically above, so on a late failure
        // tear them back down instead of leaving a zombie (timer ticking while
        // isTracking is false). Reset fully to the idle state before alerting.
        isTracking = false;
        externalTimeLogId = null; // never leave a mirror marker set on a failed start
        stopCounterTicking();
        if (trackBtn) {
            trackBtn.classList.remove('active');
            const btnIcon = document.getElementById('btnIcon');
            if (btnIcon) btnIcon.innerText = '▶';
            const btnText = document.getElementById('btnText');
            if (btnText) btnText.innerText = __('btn_start');
            trackBtn.disabled = false;
        }
        const statusText = document.getElementById('statusText');
        if (statusText) statusText.innerText = __('status_paused');
        const taskSelect = document.getElementById('taskSelect');
        if (taskSelect) taskSelect.disabled = false;
        const taskTitle = document.getElementById('taskTitle');
        if (taskTitle && (!taskSelect || taskSelect.value === 'general_work' || taskSelect.value === '')) {
            taskTitle.disabled = false;
        }
        showToast(__('error_starting') + error.message, { variant: 'error' });
    }
}

// options.skipServerStop : when true, tear the local session down WITHOUT calling
//   session/{id}/stop. Used when HRM has already closed the session server-side
//   (a web Stop, or a task switch where the web start already closed the old log).
async function stopTracking(options = {}) {
    const skipServerStop = options.skipServerStop === true;
    // Reset local tracking states synchronously and instantly to prevent leaks/freezes
    isTracking = false;
    if (window.electronAPI && window.electronAPI.setTrackingActive) {
        window.electronAPI.setTrackingActive(false);  // close (X) now prompts exit-or-background
    }

    // Stopping or pausing must immediately disarm the distraction guard: release
    // any always-on-top window lock and hide the warning overlay so the user can
    // freely use any app while not tracking. (When a violation triggers the stop,
    // triggerDistractionResponse re-asserts the lock right after this returns, so
    // the post-violation acknowledgment screen still stays locked.)
    if (distractionLockShown) dismissDistractionWarning();

    // Disable trackBtn during stop operation to prevent duplicate stops or race starts
    const trackBtn = document.getElementById('trackBtn');
    if (trackBtn) trackBtn.disabled = true;

    stopCounterTicking();
    if (trackingInterval) clearInterval(trackingInterval);
    // NOTE: rulesRefreshInterval and distractionGuardInterval are intentionally
    // NOT cleared here. The guard interval keeps ticking, but enforceDistractionBlock()
    // now returns early while isTracking === false, so after a stop/pause it stays
    // silent and lets the user open any app until tracking resumes.
    if (shouldStreamCheckInterval) clearInterval(shouldStreamCheckInterval);
    if (streamInterval) {
        clearInterval(streamInterval);
        streamInterval = null;
    }
    streamActive = false;
    
    if (adaptiveAntiCheatInterval) clearInterval(adaptiveAntiCheatInterval);
    stopWebRTCStream();
    stopFocusMode();
 
    if (antiCheatInterval) clearTimeout(antiCheatInterval);
    if (antiCheatCountdownInterval) clearInterval(antiCheatCountdownInterval);
    lastLocationTrackTime = 0; // Reset GPS track timestamp
    
    const overlay = document.getElementById('antiCheatOverlay');
    if (overlay) overlay.style.display = 'none';
    if (window.electronAPI && window.electronAPI.setAntiCheatActive) {
        window.electronAPI.setAntiCheatActive(false);
    }
    
    // Update UI immediately
    if (trackBtn) {
        trackBtn.classList.remove('active');
        const btnIcon = document.getElementById('btnIcon');
        if (btnIcon) btnIcon.innerText = '▶';
        const btnText = document.getElementById('btnText');
        if (btnText) btnText.innerText = __('btn_start');
        trackBtn.disabled = false; // Re-enable once completed
    }
    const statusText = document.getElementById('statusText');
    if (statusText) statusText.innerText = __('status_paused');
    const taskSelect = document.getElementById('taskSelect');
    if (taskSelect) {
        taskSelect.disabled = false;
        const taskTitle = document.getElementById('taskTitle');
        if (taskTitle) {
            if (taskSelect.value === 'general_work' || taskSelect.value === '') {
                taskTitle.disabled = false;
            } else {
                taskTitle.disabled = true;
            }
        }
    } else {
        const taskTitle = document.getElementById('taskTitle');
        if (taskTitle) taskTitle.disabled = false;
    }

    // We are no longer mirroring any HRM session once tracking stops.
    externalTimeLogId = null;

    if(!timeLogId) return;

    // Capture session IDs to process asynchronously
    const targetLogId = timeLogId;
    const targetSeconds = currentSessionSeconds;

    timeLogId = null;

    // HRM-commanded stop: the server already closed this session. Calling the stop
    // endpoint again would be redundant/erroneous, so just drop the local session.
    if (skipServerStop) {
        startTrackerReminder();
        return;
    }

    // Inform server about the stop in the background asynchronously
    try {
        if(!String(targetLogId).startsWith('local_')) {
            fetchWithAuth(`${API_BASE}/tracking/session/${targetLogId}/stop`, {
                method: 'POST',
                body: JSON.stringify({ total_seconds: targetSeconds })
            }).catch(e => {
                console.warn("Failed to stop online session normally, saving offline stop request", e);
                saveOfflineStop(targetLogId, targetSeconds);
            });
        } else {
            // It's a localized offline session
            if(offlineDb && offlineSessionStartTime) {
                const tx = offlineDb.transaction('offline_sessions', 'readwrite');
                const store = tx.objectStore('offline_sessions');
                const sessionReq = store.get(targetLogId);
                
                sessionReq.onsuccess = () => {
                    if(sessionReq.result) {
                        let sess = sessionReq.result;
                        sess.ended_at = new Date().toISOString();
                        // Record the ACTUAL accumulated active seconds (currentSessionSeconds,
                        // captured above as targetSeconds) rather than the raw wall-clock span
                        // (now - started_at). The tick counter only advances while tracking is
                        // live, so pauses/idle are already excluded. Using wall-clock here was
                        // the cause of an offline session that was paused (e.g. 2h of work over
                        // a 5h span) syncing back as the full 5h once the server returned.
                        sess.total_seconds = targetSeconds;
                        store.put(sess);
                    }
                };
            }
        }
    } catch (error) {
        console.error('Error during stop tracking storage/sync:', error);
    }
    startTrackerReminder();
}

function saveOfflineStop(timeLogId, totalSeconds) {
    if (offlineDb) {
        try {
            const tx = offlineDb.transaction('offline_stops', 'readwrite');
            tx.objectStore('offline_stops').put({
                time_log_id: timeLogId,
                total_seconds: totalSeconds,
                stopped_at: new Date().toISOString()
            });
            console.log(`Saved offline stop request for session ${timeLogId}`);
        } catch (e) {
            console.error("Failed to save offline stop request:", e);
        }
    }
}

document.getElementById('trackBtn').addEventListener('click', () => {
    if (isTracking) {
        stopTracking();
    } else {
        startTracking();
    }
});

function updateTimerUI() {
    const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
    const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
    const s = String(seconds % 60).padStart(2, '0');
    document.getElementById('timerDisplay').innerText = `${h}:${m}:${s}`;
    
    // Update Mini Dashboard Performance Metrics
    const targetSeconds = dailyTargetHours * 3600;
    let percent = targetSeconds > 0 ? (seconds / targetSeconds) * 100 : 0;
    if(percent > 100) percent = 100;
    
    document.getElementById('dailyProgressBar').style.width = percent + '%';
    document.getElementById('dailyProgressBar').style.background = percent >= 100 ? '#10b981' : '#f59e0b';
    
    const decimalHoursLogged = (seconds / 3600).toFixed(1);
    document.getElementById('progressText').innerText = __('today_progress', decimalHoursLogged, dailyTargetHours);
}

// Separate UI update interval function
function incrementAndDisplay() {
    const now = Date.now();

    if (lastTickMs === null) {
        // First tick after (re)starting the counter: anchor only, credit nothing.
        lastTickMs = now;
        updateTimerUI();
        return;
    }

    let deltaMs = now - lastTickMs;
    lastTickMs = now;

    // A negative delta means the system clock stepped backwards (NTP correction,
    // manual change, DST on a naive clock). Credit nothing rather than unwinding
    // the counter.
    if (deltaMs < 0) deltaMs = 0;
    if (deltaMs > MAX_TICK_DELTA_MS) deltaMs = 0;

    tickRemainderMs += deltaMs;
    const wholeSeconds = Math.floor(tickRemainderMs / 1000);
    if (wholeSeconds > 0) {
        tickRemainderMs -= wholeSeconds * 1000;
        seconds += wholeSeconds;
        currentSessionSeconds += wholeSeconds;
    }

    updateTimerUI();
}

// Anchor the clock immediately before the interval starts so the first real tick
// measures from the right instant.
function startCounterTicking() {
    if (uiInterval) clearInterval(uiInterval);
    lastTickMs = Date.now();
    tickRemainderMs = 0;
    uiInterval = setInterval(incrementAndDisplay, 1000);
}

function stopCounterTicking() {
    if (uiInterval) { clearInterval(uiInterval); uiInterval = null; }
    lastTickMs = null;
    tickRemainderMs = 0;
}

/**
 * Re-anchor the tick clock without crediting the gap. Called after a suspension
 * or any other event where wall-clock moved but no work happened.
 */
function reanchorCounter() {
    if (uiInterval) {
        lastTickMs = Date.now();
        tickRemainderMs = 0;
    }
}

/**
 * Pull the authoritative daily total from the server and adopt it.
 * `reason` is for the log only.
 */
async function reconcileDailyTotal(reason) {
    try {
        const res = await fetchWithAuth(`${API_BASE}/tracking/today-stats`);
        const data = await res.json();

        if (typeof data.today_total_seconds === 'number') {
            seconds = data.today_total_seconds;
            counterDayKey = localDayKey();
            updateTimerUI();
            console.log(`Daily total reconciled with the server (${reason}): ${seconds}s`);
        }
    } catch (err) {
        console.warn(`Could not reconcile the daily total (${reason}):`, err);
    }
}

/**
 * Has the calendar day turned since the counter was baselined? If so the daily
 * figure on screen belongs to yesterday.
 */
async function checkDayRollover() {
    const today = localDayKey();
    if (counterDayKey === null) { counterDayKey = today; return false; }
    if (counterDayKey === today) return false;

    console.log(`Day rolled over ${counterDayKey} → ${today}; re-baselining the daily counter.`);
    counterDayKey = today;

    // Reset immediately so the UI cannot show yesterday's total even for a
    // moment, then take the server's figure for the new day.
    // The DAILY figure resets; the running session's own counter does not — the
    // session did not end at midnight, and the server attributes it to its start
    // day.
    seconds = 0;
    updateTimerUI();

    await reconcileDailyTotal('day rollover');
    return true;
}

// OS power lifecycle. Without these the renderer could only infer a suspension
// from an implausibly large timer delta.
if (window.electronAPI && window.electronAPI.onPowerSuspend) {
    window.electronAPI.onPowerSuspend(() => {
        console.log('System suspending — counter anchor released.');
        lastTickMs = null;   // the next tick after resume anchors instead of crediting
        tickRemainderMs = 0;
    });
}

if (window.electronAPI && window.electronAPI.onPowerResume) {
    window.electronAPI.onPowerResume(async (payload) => {
        const sleptSeconds = payload && payload.sleptMs ? Math.round(payload.sleptMs / 1000) : null;
        console.log(`System resumed${sleptSeconds === null ? '' : ` after ${sleptSeconds}s`}.`);

        reanchorCounter();

        // A suspension can easily straddle midnight.
        const rolled = await checkDayRollover();
        if (!rolled) await reconcileDailyTotal('resume from suspend');

        // Anything the network dropped while the lid was shut.
        flushOfflineQueue();
    });
}

async function syncTelemetry() {
    if (!isTracking || !timeLogId) return;

    // 1. Capture Screens via Electron native desktopCapturer (isolated try-catch)
    try {
        const base64Images = await window.electronAPI.captureScreen();
        if (Array.isArray(base64Images)) {
            for (let i = 0; i < base64Images.length; i++) {
                await uploadScreenshot(base64Images[i], i);
            }
        } else if (base64Images) {
            await uploadScreenshot(base64Images, 0);
        }
    } catch (e) {
        console.error("Screenshot capture/sync error:", e);
    }

    // 2. Upload App Activity (isolated try-catch)
    try {
        uploadActivity();
    } catch (e) {
        console.error("Activity upload error:", e);
    }

    // 3. Track and upload GPS / Geo-IP Location (isolated try-catch)
    try {
        trackLocation();
    } catch (e) {
        console.error("Location track error:", e);
    }
}

async function uploadScreenshot(base64Image, screenIndex = 0) {
    try {
        // Convert base64 to Blob
        const response = await fetch(base64Image);
        const blob = await response.blob();
        
        let formData = new FormData();
        formData.append('time_log_id', timeLogId);
        formData.append('image', blob, `shot_${Date.now()}_${screenIndex}.jpg`);
        formData.append('activity_percentage', Math.floor(Math.random() * 40) + 60); // Fake 60-100% active
        
        // Dynamically retrieve active window for the screenshot metadata
        let activeWin = 'Unknown Window';
        try {
            activeWin = await window.electronAPI.getActiveWindow();
        } catch (winErr) {
            console.warn("Failed to get active window for screenshot:", winErr);
        }
        const displayIndexText = ` [Screen ${screenIndex + 1}]`;
        formData.append('window_title', (activeWin || 'Omega Tracker Target') + displayIndexText);

        try {
            const res = await fetchWithAuth(`${API_BASE}/tracking/screenshot`, {
                method: 'POST',
                body: formData,
                timeoutMs: 60000 // image upload — allow longer than the default
            });

            if(!res.ok) throw new Error('HTTP Status ' + res.status);
        } catch(err) {
            console.warn("Offline! Encrypting and buffering to IndexedDB:", err.message);
            if(offlineDb) {
                try {
                    const cryptoKey = await getCryptoKey(token);
                    const arrayBuffer = await blob.arrayBuffer();
                    const iv = crypto.getRandomValues(new Uint8Array(12));
                    const encrypted = await crypto.subtle.encrypt(
                        { name: 'AES-GCM', iv: iv },
                        cryptoKey,
                        arrayBuffer
                    );
                    
                    const tx = offlineDb.transaction('offline_screenshots', 'readwrite');
                    tx.objectStore('offline_screenshots').add({
                        time_log_id: timeLogId,
                        encrypted_image: encrypted,
                        iv: iv,
                        activity_percentage: formData.get('activity_percentage'),
                        window_title: formData.get('window_title'),
                        timestamp: Date.now()
                    });
                    tx.oncomplete = () => { pruneQueue('offline_screenshots'); };
                } catch (e) {
                    console.error("Local encryption buffering failed:", e);
                }
            }
        }
    } catch (globalErr) {
        console.error("Global uploadScreenshot error:", globalErr);
    }
}

// =========================================================================
// OFFLINE SYNC ENGINE
// =========================================================================

// One flush at a time. The screenshot drain sleeps 3s between uploads, so a
// backlog of twenty takes over a minute — comfortably longer than the 20s
// interval that schedules it. Without this guard, overlapping runs each read the
// same queue and upload the same screenshots, which duplicates them server-side
// and burns the storage quota.
let isFlushing = false;

// An item rejected by the server (4xx) is bad and will stay bad; give up on it
// rather than blocking everything queued behind it forever.
const MAX_SYNC_ATTEMPTS = 5;

// Upper bounds on the offline stores. Screenshots are the expensive one — each
// row holds an encrypted JPEG — and nothing capped them, so a laptop offline for
// a week filled the IndexedDB quota until writes began failing silently, taking
// the activity and session queues down with them. When a store is over its cap
// the OLDEST rows are dropped: the newest evidence is the most useful, and a
// screenshot from six days ago is not worth losing today's session over.
const QUEUE_CAPS = {
    offline_screenshots: 50,
    offline_activities: 500,
};

/**
 * Trim a store to its cap, oldest-first. Rows are ordered by `timestamp` where
 * present and by the autoincrement key otherwise, so this works for both.
 */
async function pruneQueue(storeName) {
    const cap = QUEUE_CAPS[storeName];
    if (!cap || !offlineDb) return 0;

    let rows;
    try {
        rows = await readAll(storeName);
    } catch (err) {
        console.error(`Could not read ${storeName} to prune it:`, err);
        return 0;
    }

    if (!rows || rows.length <= cap) return 0;

    rows.sort((a, b) => (a.timestamp || a.id || 0) - (b.timestamp || b.id || 0));
    const excess = rows.slice(0, rows.length - cap);

    for (const row of excess) {
        await removeFrom(storeName, row.id !== undefined ? row.id : row.timestamp).catch(() => {});
    }

    console.warn(`Pruned ${excess.length} oldest row(s) from ${storeName} (cap ${cap}).`);
    return excess.length;
}

// Thrown to abandon the current flush cycle without blaming the item: the
// server is unreachable or erroring, so every remaining item would fail too and
// counting those as item failures would quarantine a healthy queue.
class SyncUnavailableError extends Error {}

function idbRequest(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
}

function idbTransaction(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
}

function readAll(storeName) {
    return idbRequest(offlineDb.transaction(storeName, 'readonly').objectStore(storeName).getAll());
}

function removeFrom(storeName, key) {
    const tx = offlineDb.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    return idbTransaction(tx);
}

function putInto(storeName, value) {
    const tx = offlineDb.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    return idbTransaction(tx);
}

// Classify a response the way the drain loop needs it: a 4xx is this item's
// fault, anything else (5xx, timeout, DNS failure) is the transport's.
function assertItemLevelFailure(response) {
    if (!response || response.status >= 500) throw new SyncUnavailableError();
}

async function recordItemFailure(storeName, keyField, item) {
    const attempts = (item.sync_attempts || 0) + 1;

    if (attempts >= MAX_SYNC_ATTEMPTS) {
        console.error(`Dropping ${storeName} item ${item[keyField]} after ${attempts} rejected attempts.`);
        await removeFrom(storeName, item[keyField]).catch(() => {});
        return;
    }

    item.sync_attempts = attempts;
    await putInto(storeName, item).catch(() => {});
}

// Walks a queue item by item. A rejected item is counted and skipped rather than
// stopping the drain — one undecryptable screenshot used to block every
// screenshot queued behind it, permanently.
async function drainQueue(storeName, keyField, sendItem) {
    let items;
    try {
        items = await readAll(storeName);
    } catch (err) {
        console.error(`Could not read ${storeName}:`, err);
        return;
    }

    for (const item of items || []) {
        try {
            await sendItem(item);
            await removeFrom(storeName, item[keyField]).catch((e) =>
                console.error(`Synced ${storeName} item ${item[keyField]} but failed to purge it:`, e));
        } catch (err) {
            if (err instanceof SyncUnavailableError) return; // server down — try the whole queue again later
            await recordItemFailure(storeName, keyField, item);
        }
    }
}

async function flushOfflineQueue() {
    if (!offlineDb || !navigator.onLine) {
        updateSyncStatus(navigator.onLine ? 'online' : 'offline');
        return;
    }
    if (isFlushing) return;

    isFlushing = true;
    updateSyncStatus('syncing');

    try {
        // 1. Sessions.
        //
        // Only CLOSED sessions are eligible. The session that is being tracked
        // right now is written to this store at start with ended_at: null so a
        // crash cannot lose it — but uploading it mid-flight and deleting the
        // local row (as this used to) stranded it: the server kept a 'running'
        // row with 0 seconds, and stopTracking() then found nothing locally to
        // attach the real duration to. Every offline session that regained
        // connectivity before it ended lost its time that way.
        let sessions = [];
        try {
            sessions = (await readAll('offline_sessions')).filter((s) => !!s.ended_at);
        } catch (err) {
            console.error('Could not read offline_sessions:', err);
        }

        if (sessions.length > 0) {
            try {
                const syncRes = await fetchWithAuth(`${API_BASE}/tracking/sync-offline-sessions`, {
                    method: 'POST',
                    body: JSON.stringify({ sessions }),
                });

                if (syncRes.ok) {
                    const data = await syncRes.json();
                    const mappedIds = data.mapped_ids || {};

                    // Purge only what we actually sent, by key — never the whole store.
                    for (const sess of sessions) {
                        await removeFrom('offline_sessions', sess.client_id).catch((e) =>
                            console.error('Failed to purge synced session', sess.client_id, e));
                    }

                    // Re-point queued screenshots from the local id to the real one.
                    if (Object.keys(mappedIds).length > 0) {
                        try {
                            const shots = await readAll('offline_screenshots');
                            for (const shot of shots || []) {
                                if (mappedIds[shot.time_log_id]) {
                                    shot.time_log_id = mappedIds[shot.time_log_id];
                                    await putInto('offline_screenshots', shot).catch(() => {});
                                }
                            }
                        } catch (err) {
                            console.error('Could not re-point queued screenshots:', err);
                        }
                    }
                }
            } catch (err) {
                console.warn('Offline session sync unavailable:', err);
            }
        }

        // 2. Screenshots.
        await drainQueue('offline_screenshots', 'id', async (item) => {
            // Still bound to a local session id — that session has not synced
            // yet, so there is no server-side row to attach this to. Leave it
            // queued without counting an attempt against it.
            if (String(item.time_log_id).startsWith('local_')) throw new SyncUnavailableError();

            let imageBlob;
            if (item.encrypted_image && item.iv) {
                imageBlob = await decryptScreenshot(item.encrypted_image, item.iv, token);
            } else {
                imageBlob = item.image_blob; // legacy unencrypted entries
            }

            const formData = new FormData();
            formData.append('time_log_id', item.time_log_id);
            formData.append('image', imageBlob, `shot_offline_${item.timestamp}.jpg`);
            formData.append('activity_percentage', item.activity_percentage);
            formData.append('window_title', item.window_title);

            const response = await fetchWithAuth(`${API_BASE}/tracking/screenshot`, {
                method: 'POST',
                body: formData,
                timeoutMs: 60000, // image upload — allow longer than the default
            });

            if (!response.ok) {
                assertItemLevelFailure(response);
                throw new Error(`Screenshot rejected with ${response.status}`);
            }

            // Throttle so a large backlog does not saturate the connection.
            await new Promise((resolve) => setTimeout(resolve, 3000));
        });

        // 3. Activities.
        await drainQueue('offline_activities', 'id', async (item) => {
            if (String(item.time_log_id).startsWith('local_')) throw new SyncUnavailableError();

            const response = await fetchWithAuth(`${API_BASE}/tracking/activity`, {
                method: 'POST',
                body: JSON.stringify({ time_log_id: item.time_log_id, activities: item.activities }),
            });

            if (!response.ok) {
                assertItemLevelFailure(response);
                throw new Error(`Activity rejected with ${response.status}`);
            }
        });

        // 4. Deferred stops.
        await drainQueue('offline_stops', 'time_log_id', async (item) => {
            const response = await fetchWithAuth(`${API_BASE}/tracking/session/${item.time_log_id}/stop`, {
                method: 'POST',
                body: JSON.stringify({ total_seconds: item.total_seconds, ended_at: item.stopped_at }),
            });

            if (!response.ok) {
                assertItemLevelFailure(response);
                throw new Error(`Stop rejected with ${response.status}`);
            }
        });
    } catch (err) {
        console.warn('Sync flush error', err);
    } finally {
        isFlushing = false;
        updateSyncStatus(navigator.onLine ? 'online' : 'offline');
    }
}

// =========================================================================
// DISTRACTION BLOCKER (active only while tracking)
// =========================================================================
// The guard interval below stays armed continuously (every few seconds), but
// enforceDistractionBlock() only ACTS while a tracking session is live
// (isTracking === true). As long as tracking is running, a Distracting app/tab
// is force-closed EVERY time it is detected — reopening it is blocked for as
// long as it stays categorized as Distracting. When tracking is not started,
// is stopped, or is paused, the guard is silent and the user may open any app.

const DISTRACTION_GUARD_INTERVAL_MS = 3000;
const VIOLATION_REPORT_THROTTLE_MS = 15000;

function startDistractionGuard() {
    if (distractionGuardInterval) clearInterval(distractionGuardInterval);
    distractionGuardInterval = setInterval(enforceDistractionBlock, DISTRACTION_GUARD_INTERVAL_MS);
}

// Single source of truth for "is this window distracting?" — uses the same
// blockList loaded from GET /tracking/rules and refreshed periodically.
function isWindowProhibited(title) {
    if (!title || !Array.isArray(blockList) || blockList.length === 0) return false;
    const lower = title.toLowerCase();
    return blockList.some(kw => kw && lower.includes(String(kw).toLowerCase()));
}

// Runs on every guard tick. Re-entrancy guarded because getActiveWindow() is an
// async native call that can take longer than the tick interval.
async function enforceDistractionBlock() {
    if (distractionBusy) return false;
    // Strict gate: the guard ONLY enforces while a tracking session is live.
    // If tracking has not started, is stopped, or is paused (isTracking === false),
    // stay completely silent — do not force-close windows or raise the lock — so
    // the user can use any application freely outside of working hours.
    if (!isTracking) return false;
    // Strict safety: stay completely idle unless there is an authenticated
    // session. This guarantees the guard never acts on the login screen or
    // before boot() has resolved a token, even if it were somehow armed.
    if (!token) return false;
    if (!window.electronAPI || !window.electronAPI.getActiveWindow) return false;
    // Skip while the captcha anti-cheat overlay owns the screen to avoid
    // fighting over window focus.
    const antiCheatOverlay = document.getElementById('antiCheatOverlay');
    if (antiCheatOverlay && antiCheatOverlay.style.display === 'flex') return false;

    distractionBusy = true;
    try {
        let title = await window.electronAPI.getActiveWindow();
        if (!isWindowProhibited(title)) return false;
        await triggerDistractionResponse(title);
        return true;
    } catch (e) {
        console.warn('Distraction guard error:', e);
        return false;
    } finally {
        distractionBusy = false;
    }
}

// The enforcement action, shared by the guard and the server-authoritative
// path: force-close the offending window EVERY time, stop the timer if running,
// report the violation (throttled), and raise the persistent always-on-top
// warning lock.
async function triggerDistractionResponse(offending) {
    if (window.electronAPI && window.electronAPI.closeActiveWindow) {
        await window.electronAPI.closeActiveWindow();
    }
    reportDistractionViolation(offending);
    if (isTracking) stopTracking();
    showDistractionWarning(offending);
}

function reportDistractionViolation(offending) {
    const now = Date.now();
    if (now - lastViolationReportAt < VIOLATION_REPORT_THROTTLE_MS) return;
    lastViolationReportAt = now;
    fetchWithAuth(API_BASE + '/tracking/violation', {
        method: 'POST',
        body: JSON.stringify({
            type: 'prohibited_app_opened',
            details: offending
        })
    }).catch(e => console.warn('Failed to send prohibited app violation:', e));
}

// Always-on-top warning overlay built in the renderer (no separate HTML file).
// The matching main-process lock (set-distraction-lock) forces the window to
// the front and re-focuses it on blur, so the user cannot click behind or
// ignore it until they press the acknowledgment button.
function getOrCreateDistractionOverlay() {
    let overlay = document.getElementById('distractionOverlay');
    if (overlay) return overlay;

    const isAr = (typeof currentLocale !== 'undefined' && currentLocale === 'ar');
    overlay = document.createElement('div');
    overlay.id = 'distractionOverlay';
    overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:2147483647', 'display:none',
        'align-items:center', 'justify-content:center', 'flex-direction:column',
        'background:rgba(2,6,23,0.94)', 'backdrop-filter:blur(4px)',
        'text-align:center', 'padding:24px', 'font-family:inherit', 'color:#fff'
    ].join(';');

    const heading = isAr ? '🛑 تطبيق ملهٍ محظور' : '🛑 Distracting App Blocked';
    const note = isAr
        ? 'تم إغلاق النافذة وإيقاف الموقت. لا يمكنك المتابعة حتى تؤكد.'
        : 'The window was closed and the timer stopped. You cannot continue until you acknowledge.';
    const btnLabel = isAr ? 'لقد فهمت — العودة إلى العمل' : 'I understand — back to work';

    overlay.innerHTML =
        '<div style="font-size:54px; margin-bottom:12px;">⛔</div>' +
        '<h2 style="margin:0 0 12px; font-size:22px;">' + heading + '</h2>' +
        '<p class="distraction-message" style="max-width:460px; font-size:15px; line-height:1.5; opacity:.92; margin:0 0 8px;"></p>' +
        '<p style="max-width:460px; font-size:13px; line-height:1.5; opacity:.7; margin:0 0 22px;">' + note + '</p>' +
        '<button id="distractionAckBtn" style="cursor:pointer; border:none; border-radius:8px; padding:12px 22px; font-size:15px; font-weight:600; color:#fff; background:linear-gradient(135deg,#ef4444 0%,#dc2626 100%); box-shadow:0 6px 16px rgba(239,68,68,0.35);">' + btnLabel + '</button>';

    document.body.appendChild(overlay);
    overlay.querySelector('#distractionAckBtn').addEventListener('click', dismissDistractionWarning);
    return overlay;
}

function showDistractionWarning(offending) {
    const overlay = getOrCreateDistractionOverlay();
    const msg = overlay.querySelector('.distraction-message');
    if (msg) msg.textContent = __('proactive_warning', offending || '');
    overlay.style.display = 'flex';

    // Only (re)assert the OS-level lock when transitioning into the warning
    // state, so repeated guard ticks don't keep flashing/refocusing.
    if (!distractionLockShown) {
        distractionLockShown = true;
        if (window.electronAPI && window.electronAPI.setDistractionLock) {
            window.electronAPI.setDistractionLock(true);
        }
        if (window.electronAPI && window.electronAPI.requestAttention) {
            window.electronAPI.requestAttention();
        }
        try { playFocusWarningBeep(); } catch (e) { /* audio is best-effort */ }
    }
}

function dismissDistractionWarning() {
    const overlay = document.getElementById('distractionOverlay');
    if (overlay) overlay.style.display = 'none';
    distractionLockShown = false;
    if (window.electronAPI && window.electronAPI.setDistractionLock) {
        window.electronAPI.setDistractionLock(false);
    }
}

async function uploadActivity() {
    // -------------------------
    // ACTIVE BLOCKER (ANTI-PROCRASTINATION)
    // -------------------------
    // Retrieve the true OS window title using native IPC.
    let activeWindowTitle = await window.electronAPI.getActiveWindow();

    if (document.getElementById('meetingModeToggle') && document.getElementById('meetingModeToggle').checked) {
        activeWindowTitle = __('in_meeting_tag') + activeWindowTitle;
    }

    // `blockList` is populated by loadDistractingApps() from GET /tracking/rules,
    // which returns this employee's RESOLVED distracting apps. The persistent
    // distraction guard (every few seconds) is the primary enforcer; this is a
    // belt-and-suspenders check on the activity-upload path that routes through
    // the same shared enforcement so behavior is identical.
    if (isWindowProhibited(activeWindowTitle)) {
        await triggerDistractionResponse(activeWindowTitle);
        return;
    }


    // Determine App Name heuristically from window title
    let appName = 'Unknown Web/App';
    if(activeWindowTitle.includes('-')) {
        let parts = activeWindowTitle.split('-');
        appName = parts[parts.length - 1].trim();
    } else if (activeWindowTitle.includes('Google Chrome')) appName = 'Chrome';
    else if (activeWindowTitle.includes('Edge')) appName = 'Edge';
    else appName = activeWindowTitle.split(' ')[0] || 'App';

    const activities = [{
        app_name: appName,
        window_title: activeWindowTitle,
        duration_seconds: 30,
        keystrokes: Math.floor(Math.random() * 150),
        mouse_clicks: Math.floor(Math.random() * 50)
    }];

    // If tracking is offline / local, buffer to IndexedDB immediately without fetching
    if (timeLogId && String(timeLogId).startsWith('local_')) {
        console.log("Offline activity log, buffering to IndexedDB...");
        if (offlineDb) {
            const tx = offlineDb.transaction('offline_activities', 'readwrite');
            tx.objectStore('offline_activities').add({
                time_log_id: timeLogId,
                activities: activities,
                timestamp: Date.now()
            });
            tx.oncomplete = () => { pruneQueue('offline_activities'); };
        }
        return;
    }

    try {
        const response = await fetchWithAuth(`${API_BASE}/tracking/activity`, {
            method: 'POST',
            body: JSON.stringify({
                time_log_id: timeLogId,
                activities: activities
            })
        });
        const data = await response.json();

        // Server-authoritative distracting-app enforcement. The server classifies
        // the reported activity against the employee's RESOLVED productivity rules
        // (their individual rules from employees/{id}/edit + global rules) and
        // returns distracting_app_detected. When flagged, force-close the window
        // and completely stop the tracking timer.
        if (data && data.distracting_app_detected) {
            await triggerDistractionResponse(data.distracting_app || activeWindowTitle);
            return;
        }

        // Enforce Meeting Mode Limit
        const toggle = document.getElementById('meetingModeToggle');
        if (data && data.meeting_mode_limit_exceeded) {
            if (toggle) {
                if (toggle.checked) {
                    toggle.checked = false;
                    console.warn("Meeting mode limit reached for today. Disabling meeting mode.");
                    showToast("Meeting mode limit reached for today! Mode disabled.", { variant: 'warn' });
                }
                toggle.disabled = true;
            }
        } else {
            if (toggle) toggle.disabled = false;
        }
    } catch(e) {
        console.warn("Offline activity log due to fetch error, buffering to IndexedDB:", e.message);
        if (offlineDb && timeLogId) {
            const tx = offlineDb.transaction('offline_activities', 'readwrite');
            tx.objectStore('offline_activities').add({
                time_log_id: timeLogId,
                activities: activities,
                timestamp: Date.now()
            });
            tx.oncomplete = () => { pruneQueue('offline_activities'); };
        }
    }
}

// -------------------------
// ANTI-CHEAT JIGGLER DETECTION
// -------------------------
function startAntiCheat() {
    // Random between 90 and 180 mins (5,400,000 to 10,800,000 ms) to be less intrusive
    const nextCheckMs = Math.floor(Math.random() * (10800000 - 5400000 + 1) + 5400000);
    
    antiCheatInterval = setTimeout(() => {
        triggerAntiCheat();
    }, nextCheckMs);
}

function triggerAntiCheat() {
    expectedCaptcha = Math.floor(1000 + Math.random() * 9000).toString();
    document.getElementById('captchaCode').innerText = expectedCaptcha;
    document.getElementById('captchaInput').value = '';
    document.getElementById('antiCheatOverlay').style.display = 'flex';
    document.getElementById('captchaInput').focus();
    
    // Attempt to bring window to front and lock it
    if (window.electronAPI && window.electronAPI.setAntiCheatActive) {
        window.electronAPI.setAntiCheatActive(true);
    }
    window.electronAPI.requestAttention();
    
    let timeLeft = 60;
    document.getElementById('verifyCaptchaBtn').innerHTML = __('captcha_verify_btn', timeLeft);
    antiCheatCountdownInterval = setInterval(() => {
        timeLeft--;
        document.getElementById('verifyCaptchaBtn').innerHTML = __('captcha_verify_btn', timeLeft);
        if(timeLeft <= 0) {
            clearInterval(antiCheatCountdownInterval);
            document.getElementById('antiCheatOverlay').style.display = 'none';
            if (window.electronAPI && window.electronAPI.setAntiCheatActive) {
                window.electronAPI.setAntiCheatActive(false);
            }

            // Report violation to server
            fetchWithAuth(API_BASE + '/tracking/violation', {
                method: 'POST',
                body: JSON.stringify({
                    type: 'captcha_timeout',
                    details: 'Captcha verification timed out (60 seconds exceeded)'
                })
            }).catch(e => console.warn('Failed to send captcha timeout violation:', e));

            showToast(__('captcha_timeout'), { variant: 'warn' });
            stopTracking();
        }
    }, 1000);
}

document.getElementById('verifyCaptchaBtn').addEventListener('click', () => {
    if(document.getElementById('captchaInput').value === expectedCaptcha) {
        clearInterval(antiCheatCountdownInterval);
        document.getElementById('antiCheatOverlay').style.display = 'none';
        if (window.electronAPI && window.electronAPI.setAntiCheatActive) {
            window.electronAPI.setAntiCheatActive(false);
        }
        // Reload engine for next random strike
        startAntiCheat();
    } else {
        showToast(__('captcha_wrong'), { variant: 'warn' });
    }
});

// -------------------------
// SYNC STATUS MANAGEMENT
// -------------------------
function updateSyncStatus(state) {
    const dot = document.getElementById('syncStatusDot');
    const text = document.getElementById('syncStatusText');
    if (!dot || !text) return;
    
    dot.className = 'sync-dot';
    if (state === 'online') {
        dot.classList.add('online');
        text.setAttribute('data-i18n', 'status_online');
        text.innerText = __('status_online');
    } else if (state === 'syncing') {
        dot.classList.add('syncing');
        text.setAttribute('data-i18n', 'status_syncing');
        text.innerText = __('status_syncing');
    } else if (state === 'offline') {
        dot.classList.add('offline');
        text.setAttribute('data-i18n', 'status_offline');
        text.innerText = __('status_offline');
    }
}

// Initial status on boot
updateSyncStatus(navigator.onLine ? 'online' : 'offline');

window.addEventListener('online', () => {
    updateSyncStatus('online');
    if (isTracking) {
        const isLocal = timeLogId && String(timeLogId).startsWith('local_');
        document.getElementById('statusText').innerText = isLocal ? __('offline_tracking_active') : __('tracking_active');
    }
    flushOfflineQueue();
});
window.addEventListener('offline', () => {
    updateSyncStatus('offline');
    if (isTracking) {
        document.getElementById('statusText').innerText = __('offline_tracking_active');
    }
});

// -------------------------
// ADAPTIVE JIGGLER DETECTION
// -------------------------
let lastMouseX = null;
let lastMouseY = null;
let mouseMoveHistory = [];

window.addEventListener('mousemove', (e) => {
    if (!isTracking) return;
    
    // Update mouse activity timestamp for adaptive anti-cheat
    lastMouseActivityTime = Date.now();
    
    const x = e.screenX || e.clientX;
    const y = e.screenY || e.clientY;
    
    if (x === lastMouseX && y === lastMouseY) return;
    
    const pos = { x, y, time: Date.now() };
    mouseMoveHistory.push(pos);
    if (mouseMoveHistory.length > 10) {
        mouseMoveHistory.shift();
    }
    
    lastMouseX = x;
    lastMouseY = y;
    
    checkJigglerPattern();
});

function checkJigglerPattern() {
    if (mouseMoveHistory.length < 10) return;
    
    // Check alternating sequence (e.g. A -> B -> A -> B)
    let alternating = true;
    for (let i = 2; i < mouseMoveHistory.length; i++) {
        if (mouseMoveHistory[i].x !== mouseMoveHistory[i - 2].x || mouseMoveHistory[i].y !== mouseMoveHistory[i - 2].y) {
            alternating = false;
            break;
        }
    }
    
    // Check unique coordinates count
    const uniquePoints = new Set(mouseMoveHistory.map(p => `${p.x},${p.y}`));
    const uniqueCount = uniquePoints.size;
    
    if (alternating || uniqueCount <= 2) {
        console.warn("⚠️ Mouse jiggler detected! Alternating coordinates pattern.");
        mouseMoveHistory = []; // Reset
        
        // Report violation to server
        fetchWithAuth(`${API_BASE}/tracking/violation`, {
            method: 'POST',
            body: JSON.stringify({
                type: 'jiggler_detected',
                details: 'Alternating coordinates / mouse jiggler pattern detected.'
            })
        }).catch(e => console.warn('Failed to send jiggler violation:', e));

        // Instantly trigger presence check if not already showing
        if (document.getElementById('antiCheatOverlay').style.display !== 'flex') {
            clearTimeout(antiCheatInterval); // Cancel regular timeout
            triggerAntiCheat();
        }
    }
}

// -------------------------
// GPS & GEO-IP LOCATION TRACKING ENGINE
// -------------------------

async function trackLocation() {
    if (!isTracking || !timeLogId || String(timeLogId).startsWith('local_')) return;
    
    const now = Date.now();
    // Only upload location once every 5 minutes (300000 ms)
    if (now - lastLocationTrackTime < 300000) return;
    
    lastLocationTrackTime = now;
    console.log("Attempting to capture GPS location...");
    
    // 1. Try HTML5 Geolocation API first (fast, Chromium native, zero process overhead)
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            async (position) => {
                const lat = position.coords.latitude;
                const lng = position.coords.longitude;
                console.log(`GPS Location captured via Geolocation API: ${lat}, ${lng}`);
                await sendLocationToServer(lat, lng);
            },
            async (err) => {
                console.warn("Geolocation API failed or denied, trying OS-Native Location service...", err);
                await trackLocationViaNativeOrIp();
            },
            { enableHighAccuracy: true, timeout: 5000 }
        );
    } else {
        await trackLocationViaNativeOrIp();
    }
}

async function trackLocationViaNativeOrIp() {
    // 2. Try OS-Native Location Service (Windows PowerShell)
    if (window.electronAPI && window.electronAPI.getNativeLocation) {
        try {
            console.log("Trying OS-Native Geolocation API...");
            const nativeLoc = await window.electronAPI.getNativeLocation();
            if (nativeLoc && nativeLoc !== 'unknown') {
                const parts = nativeLoc.split(',');
                if (parts.length === 2) {
                    const lat = parseFloat(parts[0]);
                    const lng = parseFloat(parts[1]);
                    if (!isNaN(lat) && !isNaN(lng)) {
                        console.log(`GPS Location captured via OS-Native API: ${lat}, ${lng}`);
                        await sendLocationToServer(lat, lng);
                        return;
                    }
                }
            }
            console.warn("OS-Native Geolocation returned unknown or invalid format. Trying Geo-IP fallback...");
        } catch (err) {
            console.warn("OS-Native Geolocation failed. Trying Geo-IP fallback...", err);
        }
    }
    
    // 3. Try Geo-IP fallback
    await trackLocationViaIp();
}

async function trackLocationViaIp() {
    // Attempt freeipapi.com first
    try {
        console.log("Trying freeipapi.com...");
        const res = await fetch('https://freeipapi.com/api/json');
        const data = await res.json();
        if (data && (typeof data.latitude === 'number' || typeof data.latitude === 'string') && (typeof data.longitude === 'number' || typeof data.longitude === 'string')) {
            const lat = parseFloat(data.latitude);
            const lng = parseFloat(data.longitude);
            if (!isNaN(lat) && !isNaN(lng)) {
                console.log(`GPS Location captured via freeipapi.com: ${lat}, ${lng}`);
                await sendLocationToServer(lat, lng);
                return;
            }
        }
        console.warn("freeipapi.com did not return valid latitude/longitude coordinates.");
    } catch (e) {
        console.error("Failed to track location via freeipapi.com:", e);
    }

    // Attempt ipwho.is second
    try {
        console.log("Trying ipwho.is...");
        const res = await fetch('https://ipwho.is/');
        const data = await res.json();
        if (data && data.success && (typeof data.latitude === 'number' || typeof data.latitude === 'string') && (typeof data.longitude === 'number' || typeof data.longitude === 'string')) {
            const lat = parseFloat(data.latitude);
            const lng = parseFloat(data.longitude);
            if (!isNaN(lat) && !isNaN(lng)) {
                console.log(`GPS Location captured via ipwho.is: ${lat}, ${lng}`);
                await sendLocationToServer(lat, lng);
                return;
            }
        }
        console.warn("ipwho.is did not return valid latitude/longitude coordinates.");
    } catch (e) {
        console.error("Failed to track location via ipwho.is:", e);
    }

    // Attempt ipapi.co third (original fallback)
    try {
        console.log("Trying ipapi.co...");
        const res = await fetch('https://ipapi.co/json/');
        const data = await res.json();
        if (data && (typeof data.latitude === 'number' || typeof data.latitude === 'string') && (typeof data.longitude === 'number' || typeof data.longitude === 'string')) {
            const lat = parseFloat(data.latitude);
            const lng = parseFloat(data.longitude);
            if (!isNaN(lat) && !isNaN(lng)) {
                console.log(`GPS Location captured via ipapi.co: ${lat}, ${lng}`);
                await sendLocationToServer(lat, lng);
                return;
            }
        }
        console.warn("ipapi.co did not return valid latitude/longitude coordinates.");
    } catch (e) {
        console.error("Failed to track location via ipapi.co:", e);
    }

    console.error("All Geo-IP location services failed.");
}

async function sendLocationToServer(lat, lng) {
    try {
        const response = await fetchWithAuth(`${API_BASE}/tracking/location`, {
            method: 'POST',
            body: JSON.stringify({
                time_log_id: timeLogId,
                locations: [
                    { latitude: lat, longitude: lng }
                ]
            })
        });
        if (response.ok) {
            console.log("Location successfully uploaded to server.");
        } else {
            console.warn("Server rejected location upload:", response.status);
        }
    } catch (e) {
        console.error("Network error uploading location:", e);
    }
}

// -------------------------
// WEBRTC SCREEN STREAMING ENGINE
// -------------------------
async function initiateWebRTCStream() {
    console.log("WebRTC: Initiating WebRTC Screen Streaming...");
    if (webrtcPeerConnection) {
        try { webrtcPeerConnection.close(); } catch(e){}
    }
    if (webrtcStream) {
        try {
            webrtcStream.getTracks().forEach(track => track.stop());
        } catch(e){}
    }

    try {
        // Expose screens via IPC context bridge
        const sources = await window.electronAPI.getScreenSources();
        if (!sources || sources.length === 0) {
            console.error("WebRTC: No active screen sources found.");
            return;
        }

        // Fallback check
        if (activeScreenIndex >= sources.length) {
            activeScreenIndex = 0;
        }

        const sourceId = sources[activeScreenIndex].id;
        console.log(`WebRTC: Capturing screen source ID: ${sourceId}`);

        webrtcStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: sourceId,
                    minWidth: 1280,
                    maxWidth: 1280,
                    minHeight: 720,
                    maxHeight: 720
                }
            }
        });

        webrtcPeerConnection = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });

        // Add stream video track to peer connection
        webrtcStream.getVideoTracks().forEach(track => {
            webrtcPeerConnection.addTrack(track, webrtcStream);
        });

        // Generate SDP Offer
        const offer = await webrtcPeerConnection.createOffer();
        await webrtcPeerConnection.setLocalDescription(offer);

        // Wait for ICE gathering to complete before sending SDP (Vanilla ICE)
        await new Promise((resolve) => {
            if (webrtcPeerConnection.iceGatheringState === 'complete') {
                resolve();
            } else {
                webrtcPeerConnection.onicecandidate = (event) => {
                    if (!event.candidate) resolve();
                };
                // Safety timeout
                setTimeout(resolve, 3000);
            }
        });

        // POST SDP Offer to signaling endpoint
        console.log("WebRTC: Posting SDP Offer to signaling server...");
        await fetchWithAuth(`${API_BASE}/tracking/signal`, {
            method: 'POST',
            body: JSON.stringify({
                type: 'offer',
                sdp: webrtcPeerConnection.localDescription.sdp
            })
        });

        isStreaming = true;

        // Poll for SDP Answer
        let answerPollAttempts = 0;
        const answerPollInterval = setInterval(async () => {
            if (!isTracking || !isStreaming) {
                clearInterval(answerPollInterval);
                return;
            }

            answerPollAttempts++;
            if (answerPollAttempts > 15) { // Handshake timeout after 30s
                console.warn("WebRTC: Handshake timed out waiting for answer.");
                clearInterval(answerPollInterval);
                isStreaming = false;
                return;
            }

            try {
                const res = await fetchWithAuth(`${API_BASE}/tracking/signal?type=answer`);
                const data = await res.json();

                if (data && data.sdp) {
                    console.log("WebRTC: SDP Answer received. Completing handshake...");
                    clearInterval(answerPollInterval);
                    await webrtcPeerConnection.setRemoteDescription(new RTCSessionDescription({
                        type: 'answer',
                        sdp: data.sdp
                    }));
                }
            } catch (e) {
                console.error("WebRTC: Answer polling error:", e);
            }
        }, 2000);

    } catch (err) {
        console.error("WebRTC Streaming initialization failed:", err);
    }
}

function stopWebRTCStream() {
    console.log("WebRTC: Terminating WebRTC screen stream...");
    isStreaming = false;
    if (webrtcPeerConnection) {
        try { webrtcPeerConnection.close(); } catch(e){}
        webrtcPeerConnection = null;
    }
    if (webrtcStream) {
        try {
            webrtcStream.getTracks().forEach(track => track.stop());
        } catch(e){}
        webrtcStream = null;
    }
}

// Global Keypress listener for adaptive anti-cheat
window.addEventListener('keydown', () => {
    lastKeyboardInputTime = Date.now();
});

// AES-GCM Encryption Key Helpers using Web Crypto API
// AES-GCM Encryption Key Helpers using Web Crypto API
function getOrCreateMachineKey() {
    let machineKey = localStorage.getItem('tracker_machine_key');
    if (!machineKey) {
        machineKey = 'mk_' + Date.now() + '_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        localStorage.setItem('tracker_machine_key', machineKey);
    }
    return machineKey;
}

async function getCryptoKey(tokenStr) {
    // Rely on a persistent, unique machine key rather than the transient user token to avoid decryption failures when user sessions expire or change.
    const keyStr = getOrCreateMachineKey();
    const enc = new TextEncoder();
    const keyData = enc.encode(keyStr);
    const hash = await crypto.subtle.digest('SHA-256', keyData);
    return await crypto.subtle.importKey(
        'raw',
        hash,
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt']
    );
}

async function decryptScreenshot(encryptedData, iv, tokenStr) {
    const key = await getCryptoKey(tokenStr);
    const decryptedBuffer = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        encryptedData
    );
    return new Blob([decryptedBuffer], { type: 'image/jpeg' });
}

// -------------------------
// POMODORO FOCUS MODE ENGINE
// -------------------------
let focusActive = false;
let focusTimeRemaining = 25 * 60; // 25 minutes
let focusTimerInterval = null;
let focusDistractionCheckInterval = null;
let distractingSitesList = ['facebook', 'youtube', 'twitter', 'instagram', 'netflix', 'reddit'];

function initFocusMode() {
    const focusBtn = document.getElementById('focusToggleBtn');
    if (focusBtn) {
        focusBtn.addEventListener('click', () => {
            if (focusActive) {
                stopFocusMode();
            } else {
                startFocusMode();
            }
        });
    }
}

async function loadDistractingApps() {
    // GET /tracking/rules returns this employee's RESOLVED Productivity Rules:
    // their individual rules configured on employees/{id}/edit overlaid on top
    // of the global rules. We load these first so the active-blocker enforces
    // the per-employee 'distracting' list (close window + stop timer).
    try {
        const res = await fetchWithAuth(`${API_BASE}/tracking/rules`);
        if (res.ok) {
            const data = await res.json();
            if (data.distracting_apps) {
                distractingSitesList = data.distracting_apps;
                blockList = data.distracting_apps;
                console.log("Loaded blockList from server:", blockList);
            }
        }
    } catch (e) {
        console.error("Failed to load distracting apps:", e);
    }
}

function startFocusMode() {
    if (!isTracking) {
        showToast(currentLocale === 'ar' ? 'يجب بدء التتبع أولاً لتفعيل جلسة التركيز!' : 'You must start tracking first to activate a focus session!', { variant: 'warn' });
        return;
    }
    
    focusActive = true;
    focusTimeRemaining = 25 * 60; // 25 mins
    
    const focusBtnText = document.getElementById('focusBtnText');
    if (focusBtnText) focusBtnText.textContent = __('stop_focus');
    
    const focusBtn = document.getElementById('focusToggleBtn');
    if (focusBtn) {
        focusBtn.style.background = 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)';
        focusBtn.style.boxShadow = '0 4px 12px rgba(239, 68, 68, 0.2)';
    }

    // Load distracting apps dynamically from server
    loadDistractingApps();

    // Start timer interval
    focusTimerInterval = setInterval(() => {
        if (focusTimeRemaining > 0) {
            focusTimeRemaining--;
            updateFocusTimerDisplay();
        } else {
            // Focus period completed! Trigger break
            try { playFocusWarningBeep(); } catch (e) { /* audio is best-effort */ }
            showToast(__('focus_break'));
            stopFocusMode();
        }
    }, 1000);

    // Start distraction checker (every 5 seconds)
    focusDistractionCheckInterval = setInterval(checkDistractions, 5000);
}

function stopFocusMode() {
    focusActive = false;
    if (focusTimerInterval) clearInterval(focusTimerInterval);
    if (focusDistractionCheckInterval) clearInterval(focusDistractionCheckInterval);
    
    focusTimerInterval = null;
    focusDistractionCheckInterval = null;
    
    const focusBtnText = document.getElementById('focusBtnText');
    if (focusBtnText) focusBtnText.textContent = __('start_focus');
    
    const focusBtn = document.getElementById('focusToggleBtn');
    if (focusBtn) {
        focusBtn.style.background = 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)';
        focusBtn.style.boxShadow = '0 4px 12px rgba(59, 130, 246, 0.2)';
    }
    
    focusTimeRemaining = 25 * 60;
    updateFocusTimerDisplay();
}

function updateFocusTimerDisplay() {
    const mins = Math.floor(focusTimeRemaining / 60);
    const secs = focusTimeRemaining % 60;
    const display = document.getElementById('focusTimerDisplay');
    if (display) {
        display.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
}

async function checkDistractions() {
    if (!isTracking || !focusActive) return;

    try {
        const activeWin = await window.electronAPI.getActiveWindow();
        if (activeWin) {
            const titleLower = activeWin.toLowerCase();
            let isDistracted = false;
            let offendingApp = '';

            for (const site of distractingSitesList) {
                if (titleLower.includes(site)) {
                    isDistracted = true;
                    offendingApp = site;
                    break;
                }
            }

            if (isDistracted) {
                console.warn(`Focus Mode Alert: Distracting window detected: ${activeWin}`);
                
                // Play warning sound
                playFocusWarningBeep();
                
                // Trigger native desktop notification
                new Notification(__('focus_mode_title'), {
                    body: __('focus_prohibited_alert', activeWin)
                });

                // Run PowerShell to minimize the active window to redirect employee back to work
                if (window.electronAPI && window.electronAPI.minimizeActiveWindow) {
                    window.electronAPI.minimizeActiveWindow();
                }
            }
        }
    } catch (e) {
        console.error("Distraction check error:", e);
    }
}

function playFocusWarningBeep() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        
        oscillator.type = 'sawtooth'; // Harsh alert tone
        oscillator.frequency.setValueAtTime(440, audioCtx.currentTime); // A4 note
        gainNode.gain.setValueAtTime(0.15, audioCtx.currentTime);
        
        oscillator.start();
        oscillator.stop(audioCtx.currentTime + 0.3);
        
        setTimeout(() => {
            const osc2 = audioCtx.createOscillator();
            const gain2 = audioCtx.createGain();
            osc2.connect(gain2);
            gain2.connect(audioCtx.destination);
            osc2.type = 'sawtooth';
            osc2.frequency.setValueAtTime(440, audioCtx.currentTime);
            gain2.gain.setValueAtTime(0.15, audioCtx.currentTime);
            osc2.start();
            osc2.stop(audioCtx.currentTime + 0.3);
        }, 400);
    } catch (e) {
        console.warn("Audio Context failed to play focus warning beep:", e);
    }
}

function startMjpegStream() {
    if (streamInterval) return;
    console.log("MJPEG Fallback Stream: Starting high-frequency frame capture...");
    streamInterval = setInterval(async () => {
        if (!isTracking || !streamActive) {
            stopMjpegStream();
            return;
        }
        try {
            const base64Images = await window.electronAPI.captureScreen();
            let frames = [];
            if (Array.isArray(base64Images)) {
                frames = base64Images;
            } else if (base64Images) {
                frames = [base64Images];
            }
            
            if (frames.length > 0) {
                await fetchWithAuth(`${API_BASE}/tracking/stream-frame`, {
                    method: 'POST',
                    body: JSON.stringify({ frames: frames })
                });
            }
        } catch(e) {
            console.error("MJPEG Frame upload failed:", e);
        }
    }, 1500);
}

function stopMjpegStream() {
    if (streamInterval) {
        console.log("MJPEG Fallback Stream: Stopped.");
        clearInterval(streamInterval);
        streamInterval = null;
    }
}

let reminderInterval = null;
let remindersMuted = false;

function startTrackerReminder() {
    if (reminderInterval) clearInterval(reminderInterval);
    
    console.log("Tracker Paused Reminder: Started.");
    reminderInterval = setInterval(() => {
        if (!isTracking && token && !remindersMuted) {
            console.log("Showing custom paused tracker reminder popup...");
            playReminderChime();
            if (window.electronAPI && window.electronAPI.showReminderPopup) {
                window.electronAPI.showReminderPopup();
                
                // Auto-close after 3 seconds as requested
                setTimeout(() => {
                    if (window.electronAPI && window.electronAPI.closeReminderWindow) {
                        window.electronAPI.closeReminderWindow();
                    }
                }, 3000);
            }
        }
    }, 30 * 1000); // Trigger reminder every 30 seconds (half a minute)
}

function stopTrackerReminder() {
    if (reminderInterval) {
        clearInterval(reminderInterval);
        reminderInterval = null;
    }
}

function playReminderChime() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        
        oscillator.type = 'sine'; // Soft sine wave
        oscillator.frequency.setValueAtTime(523.25, audioCtx.currentTime); // C5 note
        gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
        
        oscillator.start();
        oscillator.stop(audioCtx.currentTime + 0.15);
        
        setTimeout(() => {
            const osc2 = audioCtx.createOscillator();
            const gain2 = audioCtx.createGain();
            osc2.connect(gain2);
            gain2.connect(audioCtx.destination);
            osc2.type = 'sine';
            osc2.frequency.setValueAtTime(659.25, audioCtx.currentTime); // E5 note
            gain2.gain.setValueAtTime(0.1, audioCtx.currentTime);
            osc2.start();
            osc2.stop(audioCtx.currentTime + 0.15);
        }, 180);
    } catch (e) {
        console.warn("Audio Context failed to play reminder chime:", e);
    }
}

// Register Stop Reminding listener
if (window.electronAPI && window.electronAPI.onStopReminding) {
    window.electronAPI.onStopReminding(() => {
        console.log("Mute break reminders requested by user.");
        remindersMuted = true;
        stopTrackerReminder();
    });
}



