const { app, BrowserWindow, ipcMain, powerMonitor, screen, desktopCapturer, Tray, Menu, dialog, nativeImage, safeStorage, systemPreferences, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec: _rawExec } = require('child_process');

// Track every spawned native child process (PowerShell helpers, etc.) so they
// can be force-killed on exit — prevents zombie processes from holding the app open.
const childProcesses = new Set();
function exec(...args) {
    const cp = _rawExec(...args);
    if (cp && typeof cp.kill === 'function') {
        childProcesses.add(cp);
        cp.on('exit', () => childProcesses.delete(cp));
    }
    return cp;
}
const { autoUpdater } = require('electron-updater');

// Global variables
let mainWindow;
let distractionLockActive = false;
let tray = null;
let config = { API_BASE: 'http://localhost:8000/api' }; // Default fallback
let authSessionToken = null;
let isQuitting = false;
let isTracking = false;   // mirrored from the renderer (counter running or not)
let appLocale = 'ar';     // mirrored from the renderer UI language (for native dialogs)

let activeWindowTitle = 'Unknown Window';
let windowTrackerProcess = null;

function startWindowTracker() {
    if (process.platform !== 'win32') return;
    
    try {
        const trackerPath = path.join(__dirname, 'window-tracker.exe');
        if (fs.existsSync(trackerPath)) {
            const { spawn } = require('child_process');
            windowTrackerProcess = spawn(trackerPath, [], {
                stdio: ['ignore', 'pipe', 'ignore']
            });

            windowTrackerProcess.stdout.on('data', (data) => {
                const line = data.toString('utf8').trim();
                if (line) {
                    activeWindowTitle = line;
                }
            });

            windowTrackerProcess.on('error', (err) => {
                console.error('❌ Window tracker process error:', err);
            });

            windowTrackerProcess.on('exit', (code) => {
                console.log(`ℹ️ Window tracker process exited with code ${code}`);
                // Restart it if it wasn't intentionally killed
                if (!isQuitting) {
                    setTimeout(startWindowTracker, 5000);
                }
            });
        } else {
            console.warn('⚠️ window-tracker.exe not found at:', trackerPath);
        }
    } catch (err) {
        console.error('❌ Failed to spawn window-tracker.exe:', err);
    }
}

// Force-kill any tracked native child processes.
function killAllChildren() {
    if (windowTrackerProcess) {
        try { windowTrackerProcess.kill(); } catch (e) {}
        windowTrackerProcess = null;
    }
    for (const cp of childProcesses) {
        try { cp.kill('SIGKILL'); } catch (e) { /* already exited */ }
    }
    childProcesses.clear();
}

// Single, definitive teardown — safe to call from any quit path.
function cleanupAndQuit() {
    isQuitting = true;
    killAllChildren();
    try { if (tray) { tray.destroy(); tray = null; } } catch (e) {}
    for (const w of BrowserWindow.getAllWindows()) {
        try { w.destroy(); } catch (e) {}
    }
    app.exit(0); // hard exit — guarantees no zombie/renderer survives
}

// Full exit that first lets the renderer flush its offline queue.
// Primary path: renderer flushes → replies 'confirm-close' → cleanupAndQuit().
// The timer is only a last-resort guard so a wedged renderer can never hang exit.
function gracefulQuit() {
    if (isQuitting) return;
    isQuitting = true;

    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        mainWindow.webContents.send('flush-and-quit');
        // Safety net, not the primary mechanism. It has to outlast the renderer's
        // shutdown work — closing the session on the server (capped at 8s) and
        // then flushing the offline queue — or a slow network would get the
        // renderer killed mid-stop, which is the data loss this whole path exists
        // to prevent. Anything still unsent by then is already durable in
        // IndexedDB and goes out on the next launch.
        setTimeout(cleanupAndQuit, 12000);
    } else {
        cleanupAndQuit();
    }
}

// Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
    process.exit(0);
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}

// Load configuration from env.json
function loadConfig() {
    const configPath = path.join(__dirname, '../../env.json');

    try {
        if (fs.existsSync(configPath)) {
            const rawData = fs.readFileSync(configPath, 'utf-8');
            config = JSON.parse(rawData);
            console.log('✅ Config loaded successfully. API_BASE:', config.API_BASE);
        } else {
            console.warn('⚠️ env.json not found. Using default localhost.');
        }
    } catch (err) {
        console.error('❌ Failed to load env.json:', err);
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 420,
        height: 680,
        resizable: true,
        title: "Omega Tracker",
        icon: path.join(__dirname, '../../assets/icon.ico'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            enableRemoteModule: false,
            // The renderer holds the whole electronAPI bridge — screen capture,
            // token access, input simulation — so it runs in the OS sandbox too.
            // The preload only uses contextBridge/ipcRenderer, both of which are
            // available to a sandboxed preload; keep it that way.
            sandbox: true,
            backgroundThrottling: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, '../renderer/views/login.html'));

    // Distraction-lock focus trap: while a distraction warning is active the
    // window must stay in front and cannot be clicked behind. Any attempt to
    // focus another app blurs us, so we immediately pull ourselves back on top.
    mainWindow.on('blur', () => {
        if (!distractionLockActive || !mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.moveTop();
        mainWindow.focus();
    });

    // Disable Top Menu
    mainWindow.setMenu(null);
    mainWindow.setMenuBarVisibility(false);

    // Prevent Inspect Element
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
            event.preventDefault();
        }
    });

    // Auto Updater
    autoUpdater.checkForUpdatesAndNotify().catch(err => {
        console.error('AutoUpdater Error:', err);
    });

    // Close (X) button or close actions:
    // 1. If tracking is active: hide the window and continue in background.
    // 2. If tracking is stopped: prompt the user to exit or keep running in background.
    mainWindow.on('close', (e) => {
        if (isQuitting) return; // Exit from system tray / Cmd+Q -> allow close
        e.preventDefault();

        if (distractionLockActive) {
            return;
        }

        if (isTracking) {
            mainWindow.hide(); // Tracking is active -> hide in background
            return;
        }

        // Tracking is stopped -> prompt options
        const isAr = appLocale === 'ar';
        const title = isAr ? 'خروج من التطبيق' : 'Quit Application';
        const message = isAr 
            ? 'مؤقت تتبع الوقت متوقف حالياً. هل ترغب في إغلاق التطبيق تماماً أم إبقائه يعمل في الخلفية؟' 
            : 'Time tracking is currently stopped. Do you want to exit the application completely or keep it running in the background?';
        const buttons = isAr 
            ? ['إغلاق تماماً', 'الاستمرار في الخلفية'] 
            : ['Exit Completely', 'Keep Running in Background'];

        dialog.showMessageBox(mainWindow, {
            type: 'question',
            buttons: buttons,
            defaultId: 1,
            title: title,
            message: message,
            cancelId: 1
        }).then(({ response }) => {
            if (response === 0) {
                gracefulQuit();
            } else {
                mainWindow.hide();
            }
        }).catch(err => {
            console.error('Error showing exit dialog:', err);
            mainWindow.hide();
        });
    });
}

function createTray() {
    let icon;
    if (process.platform === 'win32') {
        const iconPath = path.join(__dirname, '../../assets/icon.ico');
        icon = nativeImage.createFromPath(iconPath);
    } else {
        // macOS / Linux: Load PNG, resize to standard menu bar dimensions (22x22)
        const iconPath = path.join(__dirname, '../../assets/icon.png');
        icon = nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 });
        if (process.platform === 'darwin') {
            icon.setTemplateImage(true); // Automatically adapt to Light/Dark menu bar theme
        }
    }
    tray = new Tray(icon);
    
    const contextMenu = Menu.buildFromTemplate([
        { 
            label: 'إظهار التطبيق', 
            click: () => {
                if (mainWindow) {
                    mainWindow.show();
                    mainWindow.focus();
                }
            }
        },
        { 
            label: 'خروج',
            click: () => {
                // Explicit Exit → flush the offline queue, then full teardown.
                gracefulQuit();
            }
        }
    ]);
    
    tray.setToolTip('Omega Tracker');
    tray.setContextMenu(contextMenu);
    
    tray.on('click', () => {
        if (mainWindow) {
            if (mainWindow.isVisible()) {
                mainWindow.focus();
            } else {
                mainWindow.show();
            }
        }
    });
}

// Disable hardware acceleration only on Windows to avoid black screen screenshot issues,
// while keeping it active on macOS/Linux for smooth UI rendering performance.
if (process.platform === 'win32') {
    app.disableHardwareAcceleration();
}

/**
 * Origins the renderer legitimately talks to, derived from the loaded config so
 * a self-hosted API_BASE is covered without editing this list.
 */
function allowedConnectOrigins() {
    const origins = new Set([
        'https://freeipapi.com',   // geo-IP fallbacks used by getNativeLocation
        'https://ipapi.co',
        'https://ipwho.is',
    ]);

    try {
        if (config && config.API_BASE) {
            // env.json ships API_BASE without a scheme ("hrm.omegatrack.ai/api").
            // Both renderers already prepend https:// before using it; the CSP has
            // to normalise identically or new URL() throws, the origin is dropped
            // from connect-src, and every API call is blocked by our own policy.
            const raw = String(config.API_BASE).trim();
            const absolute = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
            origins.add(new URL(absolute).origin);
        }
    } catch (err) {
        console.warn('⚠️ Could not derive an origin from API_BASE for the CSP:', err.message);
    }

    return Array.from(origins);
}

/**
 * Content-Security-Policy for the renderer.
 *
 * There was none at all. The renderer holds the full electronAPI bridge —
 * screen capture, token access, input simulation — so any script that reached
 * it would inherit all of that. script-src is 'self' only, which is why the
 * three inline <script> blocks in the views were extracted into modules first.
 *
 * style-src keeps 'unsafe-inline': the views carry inline style attributes
 * throughout, and removing them is a markup refactor rather than a security fix.
 * It is a far smaller exposure than inline script and is noted as follow-up.
 */
function contentSecurityPolicy() {
    return [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        `connect-src 'self' ${allowedConnectOrigins().join(' ')}`,
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
    ].join('; ');
}

/**
 * Deny-by-default navigation. Without these a renderer that follows a hostile
 * link replaces the trusted document while keeping the preload bridge, and any
 * window.open() spawns a full BrowserWindow with the same privileges.
 */
function hardenNavigation(contents) {
    contents.on('will-navigate', (event, url) => {
        const current = contents.getURL();
        // Only in-app file:// navigation between the bundled views is allowed.
        if (url.startsWith('file://') && current.startsWith('file://')) return;

        event.preventDefault();
        console.warn('⛔ Blocked in-app navigation to', url);
    });

    contents.setWindowOpenHandler(({ url }) => {
        // Never open a second privileged window. A genuine external link goes to
        // the user's browser, where it has no access to this app.
        if (/^https:\/\//i.test(url)) {
            shell.openExternal(url).catch((err) => console.warn('Could not open externally:', err));
        } else {
            console.warn('⛔ Blocked window.open for', url);
        }
        return { action: 'deny' };
    });

    contents.on('will-attach-webview', (event) => {
        event.preventDefault();
        console.warn('⛔ Blocked <webview> attachment');
    });
}

/**
 * OS sleep / wake and screen lock.
 *
 * powerMonitor was imported for getSystemIdleTime() and nothing else, so a
 * suspend was invisible to the app. Chromium freezes timers while the machine is
 * asleep, then fires the pending one on wake with a delta covering the whole
 * suspension — which the renderer's clock now discards, but only because it
 * happens to exceed the sleep threshold. Telling the renderer explicitly is the
 * difference between a guess and a fact: it re-anchors against wall-clock,
 * reconciles the daily total with the server, and flushes anything the network
 * dropped while the lid was shut.
 */
function registerPowerLifecycle() {
    const notifyRenderer = (channel, payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(channel, payload);
        }
    };

    let suspendedAt = null;

    powerMonitor.on('suspend', () => {
        suspendedAt = Date.now();
        console.log('💤 System suspending — pausing the counter.');
        notifyRenderer('power-suspend', { at: suspendedAt });
    });

    powerMonitor.on('resume', () => {
        const sleptMs = suspendedAt ? Date.now() - suspendedAt : null;
        suspendedAt = null;
        console.log(`☀️ System resumed after ${sleptMs === null ? 'unknown' : Math.round(sleptMs / 1000) + 's'}.`);
        notifyRenderer('power-resume', { sleptMs });
    });

    // Locking the screen is not sleeping — the machine keeps running and a
    // tracked session may legitimately continue — so this is reported for
    // completeness and left for the renderer's idle rules to act on.
    powerMonitor.on('lock-screen', () => notifyRenderer('power-lock', {}));
    powerMonitor.on('unlock-screen', () => notifyRenderer('power-unlock', {}));
}

app.whenReady().then(() => {
    loadConfig();        // Load API config first

    // Auto-approve Geolocation, Media, and Display Capture permissions for the app
    const { session } = require('electron');

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Content-Security-Policy': [contentSecurityPolicy()],
            },
        });
    });

    app.on('web-contents-created', (_event, contents) => hardenNavigation(contents));
    BrowserWindow.getAllWindows().forEach((win) => hardenNavigation(win.webContents));

    registerPowerLifecycle();
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        if (['geolocation', 'media', 'display-capture'].includes(permission)) {
            return callback(true);
        }
        callback(false);
    });

    session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
        if (['geolocation', 'media', 'display-capture'].includes(permission)) {
            return true;
        }
        return false;
    });

    createWindow();
    createTray();

    // Start background native window tracker (Windows only)
    startWindowTracker();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
            createTray();
        }
    });
});

app.on('window-all-closed', () => {
    // Single-instance tracker: quit on every platform (incl. macOS) once the
    // window is truly closed, rather than lingering in the background.
    cleanupAndQuit();
});

// CRITICAL (macOS): when the OS/user initiates quit (Cmd+Q, Force Quit's SIGTERM,
// or app.quit()), flag it so the window 'close' interceptor stops hiding-to-tray
// and lets the app actually exit — otherwise it survives as a zombie process.
app.on('before-quit', () => {
    isQuitting = true;
    killAllChildren();
    if (tray) { try { tray.destroy(); } catch (e) {} tray = null; }
});

// Honour OS termination signals and never hang on an unhandled error.
process.on('SIGTERM', cleanupAndQuit);
process.on('SIGINT', cleanupAndQuit);
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));

// ====================== IPC Handlers ======================

// Send config to renderer
ipcMain.handle('get-config', () => {
    return config;
});

// Screenshot handler
ipcMain.handle('capture-screen', async () => {
    try {
        // Guard against a hung native capture wedging the process (macOS freeze).
        const sources = await Promise.race([
            desktopCapturer.getSources({
                types: ['screen'],
                thumbnailSize: { width: 1920, height: 1080 }
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('capture-screen timeout')), 8000))
        ]);
        const frames = [];
        for (const source of sources) {
            const imgBuffer = source.thumbnail.toJPEG(80);
            frames.push(`data:image/jpeg;base64,${imgBuffer.toString('base64')}`);
        }
        return frames;
    } catch (err) {
        console.error('Screenshot capture error:', err);
        return [];
    }
});

ipcMain.handle('get-screen-sources', async () => {
    try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        return sources.map(source => ({
            id: source.id,
            name: source.name
        }));
    } catch (err) {
        console.error('get-screen-sources error:', err);
        return [];
    }
});

// Request user attention (Anti-Cheat)
ipcMain.handle('request-attention', () => {
    if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
        mainWindow.flashFrame(true);
    }
});

// ── macOS permission pre-flight ─────────────────────────────────────────────
// macOS gates screenshots behind "Screen Recording" and active-window title /
// focus-rule enforcement behind "Accessibility" (TCC). Both must be granted
// manually in System Settings, and until they are the features silently
// under-function (black screenshots, "Unknown Window"). We detect what's
// missing and deep-link the user straight to the correct Privacy pane.
function getMacPermissionStatus() {
    if (process.platform !== 'darwin') {
        // Windows/Linux need no TCC grants for what we do.
        return { isMac: false, screen: 'granted', accessibility: true, ok: true };
    }
    // 'granted' | 'denied' | 'restricted' | 'not-determined'
    let screen = 'granted';
    let accessibility = true;
    try { screen = systemPreferences.getMediaAccessStatus('screen'); } catch (e) {}
    try { accessibility = systemPreferences.isTrustedAccessibilityClient(false); } catch (e) {}
    return {
        isMac: true,
        screen,
        accessibility,
        ok: screen === 'granted' && accessibility === true,
    };
}

function openPrivacyPane(pane) {
    const urls = {
        screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
        accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    };
    const url = urls[pane];
    if (url) { shell.openExternal(url).catch(() => {}); }
}

// Non-interactive status check (used by the renderer to show/refresh a banner).
ipcMain.handle('check-mac-permissions', () => getMacPermissionStatus());

// Open a specific Privacy pane on demand (banner buttons).
ipcMain.handle('open-privacy-pane', (event, pane) => { openPrivacyPane(pane); return true; });

// Interactive guide: shown once on the tracker screen when something is missing.
// Triggers the native Accessibility prompt (so the app appears in the list) and
// deep-links the user to the pane(s) they still need to enable.
ipcMain.handle('guide-mac-permissions', async () => {
    const status = getMacPermissionStatus();
    if (!status.isMac || status.ok) return status;

    // Registers the app in the Accessibility list and shows the native prompt,
    // so the toggle is actually present when the user opens the pane.
    if (!status.accessibility) {
        try { systemPreferences.isTrustedAccessibilityClient(true); } catch (e) {}
    }

    const isAr = appLocale === 'ar';
    const missing = [];
    if (status.screen !== 'granted') {
        missing.push(isAr ? '• تسجيل الشاشة (مطلوب لالتقاط لقطات الشاشة)' : '• Screen Recording (required for screenshots)');
    }
    if (!status.accessibility) {
        missing.push(isAr ? '• الإتاحة Accessibility (مطلوب لتتبّع النافذة النشطة وقواعد التركيز)' : '• Accessibility (required for active-window tracking & focus rules)');
    }

    const detail = (isAr
        ? 'يحتاج Omega Tracker إلى الأذونات التالية للعمل بشكل صحيح على نظام macOS:\n\n'
        : 'Omega Tracker needs the following macOS permission(s) to work correctly:\n\n')
        + missing.join('\n')
        + (isAr
            ? '\n\nافتح الإعدادات، فعّل Omega Tracker في القائمة، ثم أعد تشغيل التطبيق.'
            : '\n\nOpen Settings, enable Omega Tracker in the list, then restart the app.');

    const buttons = [];
    const actions = [];
    if (status.screen !== 'granted') { buttons.push(isAr ? 'فتح تسجيل الشاشة' : 'Open Screen Recording'); actions.push('screen'); }
    if (!status.accessibility) { buttons.push(isAr ? 'فتح الإتاحة' : 'Open Accessibility'); actions.push('accessibility'); }
    buttons.push(isAr ? 'لاحقاً' : 'Later'); actions.push('later');

    const dialogOpts = {
        type: 'warning',
        title: 'Omega Tracker',
        message: isAr ? 'أذونات نظام macOS مطلوبة' : 'macOS permissions required',
        detail,
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
        noLink: true,
    };
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;

    let response = buttons.length - 1;
    try {
        const res = parent
            ? await dialog.showMessageBox(parent, dialogOpts)
            : await dialog.showMessageBox(dialogOpts);
        response = res.response;
    } catch (e) { /* dialog failed — return status anyway */ }

    const action = actions[response];
    if (action === 'screen' || action === 'accessibility') { openPrivacyPane(action); }
    return status;
});

// Get system idle time
ipcMain.handle('get-idle-time', () => {
    return powerMonitor.getSystemIdleTime();
});

// Get real active OS window title
ipcMain.handle('get-active-window', () => {
    if (process.platform === 'win32') {
        if (windowTrackerProcess && !windowTrackerProcess.killed) {
            return activeWindowTitle;
        }
        // Self-Healing Fallback: If the compiled helper is missing or crashed, use PowerShell as backup
        return new Promise((resolve) => {
            const psScript = `
Add-Type -TypeDefinition '
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
}
';
$hwnd = [Win32]::GetForegroundWindow();
$sb = New-Object System.Text.StringBuilder 512;
[Win32]::GetWindowText($hwnd, $sb, 512) | Out-Null;
$sb.ToString()
`;
            try {
                const base64 = Buffer.from(psScript, 'utf-16le').toString('base64');
                exec(`powershell -NoProfile -NonInteractive -EncodedCommand ${base64}`, (error, stdout) => {
                    if (error) {
                        resolve('Unknown Window');
                    } else {
                        const title = stdout ? stdout.trim() : '';
                        resolve(title || 'Unknown Window');
                    }
                });
            } catch (err) {
                resolve('Unknown Window');
            }
        });
    } else {
        return new Promise((resolve) => {
            if (process.platform === 'darwin') {
                const script = `tell application "System Events"
                    try
                        set frontmostProcess to first process whose frontmost is true
                        set procName to name of frontmostProcess
                    on error
                        return "Unknown Window"
                    end try
                end tell

                try
                    if procName is "Google Chrome" then
                        tell application "Google Chrome" to set resVal to title of active tab of window 1
                        return "Google Chrome - " & resVal
                    else if procName is "Safari" then
                        tell application "Safari" to set resVal to name of current tab of window 1
                        return "Safari - " & resVal
                    else if procName is "Microsoft Edge" then
                        tell application "Microsoft Edge" to set resVal to title of active tab of window 1
                        return "Microsoft Edge - " & resVal
                    else if procName is "Brave Browser" then
                        tell application "Brave Browser" to set resVal to title of active tab of window 1
                        return "Brave Browser - " & resVal
                    else
                        error
                    end if
                on error
                    tell application "System Events"
                        try
                            set winTitle to name of first window of frontmostProcess
                        on error
                            set winTitle to ""
                        end try
                        if winTitle is not "" then
                            return procName & " - " & winTitle
                        else
                            return procName
                        end if
                    end tell
                end try`;
                const escapedScript = script.replace(/'/g, "'\\''");
                exec(`osascript -e '${escapedScript}'`, (error, stdout) => {
                    if (error) {
                        resolve('Unknown Window');
                    } else {
                        resolve(stdout ? stdout.trim() : 'Unknown Window');
                    }
                });
            } else {
                // Linux fallback for now
                resolve('Unknown Window (Not Supported OS)');
            }
        });
    }
});

// Get Native OS Geolocation (Windows PowerShell watcher)
ipcMain.handle('get-native-location', () => {
    return new Promise((resolve) => {
        if (process.platform === 'win32') {
            const psScript = `
Add-Type -AssemblyName System.Device
$watcher = New-Object System.Device.Location.GeoCoordinateWatcher
$watcher.Start()
$timeout = 40
while (($watcher.Status -ne 'Ready') -and ($watcher.Permission -ne 'Denied') -and ($timeout -gt 0)) {
    Start-Sleep -Milliseconds 100
    $timeout--
}
if ($watcher.Position.Location.IsUnknown -eq $false) {
    Write-Output ($watcher.Position.Location.Latitude.ToString() + "," + $watcher.Position.Location.Longitude.ToString())
} else {
    Write-Output "unknown"
}
`;
            try {
                const base64 = Buffer.from(psScript, 'utf-16le').toString('base64');
                exec(`powershell -NoProfile -NonInteractive -EncodedCommand ${base64}`, (error, stdout) => {
                    if (error) {
                        resolve('unknown');
                    } else {
                        const output = stdout ? stdout.trim() : '';
                        resolve(output || 'unknown');
                    }
                });
            } catch (err) {
                resolve('unknown');
            }
        } else {
            // macOS / Linux fallback
            resolve('unknown');
        }
    });
});

// The only views that exist. `page` arrived from the renderer and went straight
// into a path join, so any string containing ../ could load an arbitrary local
// .html file into a window that carries the full preload bridge. Whitelist the
// three real views rather than trying to sanitise the string.
const ALLOWED_VIEWS = new Set(['login', 'tracker', 'reminder']);

// Navigation handler
ipcMain.on('navigate-to', (event, page) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    if (!ALLOWED_VIEWS.has(page)) {
        console.warn('⛔ Blocked navigation to an unknown view:', page);
        return;
    }

    // Leaving the tracker for the login screen must ALWAYS fully release the
    // distraction lock. Otherwise the always-on-top + blur-refocus focus trap
    // would persist on the login window and freeze it (Sign In appears to do
    // nothing). This is a hard safety reset independent of renderer state.
    if (page === 'login') {
        distractionLockActive = false;
        mainWindow.setAlwaysOnTop(false);
        mainWindow.setMinimizable(true);
        mainWindow.flashFrame(false);

        // Safely close the floating reminder popup window on logout
        if (reminderWindow && !reminderWindow.isDestroyed()) {
            try {
                reminderWindow.close();
            } catch (e) {
                console.error('Error closing reminder window on logout:', e);
            }
            reminderWindow = null;
        }
    }

    mainWindow.loadFile(path.join(__dirname, `../renderer/views/${page}.html`));
});

// Optional: Send API_BASE to renderer on demand
ipcMain.handle('get-api-base', () => config.API_BASE);

// Secure Identity Token Storage (with safeStorage encryption on disk)
const secureTokenPath = path.join(app.getPath('userData'), 'session_token.enc');

ipcMain.handle('get-token', () => {
    if (authSessionToken) return authSessionToken;
    
    try {
        if (fs.existsSync(secureTokenPath)) {
            // Tighten permissions left behind by an older build that wrote with
            // the default mode.
            try { fs.chmodSync(secureTokenPath, 0o600); } catch (e) { /* best effort */ }

            const encryptedBuffer = fs.readFileSync(secureTokenPath);
            if (safeStorage.isEncryptionAvailable()) {
                authSessionToken = safeStorage.decryptString(encryptedBuffer);
            } else {
                authSessionToken = encryptedBuffer.toString('utf8');
            }
            return authSessionToken;
        }
    } catch (err) {
        console.error('❌ Failed to decrypt secure token from disk:', err);
    }
    return null;
});

// True once we have warned about an unencrypted fallback, so the warning is
// loud but not repeated on every token write.
let warnedAboutPlaintextToken = false;

ipcMain.on('set-token', (event, token) => {
    authSessionToken = token;
    try {
        const dir = path.dirname(secureTokenPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        if (safeStorage.isEncryptionAvailable()) {
            fs.writeFileSync(secureTokenPath, safeStorage.encryptString(token), { mode: 0o600 });
            return;
        }

        // No OS keyring (common on a Linux box without gnome-keyring/kwallet).
        // The token is a bearer credential for the whole account, and the file
        // is named .enc, so writing it in the clear without saying so was a
        // silent downgrade. Restrict it to the owner and say it out loud.
        fs.writeFileSync(secureTokenPath, Buffer.from(token, 'utf8'), { mode: 0o600 });

        if (!warnedAboutPlaintextToken) {
            warnedAboutPlaintextToken = true;
            console.warn(
                '⚠️  OS encryption (safeStorage) is unavailable on this machine. ' +
                'The session token is stored UNENCRYPTED at ' + secureTokenPath + ' ' +
                '(permissions 0600). Install a system keyring to enable encryption at rest.'
            );
        }
    } catch (err) {
        console.error('❌ Failed to save session token to disk:', err);
    }
});

ipcMain.on('clear-token', () => {
    authSessionToken = null;
    try {
        if (fs.existsSync(secureTokenPath)) {
            fs.unlinkSync(secureTokenPath);
        }
    } catch (err) {
        console.error('❌ Failed to delete secure token from disk:', err);
    }
});

// Renderer mirrors the counter state here so the close handler knows whether
// tracking is currently running (hide & keep tracking) or not (ask the user).
ipcMain.on('set-tracking-active', (event, active) => {
    isTracking = !!active;
});

// Renderer mirrors the current UI language so native dialogs match it.
ipcMain.on('set-locale', (event, locale) => {
    appLocale = (locale === 'ar') ? 'ar' : 'en';
});

// Minimize foreground active window
ipcMain.handle('minimize-active-window', () => {
    return new Promise((resolve) => {
        if (process.platform === 'win32') {
            const psScript = `
Add-Type -TypeDefinition '
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
';
$hwnd = [Win32]::GetForegroundWindow();
[Win32]::ShowWindow($hwnd, 6) | Out-Null; # SW_MINIMIZE = 6
`;
            try {
                const base64 = Buffer.from(psScript, 'utf-16le').toString('base64');
                exec(`powershell -NoProfile -NonInteractive -EncodedCommand ${base64}`, (error) => {
                    resolve(!error);
                });
            } catch (err) {
                resolve(false);
            }
        } else if (process.platform === 'darwin') {
            const script = `tell application "System Events"
                try
                    set frontmostProcess to first process whose frontmost is true
                    set procName to name of frontmostProcess
                    try
                        tell application procName to set miniaturized of window 1 to true
                    on error
                        try
                            set value of attribute "AXMinimized" of window 1 of process procName to true
                        on error
                            try
                                set collapsed of window 1 of process procName to true
                            on error
                                -- Fallback to standard command+M keystroke
                                tell application "System Events" to keystroke "m" using command down
                            end try
                        end try
                    end try
                    return "success"
                on error
                    return "failed"
                end try
            end tell`;
            const escapedScript = script.replace(/'/g, "'\\''");
            exec(`osascript -e '${escapedScript}'`, (error, stdout) => {
                if (error) {
                    resolve(false);
                } else {
                    resolve(stdout && stdout.trim() === 'success');
                }
            });
        } else {
            resolve(false);
        }
    });
});

// Force-close the foreground active window
// Used to enforce per-employee 'distracting' productivity rules: when a blocked
// app/website is opened we gracefully close its window and the
// renderer then completely stops the tracking timer.
ipcMain.handle('close-active-window', () => {
    return new Promise((resolve) => {
        if (process.platform === 'win32') {
            const psScript = `
Add-Type -TypeDefinition '
using System;
using System.Runtime.InteropServices;
public class Win32Close {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
';
$hwnd = [Win32Close]::GetForegroundWindow();
[Win32Close]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null; # WM_CLOSE = 0x0010
`;
            try {
                const base64 = Buffer.from(psScript, 'utf-16le').toString('base64');
                exec(`powershell -NoProfile -NonInteractive -EncodedCommand ${base64}`, (error) => {
                    resolve(!error);
                });
            } catch (err) {
                resolve(false);
            }
        } else if (process.platform === 'darwin') {
            const script = `tell application "System Events"
                try
                    set frontmostProcess to first process whose frontmost is true
                    set procName to name of frontmostProcess
                on error
                    return "failed"
                end try
            end tell

            try
                if procName is "Google Chrome" then
                    try
                        tell application "Google Chrome" to delete active tab of window 1
                    on error
                        tell application "System Events" to keystroke "w" using command down
                    end try
                else if procName is "Safari" then
                    try
                        tell application "Safari" to close current tab of window 1
                    on error
                        tell application "System Events" to keystroke "w" using command down
                    end try
                else if procName is "Microsoft Edge" then
                    try
                        tell application "Microsoft Edge" to delete active tab of window 1
                    on error
                        tell application "System Events" to keystroke "w" using command down
                    end try
                else if procName is "Brave Browser" then
                    try
                        tell application "Brave Browser" to delete active tab of window 1
                    on error
                        tell application "System Events" to keystroke "w" using command down
                    end try
                else
                    error
                end if
                return "success"
            on error
                try
                    tell application procName to close window 1
                    return "success"
                on error
                    try
                        tell application procName to quit
                        return "success"
                    on error
                        try
                            tell application "System Events" to keystroke "q" using command down
                            return "success"
                        on error
                            return "failed"
                        end try
                    end try
                end try
            end try`;
            const escapedScript = script.replace(/'/g, "'\\''");
            exec(`osascript -e '${escapedScript}'`, (error, stdout) => {
                if (error) {
                    resolve(false);
                } else {
                    resolve(stdout && stdout.trim() === 'success');
                }
            });
        } else {
            resolve(false);
        }
    });
});

// Simulate OS-level Mouse Click at coordinates (Windows & macOS)
/**
 * Coerce a renderer-supplied coordinate into an integer inside the primary
 * display, or return null.
 *
 * Both platform branches below interpolate these values into a shell script —
 * PowerShell on Windows, JXA on macOS. Nothing else validated them. The one
 * caller today happens to sanitise by accident (parseFloat then Math.round of a
 * screen-relative percentage), and the renderer currently has no XSS sink, so
 * this was not exploitable — but the sink is exposed to every script in the
 * renderer through the preload bridge, and "not exploitable yet" is one careless
 * caller away from arbitrary command execution as the signed-in user. Validate
 * at the sink, where the guarantee has to hold.
 */
function sanitizeClickCoordinate(value, upperBound) {
    // Deliberately no coercion. Number(null), Number([]) and Number('') are all
    // 0, so a coercing check would turn a caller bug — or a crafted payload —
    // into a silent click at the origin. The only caller sends real numbers.
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;

    const rounded = Math.round(value);
    if (rounded < 0) return 0;
    if (rounded > upperBound) return upperBound;
    return rounded;
}

ipcMain.handle('simulate-mouse-click', (event, payload) => {
    const { width, height } = screen.getPrimaryDisplay().size;
    const x = sanitizeClickCoordinate(payload && payload.x, width);
    const y = sanitizeClickCoordinate(payload && payload.y, height);

    if (x === null || y === null) {
        console.warn('⚠️ Rejected simulate-mouse-click with non-numeric coordinates:', payload);
        return Promise.resolve(false);
    }

    return new Promise((resolve) => {
        if (process.platform === 'win32') {
            const psScript = `
[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y});
Add-Type -TypeDefinition '
using System;
using System.Runtime.InteropServices;
public class Win32Mouse {
    [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int cButtons, int info);
}
';
[Win32Mouse]::mouse_event(0x0002, 0, 0, 0, 0); # MOUSEEVENTF_LEFTDOWN
[Win32Mouse]::mouse_event(0x0004, 0, 0, 0, 0); # MOUSEEVENTF_LEFTUP
`;
            try {
                const base64 = Buffer.from(psScript, 'utf-16le').toString('base64');
                exec(`powershell -NoProfile -NonInteractive -EncodedCommand ${base64}`, (error) => {
                    resolve(!error);
                });
            } catch (err) {
                resolve(false);
            }
        } else if (process.platform === 'darwin') {
            try {
                // macOS: Use JavaScript for Automation (JXA) to call native CoreGraphics APIs
                const jxaScript = `ObjC.import('CoreGraphics'); var point = {x: ${x}, y: ${y}}; var clickDown = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, point, $.kCGMouseButtonLeft); var clickUp = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, point, $.kCGMouseButtonLeft); $.CGEventPost($.kCGHIDEventTap, clickDown); $.CGEventPost($.kCGHIDEventTap, clickUp);`;
                exec(`osascript -l JavaScript -e "${jxaScript}"`, (error) => {
                    resolve(!error);
                });
            } catch (err) {
                resolve(false);
            }
        } else {
            resolve(false);
        }
    });
});

let reminderWindow = null;

ipcMain.on('show-reminder-popup', () => {
    if (reminderWindow) {
        reminderWindow.show();
        reminderWindow.focus();
        return;
    }

    const { screen } = require('electron');
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;

    const winWidth = 330;
    const winHeight = 90;
    const x = width - winWidth - 15;
    const y = height - winHeight - 15;

    reminderWindow = new BrowserWindow({
        width: winWidth,
        height: winHeight,
        x: x,
        y: y,
        frame: false,
        resizable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        transparent: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            enableRemoteModule: false,
            sandbox: true,
            backgroundThrottling: false
        }
    });

    reminderWindow.loadFile(path.join(__dirname, '../renderer/views/reminder.html'));

    reminderWindow.on('closed', () => {
        reminderWindow = null;
    });
});

ipcMain.on('stop-reminding-clicked', () => {
    if (reminderWindow) {
        reminderWindow.close();
    }
    if (mainWindow) {
        mainWindow.webContents.send('stop-reminding-event');
    }
});

ipcMain.on('close-reminder-window', () => {
    if (reminderWindow) {
        reminderWindow.close();
    }
});

ipcMain.on('set-anti-cheat-active', (event, active) => {
    if (mainWindow) {
        if (active) {
            mainWindow.show();
            mainWindow.focus();
            mainWindow.center();
            mainWindow.setAlwaysOnTop(true, 'screen-saver');
            mainWindow.setMinimizable(false);
            mainWindow.setResizable(false);
        } else {
            mainWindow.setAlwaysOnTop(false);
            mainWindow.setMinimizable(true);
            mainWindow.setResizable(true);
        }
    }
});

// Persistent distraction warning lock. When a categorized Distracting app is
// detected the renderer raises a full-screen warning and calls this with
// active=true: the window is forced to the front, made always-on-top at the
// screen-saver level and non-minimizable, and the blur handler above keeps
// re-focusing it so the user cannot click behind or ignore it. It stays locked
// until they click the acknowledgment button (active=false).
ipcMain.on('set-distraction-lock', (event, active) => {
    distractionLockActive = !!active;
    if (!mainWindow || mainWindow.isDestroyed()) return;

    if (active) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.center();
        mainWindow.setAlwaysOnTop(true, 'screen-saver');
        mainWindow.setMinimizable(false);
        mainWindow.moveTop();
        mainWindow.focus();
        mainWindow.flashFrame(true);
    } else {
        mainWindow.setAlwaysOnTop(false);
        mainWindow.setMinimizable(true);
        mainWindow.flashFrame(false);
    }
});

ipcMain.on('set-always-on-top', (event, active) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    if (active) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.setAlwaysOnTop(true, 'screen-saver');
        mainWindow.moveTop();
        mainWindow.focus();
        mainWindow.flashFrame(true);
    } else {
        mainWindow.setAlwaysOnTop(false);
        mainWindow.flashFrame(false);
    }
});

ipcMain.on('confirm-close', () => {
    // Route through the single teardown rather than exiting straight away:
    // app.exit(0) left the spawned window-tracker.exe orphaned on Windows.
    cleanupAndQuit();
});

ipcMain.on('log-error', (event, msg) => {
    console.error('❌ [Renderer Error]:', msg);
});

console.log('🚀 Omega Tracker Main Process Started Successfully');