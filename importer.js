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

  // Check if import already done
  try {
    const row = db.prepare("SELECT value FROM app_state WHERE key = 'import_done'").get();
    if (row && row.value === 'true') {
      return results;
    }
  } catch (err) {
    // If table doesn't exist or query fails, just proceed.
  }

  // Helper to filter and upsert
  const doUpsert = (filePath, source, timestampMs) => {
    if (isVideoFile(filePath) && fs.existsSync(filePath)) {
      upsertFn(filePath, source, timestampMs);
      if (source === 'vlc') results.vlc++;
      else if (source === 'mpc') results.mpc++;
      else if (source === 'windows') results.windows++;
      results.total++;
    }
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
        const times = timesStr ? timesStr.split(',').map(x => parseInt(x, 10)) : [];

        uris.forEach((uri, i) => {
          try {
            if (uri.startsWith('file:///')) {
              let decoded = decodeURIComponent(uri.substring(8));
              if (path.sep === '\\') {
                decoded = decoded.replace(/\//g, '\\');
              }
              const mtime = getFileMTimeMs(decoded);
              // Use timestamp from VLC if valid, otherwise fallback to mtime
              const timestampMs = (times[i] && times[i] > 0) ? times[i] : mtime;
              doUpsert(decoded, 'vlc', timestampMs);
            }
          } catch (e) {}
        });
      }
    }
  } catch (err) {
    console.error('VLC import failed', err);
  }

  // Source 2 & 3: MPC-HC and MPC-BE
  const importMpc = async (regPath) => {
    try {
      const { stdout } = await execPromise(`reg query "${regPath}"`);
      const lines = stdout.split('\n');
      for (const line of lines) {
        const match = line.match(/^\s*File\d+\s+REG_SZ\s+(.+)$/i);
        if (match) {
          const filePath = match[1].trim();
          const mtime = getFileMTimeMs(filePath);
          doUpsert(filePath, 'mpc', mtime);
        }
      }
    } catch (err) {
      // Silently ignore if app is not installed or key missing
    }
  };

  await importMpc('HKCU\\Software\\MPC-HC\\MPC-HC\\Recent File List');
  await importMpc('HKCU\\Software\\MPC-BE\\Recent File List');

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

  // Mark as done
  try {
    db.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES ('import_done', 'true')").run();
  } catch (err) {
    console.error('Could not save import_done state', err);
  }

  return results;
}

module.exports = { importAllHistory };
