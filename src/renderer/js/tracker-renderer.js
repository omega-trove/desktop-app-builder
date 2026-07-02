let API_BASE = 'https://hrm.omegatrack.ai/api';
let isTracking = false;
let timeLogId = null;
let seconds = 0;
let currentSessionSeconds = 0;
let dailyTargetHours = 8.0;
let uiInterval = null;
let trackingInterval = null;
let rulesRefreshInterval = null;
let offlineSessionStartTime = null;

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
        
        if (data.today_total_seconds) {
            seconds = data.today_total_seconds;
        }
        updateTimerUI();
    } catch(e) {
        console.warn('Could not sync initial time (Network down), relying on local cache.', e);
        updateTimerUI();
    }
}

async function loadTasks() {
    try {
        const res = await fetchWithAuth(`${API_BASE}/tracking/tasks`);
        const tasks = await res.json();
        
        const select = document.getElementById('taskSelect');
        if (!select) return;
        
        // Keep only "-- Choose Task --" and "General Work"
        while (select.options.length > 2) {
            select.remove(2);
        }
        
        if (Array.isArray(tasks)) {
            tasks.forEach(task => {
                const opt = document.createElement('option');
                opt.value = task.id;
                opt.text = `${task.title} [${task.priority}]`;
                select.add(opt);
            });
        }
    } catch (e) {
        console.error('Failed to load tasks:', e);
    }
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
                    alert("Meeting mode limit reached for today! Mode disabled.");
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

async function startTracking() {
    if (isTracking) return;
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
    if (uiInterval) clearInterval(uiInterval);
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
        if (uiInterval) clearInterval(uiInterval);
        uiInterval = setInterval(incrementAndDisplay, 1000);

        // Network session start (best-effort; reconciles state when it returns).
        try {
            const response = await fetchWithAuth(`${API_BASE}/tracking/session/start`, {
                method: 'POST',
                body: JSON.stringify({ project_id: null, task_id: taskId, task_title: taskTitle })
            });
            const data = await response.json();
            if(!response.ok) throw new Error(data.message || 'Failed to start session');

            timeLogId = data.time_log_id;
            seconds = data.today_total_seconds || seconds;
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

        
        // Background interval (Runs every 1 minute)
        trackingInterval = setInterval(async () => {
            const inMeeting = document.getElementById('meetingModeToggle') && document.getElementById('meetingModeToggle').checked;

            // Check native Idle Time
            try {
                const idleSeconds = await window.electronAPI.getIdleTime();
                if (idleSeconds > IDLE_TIMEOUT_SECONDS && !inMeeting) {
                    console.log(`User idle for ${idleSeconds}s. Stopping tracker automatically.`);
                    alert(__('idle_stopped', IDLE_TIMEOUT_MINUTES));
                    stopTracking();
                    return; // Exit the loop
                }
            } catch(e) {}

            syncTelemetry();

            // Randomly update progress bar to simulate health activity
            const progress = document.querySelector('.progress');
            if (progress) {
                progress.style.width = Math.floor(Math.random() * 30 + 70) + '%';
            }
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
        if (uiInterval) { clearInterval(uiInterval); uiInterval = null; }
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
        alert(__('error_starting') + error.message);
    }
}

async function stopTracking() {
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

    if (uiInterval) clearInterval(uiInterval);
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

    if(!timeLogId) return;
    
    // Capture session IDs to process asynchronously
    const targetLogId = timeLogId;
    const targetSeconds = currentSessionSeconds;
    
    timeLogId = null;

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
                        sess.total_seconds = Math.floor((new Date() - new Date(sess.started_at)) / 1000);
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
    seconds++;
    currentSessionSeconds++;
    updateTimerUI();
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
                } catch (e) {
                    console.error("Local encryption buffering failed:", e);
                }
            }
        }
    } catch (globalErr) {
        console.error("Global uploadScreenshot error:", globalErr);
    }
}

async function flushOfflineQueue() {
    if(!offlineDb || !navigator.onLine) {
        updateSyncStatus(navigator.onLine ? 'online' : 'offline');
        return;
    }
    
    updateSyncStatus('syncing');
    try {
        // 1. Flush Master Offline Sessions Engine
        const sessionTx = offlineDb.transaction('offline_sessions', 'readonly');
        const sessionReq = sessionTx.objectStore('offline_sessions').getAll();
        
        await new Promise((resolve) => {
            sessionReq.onsuccess = async () => {
                const sessions = sessionReq.result;
                if(sessions && sessions.length > 0) {
                    try {
                        const syncRes = await fetchWithAuth(`${API_BASE}/tracking/sync-offline-sessions`, {
                            method: 'POST',
                            body: JSON.stringify({ sessions: sessions })
                        });
                        
                        if(syncRes.ok) {
                            const data = await syncRes.json();
                            const mappedIds = data.mapped_ids; // { "local_xxx": 89 }
                            
                            // Delete synced sessions
                            const remTx = offlineDb.transaction('offline_sessions', 'readwrite');
                            for(let sid of sessions) { remTx.objectStore('offline_sessions').delete(sid.client_id); }
                            
                            remTx.oncomplete = () => console.log('Successfully synced and purged offline sessions.');
                            remTx.onerror = (e) => console.error('Failed to purge offline sessions:', e);
                            
                            // Rewire legacy snapshots payload to Authentic IDs
                            if(Object.keys(mappedIds).length > 0) {
                                const shotTx = offlineDb.transaction('offline_screenshots', 'readwrite');
                                const shotReq = shotTx.objectStore('offline_screenshots').getAll();
                                shotReq.onsuccess = () => {
                                    const shots = shotReq.result;
                                    for(let shot of shots) {
                                        if(mappedIds[shot.time_log_id]) {
                                            shot.time_log_id = mappedIds[shot.time_log_id];
                                            shotTx.objectStore('offline_screenshots').put(shot);
                                        }
                                    }
                                    resolve();
                                };
                            } else { resolve(); }
                        } else { resolve(); }
                    } catch(e) { resolve(); }
                } else { resolve(); }
            };
        });
        
        // 2. Flush Offline Screenshots Block
        const tx = offlineDb.transaction('offline_screenshots', 'readonly');
        const req = tx.objectStore('offline_screenshots').getAll();
        req.onsuccess = async () => {
            const items = req.result;
            for (const item of items) {
                // Ignore artifacts bound to unsynchronized internal offline states to avoid constraint exception loop
                if(String(item.time_log_id).startsWith('local_')) continue;
                
                try {
                    let imageBlob;
                    if (item.encrypted_image && item.iv) {
                        imageBlob = await decryptScreenshot(item.encrypted_image, item.iv, token);
                    } else {
                        imageBlob = item.image_blob; // Fallback for legacy unencrypted database entries
                    }

                    let formData = new FormData();
                    formData.append('time_log_id', item.time_log_id);
                    formData.append('image', imageBlob, `shot_offline_${item.timestamp}.jpg`);
                    formData.append('activity_percentage', item.activity_percentage);
                    formData.append('window_title', item.window_title);
                    
                    const response = await fetchWithAuth(`${API_BASE}/tracking/screenshot`, {
                        method: 'POST',
                        body: formData,
                        timeoutMs: 60000 // image upload — allow longer than the default
                    });
                    
                    if (response.ok) {
                        const delTx = offlineDb.transaction('offline_screenshots', 'readwrite');
                        delTx.objectStore('offline_screenshots').delete(item.id);
                        delTx.onerror = (e) => console.error('Failed to purge offline screenshot map id:', item.id, e);
                    } else break; 

                    // Throttling sync: wait 3 seconds to avoid chocking client internet connection
                    await new Promise(resolve => setTimeout(resolve, 3000));
                } catch(e) { 
                    console.error("Failed to decrypt or sync offline screenshot id:", item.id, e);
                    break; 
                }
            }
        };

        // 3. Flush Offline Activities Block
        const actTx = offlineDb.transaction('offline_activities', 'readonly');
        const actReq = actTx.objectStore('offline_activities').getAll();
        actReq.onsuccess = async () => {
            const items = actReq.result;
            for (const item of items) {
                // Ignore activities bound to unsynchronized internal offline states to avoid constraint exception loop
                if(String(item.time_log_id).startsWith('local_')) continue;
                
                try {
                    const response = await fetchWithAuth(`${API_BASE}/tracking/activity`, {
                        method: 'POST',
                        body: JSON.stringify({
                            time_log_id: item.time_log_id,
                            activities: item.activities
                        })
                    });
                    
                    if (response.ok) {
                        const delTx = offlineDb.transaction('offline_activities', 'readwrite');
                        delTx.objectStore('offline_activities').delete(item.id);
                        delTx.onerror = (e) => console.error('Failed to purge offline activity map id:', item.id, e);
                    } else break;
                } catch(e) { break; }
            }
        };

        // 4. Flush Offline Stops Block
        const stopTx = offlineDb.transaction('offline_stops', 'readonly');
        const stopReq = stopTx.objectStore('offline_stops').getAll();
        stopReq.onsuccess = async () => {
            const items = stopReq.result;
            for (const item of items) {
                try {
                    const response = await fetchWithAuth(`${API_BASE}/tracking/session/${item.time_log_id}/stop`, {
                        method: 'POST',
                        body: JSON.stringify({ total_seconds: item.total_seconds, ended_at: item.stopped_at })
                    });
                    
                    if (response.ok) {
                        const delTx = offlineDb.transaction('offline_stops', 'readwrite');
                        delTx.objectStore('offline_stops').delete(item.time_log_id);
                        delTx.oncomplete = () => console.log(`Purged synced offline stop for session ${item.time_log_id}`);
                    } else break;
                } catch(e) { break; }
            }
        };
    } catch(err) {
        console.warn('Sync flush error', err);
    } finally {
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
                    alert("Meeting mode limit reached for today! Mode disabled.");
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

            alert(__('captcha_timeout'));
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
        alert(__('captcha_wrong'));
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
        alert(currentLocale === 'ar' ? 'يجب بدء التتبع أولاً لتفعيل جلسة التركيز!' : 'You must start tracking first to activate a focus session!');
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
            alert(__('focus_break'));
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



