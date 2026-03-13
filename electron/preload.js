// Preload script for Electron
// Exposes minimal APIs to the renderer process
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  openNewWindow: (hash) => ipcRenderer.invoke("open-new-window", hash),
});
