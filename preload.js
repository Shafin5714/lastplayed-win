const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld("api", {
  getHistory: () => ipcRenderer.invoke("get-history"),
  getSeries: () => ipcRenderer.invoke("get-series"),
  getSeriesEpisodes: (name) => ipcRenderer.invoke("get-series-episodes", name),
  getFolders: () => ipcRenderer.invoke("get-folders"),
  addFolder: () => ipcRenderer.invoke("add-folder"),
  removeFolder: (path) => ipcRenderer.invoke("remove-folder", path),
  openFile: () => ipcRenderer.invoke("open-file"),
  openFilePath: (path) => ipcRenderer.invoke("open-file-path", path),
  deleteRecord: (id) => ipcRenderer.invoke("delete-record", id),
  clearHistory: () => ipcRenderer.invoke("clear-history"),
  getImportStatus: () => ipcRenderer.invoke("get-import-status"),
  minimizeWindow: () => ipcRenderer.invoke("minimize-window"),
  maximizeWindow: () => ipcRenderer.invoke("maximize-window"),
  closeWindow: () => ipcRenderer.invoke("close-window"),
  onHistoryUpdated: (cb) => {
    // Strip event object to prevent context leaks
    ipcRenderer.on("history-updated", () => cb());
  },
  onImportComplete: (cb) => {
    ipcRenderer.on("import-complete", (_, data) => cb(data));
  },
});
