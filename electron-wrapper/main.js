const { app, BrowserWindow, ipcMain, shell, dialog, clipboard } = require('electron')
const { spawn, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const PEAR_KEY = 'pear://t6athit7zo98y7wb7kupmeaihxu3p5tft5s55nx5a5s634meppgy'
const INSTALL_GUIDE_URL = 'https://swarmnero.com/pear.html'
const INSTALL_CMD = 'npm i -g pear'

function extendPath() {
  // GUI apps on macOS/Linux don't inherit the user's shell PATH.
  // Add common install locations so we can find `pear` and `npm`.
  const home = os.homedir()
  const extras = process.platform === 'win32'
    ? [
        path.join(home, 'AppData', 'Roaming', 'npm'),
        path.join(home, 'AppData', 'Local', 'npm')
      ]
    : [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        path.join(home, '.npm-global', 'bin'),
        path.join(home, '.nvm', 'versions', 'node'),
        path.join(home, 'Library', 'Application Support', 'pear', 'bin')
      ]
  const sep = process.platform === 'win32' ? ';' : ':'
  process.env.PATH = [process.env.PATH || '', ...extras].join(sep)
}

function findPear() {
  try {
    const cmd = process.platform === 'win32' ? 'where pear' : 'command -v pear'
    const result = execSync(cmd, {
      encoding: 'utf8',
      shell: process.platform === 'win32' ? undefined : '/bin/sh'
    }).trim().split(/\r?\n/)[0]
    if (result && fs.existsSync(result)) return result
  } catch (e) {}

  const home = os.homedir()
  const candidates = process.platform === 'win32'
    ? [
        path.join(home, 'AppData', 'Roaming', 'npm', 'pear.cmd'),
        path.join(home, 'AppData', 'Roaming', 'npm', 'pear')
      ]
    : [
        path.join(home, 'Library', 'Application Support', 'pear', 'bin', 'pear'),
        '/usr/local/bin/pear',
        '/opt/homebrew/bin/pear',
        path.join(home, '.npm-global', 'bin', 'pear')
      ]
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p } catch (_) {}
  }
  return null
}

function launchPear(pearPath) {
  const child = spawn(pearPath, ['run', PEAR_KEY], {
    detached: true,
    stdio: 'ignore',
    env: process.env
  })
  child.unref()
  setTimeout(() => app.quit(), 500)
}

function showSetupWindow() {
  const win = new BrowserWindow({
    width: 560,
    height: 640,
    resizable: false,
    maximizable: false,
    title: 'Swarmnero Launcher',
    backgroundColor: '#0d1117',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.setMenuBarVisibility(false)
  win.loadFile(path.join(__dirname, 'setup.html'))
  return win
}

ipcMain.handle('recheck-pear', () => !!findPear())

ipcMain.handle('launch-pear', () => {
  const p = findPear()
  if (!p) return false
  launchPear(p)
  return true
})

ipcMain.handle('open-install-guide', () => shell.openExternal(INSTALL_GUIDE_URL))

ipcMain.handle('copy-install-cmd', () => clipboard.writeText(INSTALL_CMD))

ipcMain.handle('quit', () => app.quit())

app.whenReady().then(() => {
  extendPath()
  const pearPath = findPear()
  if (pearPath) {
    launchPear(pearPath)
  } else {
    showSetupWindow()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const pearPath = findPear()
    if (pearPath) launchPear(pearPath)
    else showSetupWindow()
  }
})
