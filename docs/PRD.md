# MediaTracker — Electron.js Build Specification (v2)

> **Platform:** Windows | **Media:** Video files | **Tracking:** Folder watcher + Open-through-app + History Import

---

## Project Overview

A desktop app that tracks which video episodes the user has watched, grouped by TV series (detected from folder structure). On first launch it imports existing watch history from VLC, MPC-HC, MPC-BE, and Windows Recent Files. Going forward it auto-tracks via folder watching and manual file opening. The primary view is **"Continue Watching"** — showing the last watched episode per series so the user never loses their place.

---

## Tech Stack

| Layer         | Choice                                  |
| ------------- | --------------------------------------- |
| Framework     | Electron.js (latest stable)             |
| UI            | HTML + CSS + Vanilla JS                 |
| Database      | `better-sqlite3` (SQLite in `userData`) |
| File watching | `chokidar`                              |
| Packaging     | `electron-builder` (Windows NSIS)       |

---

## Project Structure

```
media-tracker/
├── main.js
├── preload.js
├── importer.js          # Past history import logic (separate module)
├── series-detector.js   # Episode/series name parsing logic
├── renderer/
│   ├── index.html
│   ├── style.css
│   └── renderer.js
├── package.json
└── electron-builder.yml
```

---

## Database Schema

### `media_history`

```sql
CREATE TABLE IF NOT EXISTS media_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  file_size INTEGER,
  series_name TEXT,         -- Detected series name (e.g. "Breaking Bad")
  episode_label TEXT,       -- Detected episode (e.g. "S02E05" or "Episode 5")
  last_watched INTEGER NOT NULL,  -- Unix timestamp ms
  watch_count INTEGER DEFAULT 1,
  source TEXT DEFAULT 'watcher'   -- 'watcher' | 'manual' | 'vlc' | 'mpc' | 'windows'
);
```

### `watched_folders`

```sql
CREATE TABLE IF NOT EXISTS watched_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_path TEXT NOT NULL UNIQUE,
  added_at INTEGER NOT NULL
);
```

### `app_state`

```sql
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT
);
-- Used to store: { key: 'import_done', value: 'true' }
-- So import only runs once on first launch
```

---

## Step-by-Step Build Instructions

---

### Step 1 — Project Init

```bash
mkdir media-tracker && cd media-tracker
npm init -y
npm install electron better-sqlite3 chokidar
npm install --save-dev electron-builder
```

`package.json`:

```json
{
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "build": "electron-builder"
  }
}
```

---

### Step 2 — Series Detection Module (`series-detector.js`)

This module exports two functions:

#### `detectSeriesName(filePath)`

Tries to figure out the show name from the folder structure.

Logic (in order):

1. Take the **parent folder name** of the file
2. If the parent folder looks like a season folder (`Season 1`, `S01`, `Season One`) take the **grandparent folder name** instead
3. Clean the result: remove dots, underscores, replace with spaces, trim year patterns like `(2018)` or `.2018.`
4. Return the cleaned string as the series name

Examples:

```
/Movies/Breaking Bad/Season 2/S02E05.mkv  →  "Breaking Bad"
/Downloads/The.Office.S03E04.mkv          →  folder name cleaned
/Series/Arcane/Season 1/Episode 6.mp4    →  "Arcane"
```

#### `detectEpisodeLabel(fileName)`

Extracts episode identifier from the file name.

Try these patterns in order, return the first match:

1. `S##E##` pattern → return as-is e.g. `S02E05`
2. `##x##` pattern → convert to `S##E##`
3. `Season # Episode #` → convert to `S##E##`
4. `Episode ##` or `EP##` or `E##` → return `Ep.##`
5. If no pattern matches → return `null`

---

### Step 3 — History Import Module (`importer.js`)

Exports a single function: `importAllHistory(db, upsertFn)`

Only runs if `app_state` table does NOT have `import_done = true`. After running, set it.

#### Source 1: VLC Recent Files

Path: `%APPDATA%\vlc\vlc-qt-interface.ini`

Parse the INI file, find the `[RecentsMRL]` section, read the `list=` line.
It contains comma-separated `file:///C:/path/to/file.mp4` URIs.
Decode URI, convert to normal Windows path, filter by video extensions, call `upsertFn` for each with `source = 'vlc'`.

Use timestamp from `times=` line in the same section if available (it's a comma-separated list of ms offsets — not watch time, but use file's `mtime` as fallback via `fs.statSync`).

#### Source 2: MPC-HC Recent Files

Registry path: `HKCU\Software\MPC-HC\MPC-HC\Recent File List`

Use Node.js `child_process.exec` with `reg query` command:

```bash
reg query "HKCU\Software\MPC-HC\MPC-HC\Recent File List"
```

Parse output lines, extract file paths, filter by video extensions, call `upsertFn` with `source = 'mpc'`.

#### Source 3: MPC-BE Recent Files

Registry path: `HKCU\Software\MPC-BE\Recent File List`

Same approach as MPC-HC above.

#### Source 4: Windows Recent Files

Path: `%APPDATA%\Microsoft\Windows\Recent\`

List all `.lnk` files in that folder. Use `shell.readShortcutLink(lnkPath)` (Electron's built-in) to resolve each shortcut to its target path. Filter by video extensions. Use the `.lnk` file's `mtime` as the last watched timestamp. Call `upsertFn` with `source = 'windows'`.

#### Error Handling

Wrap each source in its own `try/catch`. If one source fails (app not installed, registry key missing), skip it silently and continue with the next. Never crash the import.

#### Return value

Return an object: `{ vlc: N, mpc: N, windows: N, total: N }` — count of records imported per source.

---

### Step 4 — Main Process (`main.js`)

#### 4a. App startup sequence

```
1. Open DB, run schema migrations
2. Create BrowserWindow (show loading state)
3. Run importAllHistory() if first launch
4. Send import results to renderer via webContents.send('import-complete', results)
5. Load all saved watched folders, start chokidar watchers
6. UI is now ready
```

#### 4b. Supported video extensions

```js
const VIDEO_EXTENSIONS = [
  ".mp4",
  ".mkv",
  ".avi",
  ".mov",
  ".wmv",
  ".flv",
  ".webm",
  ".m4v",
  ".mpg",
  ".mpeg",
  ".ts",
  ".m2ts",
  ".vob",
  ".3gp",
  ".rmvb",
];
```

#### 4c. `upsertMedia(filePath, source = 'watcher')` helper

```
1. Check if file exists on disk (skip if not)
2. Get file_size via fs.statSync
3. Detect series_name via detectSeriesName(filePath)
4. Detect episode_label via detectEpisodeLabel(basename)
5. INSERT OR REPLACE into media_history
   - On conflict (same file_path): update last_watched, increment watch_count
6. Send 'history-updated' event to renderer
```

#### 4d. IPC Handlers

| Channel               | Description                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get-history`         | All rows ordered by `last_watched DESC`                                                                                                                   |
| `get-series`          | GROUP BY `series_name`, return: series_name, last_watched, episode_label of last watched, total_episodes (count), series cover path (first file's folder) |
| `get-series-episodes` | Given a `series_name`, return all episodes for it ordered by `last_watched DESC`                                                                          |
| `get-folders`         | All watched folders                                                                                                                                       |
| `add-folder`          | Open folder dialog, save, start watching                                                                                                                  |
| `remove-folder`       | Remove from DB, stop watcher                                                                                                                              |
| `open-file`           | File dialog filtered to video extensions, upsert, launch                                                                                                  |
| `open-file-path`      | Launch given path with `shell.openPath`, upsert                                                                                                           |
| `delete-record`       | Delete by id                                                                                                                                              |
| `clear-history`       | Delete all media_history rows                                                                                                                             |
| `get-import-status`   | Return the import result counts                                                                                                                           |
| `minimize-window`     | mainWindow.minimize()                                                                                                                                     |
| `maximize-window`     | Toggle maximize/restore                                                                                                                                   |
| `close-window`        | mainWindow.close()                                                                                                                                        |

#### 4e. Chokidar Watcher

```js
chokidar.watch(folderPath, {
  persistent: true,
  ignoreInitial: true,
  depth: 8, // TV series can be nested deep
  awaitWriteFinish: true, // Wait for file to finish writing before logging
});

// Listen to 'add' and 'change' events
// 'add' catches newly downloaded episodes
// 'change' catches when a file is modified/accessed
```

---

### Step 5 — Preload Script (`preload.js`)

```js
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
  onHistoryUpdated: (cb) => ipcRenderer.on("history-updated", cb),
  onImportComplete: (cb) =>
    ipcRenderer.on("import-complete", (_, data) => cb(data)),
});
```

---

### Step 6 — UI Layout (`renderer/index.html` + `style.css`)

#### Overall Layout

```
┌──────────────────────────────────────────────────┐
│  Custom Titlebar: [App Name]       [_ □ ✕]       │
├────────────┬─────────────────────────────────────┤
│            │  [Tab Bar: Continue | Series | All] │
│  Sidebar   ├─────────────────────────────────────┤
│            │                                     │
│  - Nav     │   Main Content Area                 │
│  - Stats   │   (changes based on active tab)     │
│            │                                     │
│  - Folders │                                     │
└────────────┴─────────────────────────────────────┘
```

#### Tabs (3 main views)

**Tab 1: Continue Watching** (default)

- Grid of series cards
- Each card shows:
  - Series name (large)
  - Last watched episode label e.g. "S02E05"
  - Last watched date (relative: "3 days ago")
  - Total episodes tracked (small badge)
  - ▶ Resume button → calls `openFilePath` with the last watched file
  - Click card body → opens Series Detail view
- Empty state: "No series tracked yet. Add a folder or open a file to get started."

**Series Detail View** (opens when clicking a series card, replaces main content)

- Back button → returns to Continue Watching
- Series name as heading
- Chronological list of all episodes for that series
- Each episode row: episode label, file name, last watched date, watch count, ▶ Play button
- Sorted by episode label (S01E01 → S01E02 etc.)

**Tab 2: All History**

- Flat searchable list of all tracked files (not grouped)
- Search bar (filter by name)
- Sort: Last Watched / Most Watched / File Name
- Each row: file name, series name (if detected), episode label, last watched, watch count, ▶ Play, 🗑 Delete

**Tab 3: Folders & Import**

- **Watched Folders section:**
  - - Add Folder button
  - List of folders with Remove button
- **Import History section:**
  - Shows import results after first launch: "Imported 24 files — VLC: 12, MPC: 8, Windows: 4"
  - If not first launch, shows last import date
  - Button: "Re-run Import" (runs import again, useful if user installed VLC later)
- **Manual Open section:**
  - "Open File Manually" button

#### Sidebar Stats

- Total files tracked
- Total series detected
- Last watched (series name + episode, relative time)

---

### Step 7 — Renderer Logic (`renderer/renderer.js`)

```
On load:
  - loadContinueWatching()
  - loadSidebar stats()
  - api.onHistoryUpdated(() => refresh current tab)
  - api.onImportComplete((results) => show import banner)

loadContinueWatching():
  - Call api.getSeries()
  - Sort by last_watched DESC
  - Render series cards into grid

openSeriesDetail(seriesName):
  - Call api.getSeriesEpisodes(seriesName)
  - Render episode list
  - Show back button

loadAllHistory():
  - Call api.getHistory()
  - Apply search + sort
  - Render flat list

formatDate(ts):      → "May 3, 2026 at 9:41 PM"
timeAgo(ts):         → "just now" | "X min ago" | "X hours ago" | "X days ago" | "X weeks ago"
formatSize(bytes):   → "1.2 GB" | "845 MB" | "12 KB"
formatEpisode(label):→ Show label or "Unknown Episode" if null
```

---

### Step 8 — Visual Design

- **Theme:** Dark — bg `#0d0d14`, card `#13131c`, sidebar `#0f0f18`, accent `#7c6aff`
- **Font:** Load `'Outfit'` from Google Fonts — clean, modern, not generic
- **Series cards:** rounded corners, subtle border, hover lift (transform + shadow)
- **Episode rows:** alternating subtle bg, hover highlight
- **Import banner:** slides in from top on first launch, auto-dismisses after 5s
- **Tabs:** underline style active indicator
- **Scrollbar:** thin, styled (dark track, accent-colored thumb)
- **Transitions:** 150ms ease on all interactive elements

---

### Step 9 — Build Config (`electron-builder.yml`)

```yaml
appId: com.mediatracker.app
productName: MediaTracker
directories:
  output: dist
win:
  target: nsis
  icon: assets/icon.ico
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
files:
  - main.js
  - preload.js
  - importer.js
  - series-detector.js
  - renderer/**
  - assets/**
  - node_modules/**
  - package.json
```

---

## Key Behaviors & Edge Cases

| Case                              | Behavior                                                               |
| --------------------------------- | ---------------------------------------------------------------------- |
| File no longer exists on disk     | Show ⚠ icon on card, disable Play button, show "File moved or deleted" |
| Series name not detected          | Group under "Uncategorized" in series view, still show in All History  |
| Episode label not detected        | Show file name only, sort to bottom in series detail                   |
| VLC not installed                 | Skip silently, no error shown to user                                  |
| MPC not installed                 | Skip registry query silently                                           |
| Import finds 0 files              | Show "No previous history found" on Folders tab                        |
| Same file opened twice            | Increment watch_count, update last_watched only                        |
| Two different paths, same episode | Treated as two separate records (different paths)                      |
| Folder removed while watching     | Watcher closes cleanly, folder removed from DB                         |
| App relaunched                    | Watchers re-attached from DB, import skipped (already done)            |

---

## Suggested Build Order

1. `package.json` + install dependencies
2. `series-detector.js` — test with sample file paths before anything else
3. `main.js` — DB init + BrowserWindow only (no IPC)
4. `preload.js` — all bridges
5. `renderer/index.html` + `style.css` — full UI with dummy/hardcoded data
6. `main.js` — add `upsertMedia` + all IPC handlers
7. `renderer/renderer.js` — wire up real data, all 3 tabs working
8. `importer.js` — build and test each source independently
9. `main.js` — integrate importer into startup sequence
10. `main.js` — add chokidar folder watching
11. End-to-end test with real video folders
12. `electron-builder.yml` → `npm run build`
