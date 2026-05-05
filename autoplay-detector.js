const { exec } = require('child_process');
const util = require('util');
const path = require('path');
const fs = require('fs');

const execPromise = util.promisify(exec);

const TARGET_PLAYERS = [
  'vlc.exe',
  'mpc-hc.exe',
  'mpc-hc64.exe',
  'mpc-be.exe',
  'mpc-be64.exe',
  'potplayer.exe',
  'potplayer64.exe'
];

const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v",
  ".mpg", ".mpeg", ".ts", ".m2ts", ".vob", ".3gp", ".rmvb"
]);

function isVideoFile(filePath) {
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

// Keep track of the last detected title per player to avoid duplicate tracking
const lastDetectedTitles = new Map();

function cleanWindowTitle(title) {
  let cleaned = title
    .replace(/ - VLC media player$/i, '')
    .replace(/ - Media Player Classic Home Cinema$/i, '')
    .replace(/ - Media Player Classic Black Edition$/i, '')
    .replace(/ - PotPlayer(64)?$/i, '');
  
  // Remove trailing/leading spaces or dots
  cleaned = cleaned.trim().replace(/^\.*|\.*$/g, '');
  return cleaned;
}

// Simple recursive finder, prioritizes exact filename matches (excluding extension)
async function findFileRecursively(dir, targetName, maxDepth = 4, currentDepth = 0) {
  if (currentDepth > maxDepth) return null;
  if (!fs.existsSync(dir)) return null;

  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    
    // Check files first
    for (const entry of entries) {
      if (entry.isFile() && isVideoFile(entry.name)) {
        const ext = path.extname(entry.name);
        const nameWithoutExt = path.basename(entry.name, ext).trim();
        
        // Exact match (case insensitive)
        if (nameWithoutExt.toLowerCase() === targetName.toLowerCase()) {
          return path.join(dir, entry.name);
        }
      }
    }
    
    // If not found, dive into directories
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const found = await findFileRecursively(path.join(dir, entry.name), targetName, maxDepth, currentDepth + 1);
        if (found) return found;
      }
    }
  } catch (err) {
    // Ignore permissions errors
  }
  return null;
}

async function resolveFilePath(db, cleanTitle) {
  // First check if it's already in the DB and return its path
  // Since we only track filename, we do a lookup
  // We'll search by file_name starting with cleanTitle or matching it exactly
  try {
    const rows = db.prepare('SELECT file_path FROM media_history WHERE file_name LIKE ?').all(`%${cleanTitle}%`);
    for (const row of rows) {
      const ext = path.extname(row.file_path);
      const name = path.basename(row.file_path, ext).trim();
      if (name.toLowerCase() === cleanTitle.toLowerCase() && fs.existsSync(row.file_path)) {
        return row.file_path;
      }
    }
  } catch (e) {}

  // If not in DB (brand new file), we must scan the watched folders
  try {
    const folders = db.prepare('SELECT folder_path FROM watched_folders').all();
    for (const f of folders) {
      const foundPath = await findFileRecursively(f.folder_path, cleanTitle);
      if (foundPath) return foundPath;
    }
  } catch (e) {}

  return null;
}

async function pollWindowTitles(db, upsertFn) {
  try {
    const { stdout } = await execPromise('tasklist /v /fo csv');
    const lines = stdout.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;
      
      const parts = line.split('","');
      if (parts.length >= 9) {
        const imageName = parts[0].replace(/^"/, '').toLowerCase();
        let windowTitle = parts[parts.length - 1].replace(/"\s*$/, '').trim();

        if (TARGET_PLAYERS.includes(imageName)) {
          // Default titles when nothing is playing
          const ignoreTitles = [
            'vlc media player', 
            'media player classic home cinema', 
            'media player classic black edition', 
            'potplayer', 
            'potplayer64'
          ];
          
          if (ignoreTitles.includes(windowTitle.toLowerCase()) || windowTitle === 'N/A') {
            continue;
          }

          const cleanTitle = cleanWindowTitle(windowTitle);
          const previousTitle = lastDetectedTitles.get(imageName);

          if (cleanTitle !== previousTitle) {
            // Player moved to a new title!
            lastDetectedTitles.set(imageName, cleanTitle);
            
            // Resolve the path and upsert
            const filePath = await resolveFilePath(db, cleanTitle);
            if (filePath) {
              upsertFn(filePath, 'autoplay', Date.now());
            }
          }
        }
      }
    }
  } catch (err) {
    // Silently ignore exec errors
  }
}

function startAutoplayDetector(db, upsertFn) {
  // Poll every 10 seconds
  setInterval(() => pollWindowTitles(db, upsertFn), 10000);
}

module.exports = { startAutoplayDetector };
