const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Get configuration from main process (more secure)
    getConfig: () => ipcRenderer.invoke('get-config'),

    // Get only API_BASE
    getApiBase: () => ipcRenderer.invoke('get-api-base'),

    // Secure Token Storage
    getToken: () => ipcRenderer.invoke('get-token'),
    setToken: (token) => ipcRenderer.send('set-token', token),
    clearToken: () => ipcRenderer.send('clear-token'),

    // Navigation
    navigateTo: (page) => ipcRenderer.send('navigate-to', page),

    // Screenshot Capture
    captureScreen: () => ipcRenderer.invoke('capture-screen'),

    // System & Anti-Cheat
    getIdleTime: () => ipcRenderer.invoke('get-idle-time'),
    requestAttention: () => ipcRenderer.invoke('request-attention'),
    getActiveWindow: () => ipcRenderer.invoke('get-active-window'),
    getNativeLocation: () => ipcRenderer.invoke('get-native-location'),
    minimizeActiveWindow: () => ipcRenderer.invoke('minimize-active-window'),
    closeActiveWindow: () => ipcRenderer.invoke('close-active-window'),
    simulateMouseClick: (x, y) => ipcRenderer.invoke('simulate-mouse-click', { x, y }),

    // Optional: Listen for events from main if needed in future
    onUpdateAvailable: (callback) => {
        ipcRenderer.on('update-available', callback);
    },
    onUpdateDownloaded: (callback) => {
        ipcRenderer.on('update-downloaded', callback);
    },
    confirmClose: () => {
        ipcRenderer.send('confirm-close');
    },

    // Mirror the counter (running/stopped) state to the main process so it can
    // decide the close behaviour (hide-and-keep-tracking vs. ask-to-exit).
    setTrackingActive: (active) => ipcRenderer.send('set-tracking-active', active),

    // Main asks the renderer to flush its offline queue before a full exit.
    onFlushAndQuit: (callback) => ipcRenderer.on('flush-and-quit', callback),

    // Mirror the UI language to the main process so native dialogs are localized.
    setLocale: (locale) => ipcRenderer.send('set-locale', locale),

    getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
    
    // Reminder Popup Channels
    showReminderPopup: () => ipcRenderer.send('show-reminder-popup'),
    onStopReminding: (callback) => ipcRenderer.on('stop-reminding-event', (_, ...args) => callback(...args)),
    stopRemindingClicked: () => ipcRenderer.send('stop-reminding-clicked'),
    closeReminderWindow: () => ipcRenderer.send('close-reminder-window'),
    setAntiCheatActive: (active) => ipcRenderer.send('set-anti-cheat-active', active),

    // Persistent distraction warning lock (always-on-top focus trap).
    setDistractionLock: (active) => ipcRenderer.send('set-distraction-lock', active)
});

console.log('✅ Preload script loaded successfully - ElectronAPI exposed');