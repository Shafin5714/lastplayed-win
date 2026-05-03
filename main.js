const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const chokidar = require('chokidar');

const { detectSeriesName, detectEpisodeLabel } = require('./series-detector.js');
const { importAllHistory } = require('./importer.js');

let mainWindow;
let db;
let watchers = {}; // folderPath -> chokidar instance
let importResultCache = null;

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v",
  ".mpg", ".mpeg", ".ts", ".m2ts", ".vob", ".3gp", ".rmvb"
]);

function isVideoFile(filePath) {
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

function initDb() {
  const userDataPath = app.getPath('userData');
  const dbPath = path.join(userDataPath, 'lastplayed.db');
  db = new Database(dbPath);

  // Schema migrations
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      file_size INTEGER,
      series_name TEXT,
      episode_label TEXT,
      last_watched INTEGER NOT NULL,
      watch_count INTEGER DEFAULT 1,
      source TEXT DEFAULT 'watcher'
    );

    CREATE TABLE IF NOT EXISTS watched_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_path TEXT NOT NULL UNIQUE,
      added_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

function upsertMedia(filePath, source = 'watcher', timestampMs = null) {
  if (!fs.existsSync(filePath)) return;
  if (!isVideoFile(filePath)) return;

  try {
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    const fileName = path.basename(filePath);
    const seriesName = detectSeriesName(filePath);
    const episodeLabel = detectEpisodeLabel(fileName);
    const lastWatched = timestampMs || stats.mtimeMs;

    const existing = db.prepare('SELECT id, watch_count FROM media_history WHERE file_path = ?').get(filePath);

    if (existing) {
      db.prepare(`
        UPDATE media_history 
        SET last_watched = ?, watch_count = ?, source = ?
        WHERE id = ?
      `).run(lastWatched, existing.watch_count + 1, source, existing.id);
    } else {
      db.prepare(`
        INSERT INTO media_history 
        (file_path, file_name, file_size, series_name, episode_label, last_watched, watch_count, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(filePath, fileName, fileSize, seriesName, episodeLabel, lastWatched, 1, source);
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('history-updated');
    }
  } catch (err) {
    console.error('Error upserting media', filePath, err);
  }
}

function startWatcher(folderPath) {
  if (watchers[folderPath]) return; // Already watching

  if (!fs.existsSync(folderPath)) {
    console.warn(`Folder to watch does not exist: ${folderPath}`);
    return;
  }

  const watcher = chokidar.watch(folderPath, {
    persistent: true,
    ignoreInitial: true,
    depth: 8,
    awaitWriteFinish: true,
  });

  const onFileEvent = (filePath) => {
    if (isVideoFile(filePath)) {
      upsertMedia(filePath, 'watcher');
    }
  };

  watcher.on('add', onFileEvent).on('change', onFileEvent);
  watchers[folderPath] = watcher;
}

function stopWatcher(folderPath) {
  if (watchers[folderPath]) {
    watchers[folderPath].close();
    delete watchers[folderPath];
  }
}

function loadSavedFolders() {
  const folders = db.prepare('SELECT folder_path FROM watched_folders').all();
  for (const row of folders) {
    startWatcher(row.folder_path);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    frame: false, // Custom Titlebar
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Renderer doesn't exist yet, but it will soon
  const indexHtml = path.join(__dirname, 'renderer', 'index.html');
  if (fs.existsSync(indexHtml)) {
    mainWindow.loadFile(indexHtml);
  } else {
    // Just load a blank page if not created yet so we don't error out
    mainWindow.loadURL('data:text/html,<h2>Renderer not ready yet</h2>');
  }

  mainWindow.webContents.on('did-finish-load', () => {
    if (importResultCache && importResultCache.total > 0) {
      mainWindow.webContents.send('import-complete', importResultCache);
    }
  });
}

function registerIpcHandlers() {
  ipcMain.handle('get-history', () => {
    return db.prepare('SELECT * FROM media_history ORDER BY last_watched DESC').all();
  });

  ipcMain.handle('get-series', () => {
    return db.prepare(`
      SELECT 
        COALESCE(series_name, 'Uncategorized') as series_name,
        MAX(last_watched) as last_watched,
        COUNT(*) as total_episodes
      FROM media_history
      GROUP BY COALESCE(series_name, 'Uncategorized')
      ORDER BY last_watched DESC
    `).all().map(row => {
      let lastEpisode;
      if (row.series_name === 'Uncategorized') {
        lastEpisode = db.prepare(`
          SELECT episode_label, file_path 
          FROM media_history 
          WHERE series_name IS NULL 
          ORDER BY last_watched DESC 
          LIMIT 1
        `).get();
      } else {
        lastEpisode = db.prepare(`
          SELECT episode_label, file_path 
          FROM media_history 
          WHERE series_name = ? 
          ORDER BY last_watched DESC 
          LIMIT 1
        `).get(row.series_name);
      }

      return {
        ...row,
        episode_label: lastEpisode ? lastEpisode.episode_label : null,
        cover_path: lastEpisode ? path.dirname(lastEpisode.file_path) : null,
        last_file_path: lastEpisode ? lastEpisode.file_path : null
      };
    });
  });

  ipcMain.handle('get-series-episodes', (event, name) => {
    if (name === 'Uncategorized') {
      return db.prepare('SELECT * FROM media_history WHERE series_name IS NULL ORDER BY last_watched DESC').all();
    }
    return db.prepare('SELECT * FROM media_history WHERE series_name = ? ORDER BY last_watched DESC').all(name);
  });

  ipcMain.handle('get-folders', () => {
    return db.prepare('SELECT * FROM watched_folders ORDER BY added_at DESC').all();
  });

  ipcMain.handle('add-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    });
    if (!result.canceled && result.filePaths.length > 0) {
      const folderPath = result.filePaths[0];
      try {
        db.prepare('INSERT INTO watched_folders (folder_path, added_at) VALUES (?, ?)').run(folderPath, Date.now());
        startWatcher(folderPath);
        return { success: true, folder: folderPath };
      } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          return { success: false, error: 'Folder is already being watched' };
        }
        return { success: false, error: err.message };
      }
    }
    return { success: false, canceled: true };
  });

  ipcMain.handle('remove-folder', (event, folderPath) => {
    db.prepare('DELETE FROM watched_folders WHERE folder_path = ?').run(folderPath);
    stopWatcher(folderPath);
    return { success: true };
  });

  ipcMain.handle('open-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Movies', extensions: Array.from(VIDEO_EXTENSIONS).map(e => e.replace('.', '')) }]
    });
    if (!result.canceled && result.filePaths.length > 0) {
      const filePath = result.filePaths[0];
      upsertMedia(filePath, 'manual', Date.now());
      shell.openPath(filePath);
      return { success: true, filePath };
    }
    return { success: false, canceled: true };
  });

  ipcMain.handle('open-file-path', async (event, filePath) => {
    upsertMedia(filePath, 'manual', Date.now());
    const err = await shell.openPath(filePath);
    if (err) return { success: false, error: err };
    return { success: true };
  });

  ipcMain.handle('delete-record', (event, id) => {
    db.prepare('DELETE FROM media_history WHERE id = ?').run(id);
    return { success: true };
  });

  ipcMain.handle('clear-history', () => {
    db.prepare('DELETE FROM media_history').run();
    return { success: true };
  });

  ipcMain.handle('get-import-status', () => {
    return importResultCache;
  });

  ipcMain.handle('minimize-window', () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.handle('maximize-window', () => {
    if (mainWindow) {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    }
  });

  ipcMain.handle('close-window', () => {
    if (mainWindow) mainWindow.close();
  });
}

app.whenReady().then(async () => {
  initDb();
  registerIpcHandlers();
  createWindow();

  // Run importAllHistory
  const importResults = await importAllHistory(db, upsertMedia);
  importResultCache = importResults;

  if (importResults && importResults.total > 0 && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('import-complete', importResults);
  }

  loadSavedFolders();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
