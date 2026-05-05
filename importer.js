const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const { shell } = require('electron');

const execPromise = util.promisify(exec);

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v",
  ".mpg", ".mpeg", ".ts", ".m2ts", ".vob", ".3gp", ".rmvb"
]);

function isVideoFile(filePath) {
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

function getFileMTimeMs(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return stats.mtimeMs;
  } catch (err) {
    return Date.now();
  }
}

async function importAllHistory(db, upsertFn) {
  const results = { vlc: 0, mpc: 0, windows: 0, total: 0 };

  // We want to run import every time the app opens to sync latest external history
  // so we do not check or set 'import_done' anymore.

  // Helper to filter and upsert
  const doUpsert = (filePath, source, timestampMs) => {
    if (isVideoFile(filePath) && fs.existsSync(filePath)) {
      upsertFn(filePath, source, timestampMs);
      if (source === 'vlc') results.vlc++;
      else if (source.startsWith('mpc')) results.mpc++;
      else if (source === 'windows') results.windows++;
      results.total++;
    }
  };

  // Helper to process ordered list of recently watched files (index 0 is newest)
  // Synthesizes timestamps so recently watched files appear at the top, without inflating watch counts on restart
  const processOrderedRecentList = (sourceName, rawList) => {
    if (!rawList || rawList.length === 0) return;

    const validFiles = rawList.filter(filePath => isVideoFile(filePath) && fs.existsSync(filePath));
    if (validFiles.length === 0) return;
    
    let prevList = [];
    try {
      const row = db.prepare("SELECT value FROM app_state WHERE key = ?").get(`${sourceName}_list`);
      if (row && row.value) {
        prevList = JSON.parse(row.value);
      }
    } catch (err) {}

    const now = Date.now();
    validFiles.forEach((filePath, idx) => {
      const prevIdx = prevList.indexOf(filePath);
      if (prevIdx === -1 || idx < prevIdx) {
        // Item moved up or is new -> genuinely recently watched!
        doUpsert(filePath, sourceName, now - (idx * 1000));
      } else {
        // Item just shifted down or stayed same. Use file mtime so it's not falsely bumped.
        const mtime = getFileMTimeMs(filePath);
        doUpsert(filePath, sourceName, mtime);
      }
    });

    try {
      db.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)").run(`${sourceName}_list`, JSON.stringify(validFiles));
    } catch (err) {}
  };

  // Source 1: VLC
  try {
    const vlcIniPath = path.join(process.env.APPDATA, 'vlc', 'vlc-qt-interface.ini');
    if (fs.existsSync(vlcIniPath)) {
      const content = fs.readFileSync(vlcIniPath, 'utf8');
      const lines = content.split('\n');
      let inRecents = false;
      let listStr = '';
      let timesStr = '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '[RecentsMRL]') {
          inRecents = true;
          continue;
        }
        if (inRecents && trimmed.startsWith('[')) {
          inRecents = false;
        }
        if (inRecents) {
          if (trimmed.startsWith('list=')) listStr = trimmed.substring(5);
          if (trimmed.startsWith('times=')) timesStr = trimmed.substring(6);
        }
      }

      if (listStr) {
        const uris = listStr.split(',').filter(x => x);
        const orderedPaths = [];

        uris.forEach((uri) => {
          try {
            if (uri.startsWith('file:///')) {
              let decoded = decodeURIComponent(uri.substring(8));
              if (path.sep === '\\') {
                decoded = decoded.replace(/\//g, '\\');
              }
              orderedPaths.push(decoded);
            }
          } catch (e) {}
        });
        
        processOrderedRecentList('vlc', orderedPaths);
      }
    }
  } catch (err) {
    console.error('VLC import failed', err);
  }

  const importMpc = async (regPath, sourceName) => {
    try {
      const { stdout } = await execPromise(`reg query "${regPath}"`);
      const lines = stdout.split('\n');
      
      const filesMap = {};
      for (const line of lines) {
        const match = line.match(/^\s*File(\d+)\s+REG_SZ\s+(.+)$/i);
        if (match) {
          const num = parseInt(match[1], 10);
          filesMap[num] = match[2].trim();
        }
      }
      
      const orderedPaths = Object.keys(filesMap)
        .map(Number)
        .sort((a, b) => a - b)
        .map(k => filesMap[k]);

      processOrderedRecentList(sourceName, orderedPaths);
    } catch (err) {
      // Silently ignore if app is not installed or key missing
    }
  };

  await importMpc('HKCU\\Software\\MPC-HC\\MPC-HC\\Recent File List', 'mpc_hc');
  await importMpc('HKCU\\Software\\MPC-BE\\Recent File List', 'mpc_be');

  // Source 4: Windows Recent
  try {
    const recentPath = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Recent');
    if (fs.existsSync(recentPath)) {
      const files = fs.readdirSync(recentPath);
      for (const file of files) {
        if (file.toLowerCase().endsWith('.lnk')) {
          try {
            const lnkPath = path.join(recentPath, file);
            const shortcut = shell.readShortcutLink(lnkPath);
            if (shortcut && shortcut.target) {
              const stats = fs.statSync(lnkPath);
              doUpsert(shortcut.target, 'windows', stats.mtimeMs); // Use .lnk file mtime
            }
          } catch (e) {}
        }
      }
    }
  } catch (err) {
    console.error('Windows Recent import failed', err);
  }

  // Removed import_done saving so it re-syncs on next open

  return results;
}

module.exports = { importAllHistory };
