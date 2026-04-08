const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Expose installer API
contextBridge.exposeInMainWorld('installer', {
    // Get file path from a dropped File object (Electron 40+)
    getPathForFile: (file) => webUtils.getPathForFile(file),

    // IPC invoke wrapper
    invoke: (cmd, args = {}) => {
        return ipcRenderer.invoke(cmd, args);
    },

    // Event listeners
    on: (channel, callback) => {
        const validChannels = ['backend-log'];
        if (validChannels.includes(channel)) {
            ipcRenderer.on(channel, (event, ...args) => callback(...args));
        }
    },

    removeAllListeners: (channel) => {
        ipcRenderer.removeAllListeners(channel);
    }
});
