// Preload script for Electron
// Exposes minimal APIs to the renderer process
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
});
