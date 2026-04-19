const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  recheckPear: () => ipcRenderer.invoke('recheck-pear'),
  launchPear: () => ipcRenderer.invoke('launch-pear'),
  openInstallGuide: () => ipcRenderer.invoke('open-install-guide'),
  copyInstallCmd: () => ipcRenderer.invoke('copy-install-cmd'),
  quit: () => ipcRenderer.invoke('quit')
})
