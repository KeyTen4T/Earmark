// The only things the app can reach outside its own window: the key store and the
// read-along job runner in main.js. The renderer never touches the TorBox key.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('earmarkDesktop', {
  secret: {
    get: (key) => ipcRenderer.invoke('secret:get', key),
    set: (key, value) => ipcRenderer.invoke('secret:set', key, value),
    delete: (key) => ipcRenderer.invoke('secret:delete', key),
  },
  readalong: {
    status: () => ipcRenderer.invoke('readalong:status'),
    readEpub: (hash) => ipcRenderer.invoke('readalong:readEpub', hash),
    fetchEpub: (url, hash) => ipcRenderer.invoke('readalong:fetchEpub', url, hash),
    run: (opts) => ipcRenderer.invoke('readalong:run', opts),
    cancel: () => ipcRenderer.invoke('readalong:cancel'),
    onEvent: (cb) => {
      const listener = (_e, event) => cb(event);
      ipcRenderer.on('readalong:event', listener);
      return () => ipcRenderer.removeListener('readalong:event', listener);
    },
  },
});
