const { app, BrowserWindow, ipcMain, powerMonitor, desktopCapturer, Tray, Menu, dialog } = require('electron');
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

// Force-kill any tracked native child processes.
function killAllChildren() {
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
        setTimeout(cleanupAndQuit, 5000); // safety net, not the primary mechanism
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
    const iconPath = path.join(__dirname, '../../assets/icon.ico');
    tray = new Tray(iconPath);
    
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

// Disable hardware acceleration (fixes screenshot issues on Windows)
app.disableHardwareAcceleration();

app.whenReady().then(() => {
    loadConfig();        // Load API config first

    // Auto-approve Geolocation, Media, and Display Capture permissions for the app
    const { session } = require('electron');
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

// Get system idle time
ipcMain.handle('get-idle-time', () => {
    return powerMonitor.getSystemIdleTime();
});

// Get real active OS window title
ipcMain.handle('get-active-window', () => {
    return new Promise((resolve) => {
        if (process.platform === 'win32') {
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
        } else if (process.platform === 'darwin') {
            const script = `tell application "System Events"
                try
                    set frontmostProcess to first process whose frontmost is true
                    set procName to name of frontmostProcess
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
                on error
                    return "Unknown Window"
                end try
            end tell`;
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

// Navigation handler
ipcMain.on('navigate-to', (event, page) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    // Leaving the tracker for the login screen must ALWAYS fully release the
    // distraction lock. Otherwise the always-on-top + blur-refocus focus trap
    // would persist on the login window and freeze it (Sign In appears to do
    // nothing). This is a hard safety reset independent of renderer state.
    if (page === 'login') {
        distractionLockActive = false;
        mainWindow.setAlwaysOnTop(false);
        mainWindow.setMinimizable(true);
        mainWindow.flashFrame(false);
    }

    mainWindow.loadFile(path.join(__dirname, `../renderer/views/${page}.html`));
});

// Optional: Send API_BASE to renderer on demand
ipcMain.handle('get-api-base', () => config.API_BASE);

// Secure Identity Token Storage
ipcMain.handle('get-token', () => authSessionToken);
ipcMain.on('set-token', (event, token) => {
    authSessionToken = token;
});
ipcMain.on('clear-token', () => {
    authSessionToken = null;
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
                    try
                        tell application procName to close window 1
                    on error
                        tell application procName to quit
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

// Simulate OS-level Mouse Click at coordinates (Windows Only)
ipcMain.handle('simulate-mouse-click', (event, { x, y }) => {
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

ipcMain.on('confirm-close', () => {
    isQuitting = true;
    app.exit(0);
});

ipcMain.on('log-error', (event, msg) => {
    console.error('❌ [Renderer Error]:', msg);
});

console.log('🚀 Omega Tracker Main Process Started Successfully');