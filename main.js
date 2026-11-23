const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage, Notification, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

let mainWindow = null;
let tray = null;
let isQuitting = false;
const activeFileStreams = new Map();

function applyMicaStyle(win) {
  if (!win || process.platform !== 'win32') return;
  try {
    win.setBackgroundMaterial('mica');
  } catch (e) {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 640,
    title: 'PCG Chat',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    transparent: true,
    roundedCorners: true,
    backgroundMaterial: 'mica',
    backgroundColor: '#00000000',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#ffffff',
      height: 36
    },
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // Conceder permisos nativos de camara, microfono y notificaciones
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'audioCapture', 'videoCapture', 'notifications', 'clipboard-read', 'clipboard-sanitized-write'];
    callback(allowed.includes(permission));
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    const allowed = ['media', 'audioCapture', 'videoCapture', 'notifications'];
    return allowed.includes(permission);
  });

  mainWindow.loadFile('index.html');

  // Reparar Mica y bordes al maximizar / desmaximizar / restaurar
  mainWindow.on('maximize', () => applyMicaStyle(mainWindow));
  mainWindow.on('unmaximize', () => {
    applyMicaStyle(mainWindow);
    mainWindow.webContents.send('window-restored');
  });
  mainWindow.on('restore', () => applyMicaStyle(mainWindow));
  mainWindow.on('focus', () => applyMicaStyle(mainWindow));

  // Minimizar a segundo plano (bandeja del sistema) al cerrar con la X
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.ico');
  let trayIcon = nativeImage.createFromPath(iconPath);
  if (trayIcon.isEmpty()) {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Abrir PCG Chat',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
          applyMicaStyle(mainWindow);
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Salir por completo',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('PCG Chat - En segundo plano');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      applyMicaStyle(mainWindow);
    }
  });
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('PCG Chat');
  }
  createWindow();
  createTray();
});

app.on('before-quit', () => {
  isQuitting = true;
  for (const stream of activeFileStreams.values()) {
    try { stream.end(); } catch (e) {}
  }
  activeFileStreams.clear();
});

// --- ACTUALIZAR COLOR DE BOTONES DE VENTANA SEGUN TEMA CLARO/OSCURO ---
ipcMain.on('update-titlebar-theme', (event, theme) => {
  if (!mainWindow || !mainWindow.setTitleBarOverlay) return;
  try {
    mainWindow.setTitleBarOverlay({
      color: '#00000000',
      symbolColor: theme === 'light' ? '#0f172a' : '#ffffff',
      height: 36
    });
  } catch (e) {}
});

ipcMain.on('refocus-window', () => {
  if (mainWindow) {
    mainWindow.blur();
    mainWindow.focus();
  }
});

// --- FUNCION UNICA: ABRE VENTANAS ---
ipcMain.on('abre-ventanas', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.focus();
  mainWindow.flashFrame(true);
  applyMicaStyle(mainWindow);

  setTimeout(() => {
    if (mainWindow) {
      mainWindow.setAlwaysOnTop(false);
      mainWindow.flashFrame(false);
    }
  }, 2500);
});

// --- ABRIR PANEL NATIVO DE EMOJIS DE WINDOWS (WIN + .) ---
ipcMain.on('open-windows-emoji', () => {
  if (mainWindow) mainWindow.focus();
  const winDotCommand = `powershell -WindowStyle Hidden -Command "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class K { [DllImport(\\"user32.dll\\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo); }'; [K]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero); [K]::keybd_event(0xBE, 0, 0, [UIntPtr]::Zero); [K]::keybd_event(0xBE, 0, 2, [UIntPtr]::Zero); [K]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero);"`;
  exec(winDotCommand);
});

// --- AUTO-INICIO CON WINDOWS ---
ipcMain.on('set-autostart', (event, enabled) => {
  app.setLoginItemSettings({
    openAtLogin: !!enabled,
    path: process.execPath
  });
});

ipcMain.handle('get-autostart', () => {
  return app.getLoginItemSettings().openAtLogin;
});

// --- NOTIFICACION NATIVA DE WINDOWS ---
ipcMain.on('show-notification', (event, { title, body }) => {
  if (Notification.isSupported()) {
    const notif = new Notification({
      title: title || 'PCG Chat',
      body: body || '',
      icon: path.join(__dirname, 'assets', 'icon.ico'),
      silent: true
    });
    notif.on('click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
    notif.show();
  }
});

// --- SELECCIONAR ARCHIVOS DESDE WINDOWS ---
ipcMain.handle('pick-file', async (event, filters) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: filters || [{ name: 'Todos los archivos', extensions: ['*'] }]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const stats = fs.statSync(filePath);
  return {
    path: filePath,
    name: path.basename(filePath),
    size: stats.size
  };
});

// --- SELECCIONAR IMAGEN O AUDIO DESDE PC COMO DATA URL ---
ipcMain.handle('pick-media-dataurl', async (event, filters) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: filters
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const mime = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)
    ? `image/${ext === 'jpg' ? 'jpeg' : ext}`
    : `audio/${ext}`;
  const base64 = fs.readFileSync(filePath).toString('base64');
  return {
    name: path.basename(filePath),
    dataUrl: `data:${mime};base64,${base64}`
  };
});

// --- TRANSFERENCIA DIRECTA A DISCO (SOPORTA HASTA 100 GB SIN LLENAR RAM) ---
ipcMain.handle('file-write-start', async (event, { transferId, fileName }) => {
  const downloadsDir = app.getPath('downloads');
  const safeName = fileName.replace(/[<>:"/\\|?*]/g, '_');
  let finalPath = path.join(downloadsDir, safeName);
  let counter = 1;
  while (fs.existsSync(finalPath)) {
    const ext = path.extname(safeName);
    const base = path.basename(safeName, ext);
    finalPath = path.join(downloadsDir, `${base} (${counter})${ext}`);
    counter++;
  }
  const stream = fs.createWriteStream(finalPath);
  activeFileStreams.set(transferId, stream);
  return finalPath;
});

ipcMain.handle('file-write-chunk', async (event, { transferId, chunkBuffer }) => {
  const stream = activeFileStreams.get(transferId);
  if (!stream) return false;
  const buf = Buffer.from(chunkBuffer);
  if (!stream.write(buf)) {
    await new Promise(resolve => stream.once('drain', resolve));
  }
  return true;
});

ipcMain.handle('file-write-end', async (event, { transferId }) => {
  const stream = activeFileStreams.get(transferId);
  if (stream) {
    stream.end();
    activeFileStreams.delete(transferId);
  }
  return true;
});

ipcMain.handle('file-read-chunk', async (event, { filePath, offset, length }) => {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(length);
  const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
  fs.closeSync(fd);
  return buffer.subarray(0, bytesRead);
});
