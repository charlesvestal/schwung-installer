const { app, BrowserWindow, ipcMain, dialog, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const backend = require('./backend');

let mainWindow;

// Prevent multiple instances — focus existing window if a second copy is launched
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 910,
        height: 700,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    mainWindow.loadFile(path.join(__dirname, '../ui/index.html'));

    // Open external links in system browser instead of Electron
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // Set main window in backend for logging
    backend.setMainWindow(mainWindow);
}

app.whenReady().then(() => {
    // Pass Electron's net module to backend — uses Chromium's network stack
    // which properly triggers macOS Local Network Privacy prompts
    backend.setElectronNet(net);

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// IPC Handlers
ipcMain.handle('validate_device_at', async (event, { baseUrl }) => {
    return await backend.validateDevice(baseUrl);
});

ipcMain.handle('get_saved_cookie', async () => {
    return backend.getSavedCookie();
});

ipcMain.handle('clear_saved_cookie', async () => {
    return await backend.clearSavedCookie();
});

ipcMain.handle('request_challenge', async (event, { baseUrl }) => {
    return await backend.requestChallenge(baseUrl);
});

ipcMain.handle('submit_auth_code', async (event, { baseUrl, code }) => {
    return await backend.submitAuthCode(baseUrl, code);
});

ipcMain.handle('check_git_bash_available', async () => {
    if (process.platform !== 'win32') return { available: true };
    try {
        const bashPath = await backend.findGitBash();
        return { available: !!bashPath, path: bashPath };
    } catch (err) {
        return { available: false, error: err.message };
    }
});

ipcMain.handle('find_existing_ssh_key', async () => {
    return backend.findExistingSshKey();
});

ipcMain.handle('generate_new_ssh_key', async () => {
    return await backend.generateNewSshKey();
});

ipcMain.handle('read_public_key', async (event, { path }) => {
    return backend.readPublicKey(path);
});

ipcMain.handle('submit_ssh_key_with_auth', async (event, { baseUrl, pubkey }) => {
    return await backend.submitSshKeyWithAuth(baseUrl, pubkey);
});

ipcMain.handle('test_ssh', async (event, { hostname }) => {
    return await backend.testSsh(hostname);
});

ipcMain.handle('try_ssh_fallback', async (event, { hostname }) => {
    return await backend.trySshFallback(hostname);
});

ipcMain.handle('setup_ssh_config', async (event, { hostname } = {}) => {
    return backend.setupSshConfig(hostname);
});

ipcMain.handle('get_latest_release', async () => {
    return await backend.getLatestRelease();
});

ipcMain.handle('check_installer_update', async () => {
    return await backend.checkInstallerUpdate(app.getVersion());
});

ipcMain.handle('download_release', async (event, { url, destPath }) => {
    return await backend.downloadRelease(url, destPath);
});

ipcMain.handle('install_main', async (event, { tarballPath, hostname, flags }) => {
    return await backend.installMain(tarballPath, hostname, flags);
});

ipcMain.handle('check_core_installation', async (event, { hostname }) => {
    return await backend.checkCoreInstallation(hostname);
});

ipcMain.handle('check_shim_active', async (event, { hostname }) => {
    return await backend.checkShimActive(hostname);
});

ipcMain.handle('reenable_move_everything', async (event, { hostname }) => {
    return await backend.reenableMoveEverything(hostname);
});

ipcMain.handle('get_diagnostics', async (event, { deviceIp, errors }) => {
    return backend.getDiagnostics(deviceIp, errors);
});

ipcMain.handle('get_screen_reader_status', async (event, { hostname }) => {
    return await backend.getScreenReaderStatus(hostname);
});

ipcMain.handle('set_screen_reader_state', async (event, { hostname, enabled }) => {
    return await backend.setScreenReaderState(hostname, enabled);
});

ipcMain.handle('uninstall_move_everything', async (event, { hostname }) => {
    return await backend.uninstallMoveEverything(hostname);
});

ipcMain.handle('test_ssh_formats', async (event, { cookie }) => {
    return await backend.testSshFormats(cookie);
});

ipcMain.handle('clean_device_tmp', async (event, { hostname }) => {
    return await backend.cleanDeviceTmp(hostname);
});

ipcMain.handle('clear_dns_cache', async () => {
    return backend.clearDnsCache();
});

ipcMain.handle('fix_permissions', async (event, { hostname }) => {
    return await backend.fixPermissions(hostname);
});

// --- WiFi Management ---
ipcMain.handle('wifi_get_status', async (event, { hostname }) => {
    return await backend.wifiGetStatus(hostname);
});

ipcMain.handle('wifi_scan', async (event, { hostname }) => {
    return await backend.wifiScan(hostname);
});

ipcMain.handle('wifi_list_services', async (event, { hostname }) => {
    return await backend.wifiListServices(hostname);
});

ipcMain.handle('wifi_connect', async (event, { hostname, serviceId, passphrase }) => {
    return await backend.wifiConnect(hostname, serviceId, passphrase);
});

ipcMain.handle('wifi_disconnect', async (event, { hostname, serviceId }) => {
    return await backend.wifiDisconnect(hostname, serviceId);
});

ipcMain.handle('wifi_remove_service', async (event, { hostname, serviceId }) => {
    return await backend.wifiRemoveService(hostname, serviceId);
});

ipcMain.handle('wifi_enable_radio', async (event, { hostname }) => {
    return await backend.wifiEnableRadio(hostname);
});

ipcMain.handle('export_logs', async (event, { logs }) => {
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Save Debug Logs',
        defaultPath: `schwung-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`,
        filters: [{ name: 'Text Files', extensions: ['txt'] }]
    });
    if (filePath) {
        fs.writeFileSync(filePath, logs);
        return true;
    }
    return false;
});
