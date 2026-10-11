// Desktop shell for Earmark: shows the app's web build. Wide windows get the sidebar layout,
// narrow ones the phone layout.
// The web build is copied into ./web by `npm run desktop:build` in the project root.
const { app, BrowserWindow, protocol, net, shell, ipcMain, safeStorage, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const readalong = require('./readalong');

const WEB_ROOT = path.join(__dirname, 'web');
const ORIGIN = 'app://earmark';

// A fixed origin (rather than a local port that changes) so saved progress and settings persist.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// ---- API keys: encrypted with the system keyring where there is one ----
const secretsFile = () => path.join(app.getPath('userData'), 'secrets.json');
const readSecrets = () => { try { return JSON.parse(fs.readFileSync(secretsFile(), 'utf8')); } catch { return {}; } };
const writeSecrets = (all) => fs.writeFileSync(secretsFile(), JSON.stringify(all), { mode: 0o600 });
const decryptSecret = (v) => {
  if (!v) return null;
  try { return v.enc ? safeStorage.decryptString(Buffer.from(v.data, 'base64')) : v.data; } catch { return null; }
};
const readSecret = (key) => decryptSecret(readSecrets()[key]);
ipcMain.handle('secret:get', (_e, key) => readSecret(key));
ipcMain.handle('secret:set', (_e, key, value) => {
  const enc = safeStorage.isEncryptionAvailable();
  writeSecrets({ ...readSecrets(), [key]: { enc, data: enc ? safeStorage.encryptString(String(value)).toString('base64') : String(value) } });
});
ipcMain.handle('secret:delete', (_e, key) => {
  const all = readSecrets();
  delete all[key];
  writeSecrets(all);
});

// ---- Read-along: drive tools/readalong/readalong.py to build time -> paragraph anchors ----
// The renderer never sees the TorBox key: the runner gets it from the secrets store above.
const READALONG_PYTHON = () =>
  path.join(app.getPath('home'), '.local', 'share', 'earmark-readalong', 'venv', 'bin', 'python');
const READALONG_SCRIPT = () => (app.isPackaged
  ? path.join(process.resourcesPath, 'readalong', 'readalong.py')
  : path.join(__dirname, '..', 'tools', 'readalong', 'readalong.py'));
const HASH_RE = /^[0-9a-f]{40}$/i;
const readalongWorkDir = (hash) => path.join(app.getPath('userData'), 'readalong', hash);

function assertHash(hash) {
  if (typeof hash !== 'string' || !HASH_RE.test(hash.trim())) throw new Error('readalong: invalid audio hash');
  return hash.trim().toLowerCase();
}
function assertFileIds(fileIds) {
  if (!Array.isArray(fileIds)) throw new Error('readalong: fileIds must be an array');
  return fileIds.map((id) => {
    if (!Number.isInteger(id)) throw new Error('readalong: fileIds must be integers');
    return id;
  });
}

let activeRun = null;

ipcMain.handle('readalong:status', () =>
  readalong.status({ python: READALONG_PYTHON(), script: READALONG_SCRIPT() }));

ipcMain.handle('readalong:fetchEpub', async (_e, url, audioHash) => {
  const hash = assertHash(audioHash);
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) throw new Error('readalong: invalid EPUB url');
  return readalong.fetchEpub(url.trim(), path.join(readalongWorkDir(hash), 'book.epub'));
});

// The bytes of the EPUB saved for this hash, or null when it was never downloaded (or has gone).
ipcMain.handle('readalong:readEpub', async (_e, audioHash) => {
  const hash = assertHash(audioHash);
  return readalong.readEpub(path.join(readalongWorkDir(hash), 'book.epub'));
});

ipcMain.handle('readalong:run', async (event, opts = {}) => {
  const hash = assertHash(opts.hash);
  const fileIds = assertFileIds(opts.fileIds);
  const torboxKey = readSecret('torbox_api_key');
  if (!torboxKey) throw new Error('readalong: TorBox API key is not set');
  const sender = event.sender;
  const job = readalong.runJob({
    python: READALONG_PYTHON(),
    script: READALONG_SCRIPT(),
    workDir: readalongWorkDir(hash),
    torboxKey,
    hash,
    fileIds,
    title: typeof opts.title === 'string' ? opts.title : '',
    paragraphs: Array.isArray(opts.paragraphs) ? opts.paragraphs.map(String) : [],
    onEvent: (ev) => { if (!sender.isDestroyed()) sender.send('readalong:event', ev); },
  });
  activeRun = job;
  try {
    return await job.promise;
  } finally {
    if (activeRun === job) activeRun = null;
  }
});

ipcMain.handle('readalong:cancel', () => {
  if (activeRun) activeRun.cancel();
  return true;
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 400, minHeight: 640,
    backgroundColor: '#0A0A0F', title: 'Earmark', autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The app talks to TorBox, the book catalogue and the user's scraper sources directly, as it
      // does on the phone. A browser would block those cross-site requests; this window only ever
      // loads the bundled app, so the block is lifted here.
      webSecurity: false,
    },
  });
  // Links (Apple Books, key pages…) open in the real browser, not in another app window.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(ORIGIN)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  win.loadURL(`${ORIGIN}/index.html`);

  // For checking a build from the command line: EARMARK_SHOT=/path/to.png saves a picture of the
  // window a few seconds after it loads, prints what the app logged, and quits.
  if (process.env.EARMARK_SHOT) {
    win.webContents.on('console-message', (_e, level, message) => console.log(`[app:${level}] ${message}`));
    win.webContents.on('did-fail-load', (_e, code, desc, url) => console.log(`[load failed] ${code} ${desc} ${url}`));
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      // EARMARK_CLICKS="x,y;x,y" clicks those points first, a couple of seconds apart.
      for (const [x, y] of (process.env.EARMARK_CLICKS ?? '').split(';').filter(Boolean).map((p) => p.split(',').map(Number))) {
        win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        await new Promise((r) => setTimeout(r, 2500));
      }
      if (process.env.EARMARK_TYPE) { // types into whatever the clicks focused, presses Enter, and waits for results
        await win.webContents.insertText(process.env.EARMARK_TYPE);
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        win.webContents.sendInputEvent({ type: 'char', keyCode: 'Enter' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
        await new Promise((r) => setTimeout(r, 12000));
      }
      if (process.env.EARMARK_EVAL) console.log('[eval]', await win.webContents.executeJavaScript(process.env.EARMARK_EVAL).catch((e) => `threw ${e}`));
      fs.writeFileSync(process.env.EARMARK_SHOT, (await win.webContents.capturePage()).toPNG());
      app.quit();
    }, Number(process.env.EARMARK_SHOT_DELAY ?? 7000)));
  }
}

app.whenReady().then(() => {
  // Some sources turn away anything that doesn't look like an ordinary browser.
  session.defaultSession.setUserAgent(session.defaultSession.getUserAgent().replace(/\s(Electron|Earmark|earmark-desktop)\/\S+/gi, ''));

  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const wanted = path.normalize(path.join(WEB_ROOT, decodeURIComponent(pathname)));
    // Stay inside the bundle, and fall back to the app page for anything that isn't a file.
    const inside = wanted.startsWith(WEB_ROOT + path.sep) && fs.existsSync(wanted) && fs.statSync(wanted).isFile();
    return net.fetch(pathToFileURL(inside ? wanted : path.join(WEB_ROOT, 'index.html')).toString());
  });

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
