// renderer.js

// -- Utilities --
function formatDate(ts) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit'
  }).format(new Date(ts));
}

function timeAgo(ts) {
  const diffMs = Date.now() - ts;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);
  const diffWeek = Math.floor(diffDay / 7);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHr < 24) return `${diffHr} hours ago`;
  if (diffDay < 7) return `${diffDay} days ago`;
  return `${diffWeek} weeks ago`;
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatEpisode(label) {
  return label || 'Unknown Episode';
}

// -- DOM Elements --
const tabs = {
  continue: document.getElementById('tab-continue'),
  history: document.getElementById('tab-history'),
  folders: document.getElementById('tab-folders'),
  seriesDetail: document.getElementById('view-series-detail')
};

const navItems = document.querySelectorAll('.nav-item');
let activeTab = 'continue';

// Tab Navigation
navItems.forEach(btn => {
  btn.addEventListener('click', () => {
    const targetTab = btn.getAttribute('data-tab');
    switchTab(targetTab);
  });
});

function switchTab(tabName) {
  // Update nav buttons
  navItems.forEach(b => b.classList.remove('active'));
  const btn = document.querySelector(`.nav-item[data-tab="${tabName}"]`);
  if (btn) btn.classList.add('active');

  // Hide all sections
  Object.values(tabs).forEach(t => t.classList.remove('active'));
  
  // Show target
  tabs[tabName].classList.add('active');
  activeTab = tabName;

  // Load data
  if (tabName === 'continue') loadContinueWatching();
  else if (tabName === 'history') loadAllHistory();
  else if (tabName === 'folders') loadFolders();
}

document.getElementById('btn-back-series').addEventListener('click', () => {
  switchTab('continue');
});

// Window Controls
document.getElementById('btn-minimize').addEventListener('click', () => window.api.minimizeWindow());
document.getElementById('btn-maximize').addEventListener('click', () => window.api.maximizeWindow());
document.getElementById('btn-close').addEventListener('click', () => window.api.closeWindow());

// -- Data Loading --
async function loadSidebarStats() {
  const history = await window.api.getHistory();
  const series = await window.api.getSeries();
  
  document.getElementById('stat-total-files').textContent = history.length;
  document.getElementById('stat-total-series').textContent = series.length;
  
  const lastWatchedEl = document.getElementById('stat-last-watched');
  if (history.length > 0) {
    const last = history[0]; 
    const sName = last.series_name || 'Uncategorized';
    lastWatchedEl.textContent = `${sName} • ${formatEpisode(last.episode_label)}`;
  } else {
    lastWatchedEl.textContent = 'No data yet';
  }
}

async function loadContinueWatching() {
  const series = await window.api.getSeries();
  const grid = document.getElementById('continue-grid');
  const emptyState = document.getElementById('continue-empty');
  
  if (series.length === 0) {
    grid.innerHTML = '';
    emptyState.classList.remove('hidden');
    return;
  }
  
  emptyState.classList.add('hidden');
  grid.innerHTML = series.map(s => `
    <div class="series-card group" data-series="${s.series_name}">
      <div class="card-cover-placeholder">
        <i data-lucide="${s.series_name === 'Uncategorized' ? 'folder' : 'tv'}"></i>
      </div>
      <div class="card-content">
        <div class="card-header">
          <span class="episode-badge">${s.total_episodes} Episodes</span>
        </div>
        <h3 class="series-name">${s.series_name}</h3>
        <p class="episode-label">${formatEpisode(s.episode_label)}</p>
        <p class="last-watched">${timeAgo(s.last_watched)}</p>
        <button class="play-btn" data-path="${s.last_file_path}" title="Resume Playing"><i data-lucide="play"></i></button>
      </div>
    </div>
  `).join('');

  lucide.createIcons();

  // Attach events
  grid.querySelectorAll('.series-card').forEach(card => {
    // Click card body to open detail
    card.addEventListener('click', (e) => {
      openSeriesDetail(card.getAttribute('data-series'));
    });
    
    // Play button overrides card click
    const playBtn = card.querySelector('.play-btn');
    if (playBtn) {
      playBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // Stop card click
        window.api.openFilePath(playBtn.getAttribute('data-path'));
      });
    }
  });
}

async function openSeriesDetail(seriesName) {
  tabs.continue.classList.remove('active');
  tabs.seriesDetail.classList.add('active');
  activeTab = 'seriesDetail';

  document.getElementById('detail-series-name').textContent = seriesName;
  const tbody = document.getElementById('detail-episodes-list');
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center">Loading...</td></tr>';
  
  const episodes = await window.api.getSeriesEpisodes(seriesName);
  
  tbody.innerHTML = episodes.map(ep => `
    <tr>
      <td><span class="episode-badge">${formatEpisode(ep.episode_label)}</span></td>
      <td>${ep.file_name}</td>
      <td>${formatDate(ep.last_watched)}</td>
      <td>${ep.watch_count}</td>
      <td>
        <button class="icon-btn text-accent play-file-btn" data-path="${ep.file_path}" title="Play">
          <i data-lucide="play"></i>
        </button>
      </td>
    </tr>
  `).join('');

  lucide.createIcons();

  tbody.querySelectorAll('.play-file-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.api.openFilePath(btn.getAttribute('data-path'));
    });
  });
}

let allHistoryCache = [];
async function loadAllHistory() {
  allHistoryCache = await window.api.getHistory();
  renderHistory(allHistoryCache);
}

function renderHistory(history) {
  const tbody = document.getElementById('history-list');
  if (history.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 40px; color: var(--text-secondary)">No history found</td></tr>';
    return;
  }

  tbody.innerHTML = history.map(item => `
    <tr>
      <td>${item.file_name}</td>
      <td>${item.series_name || 'Uncategorized'}</td>
      <td>${formatEpisode(item.episode_label)}</td>
      <td>${formatDate(item.last_watched)}</td>
      <td>
        <button class="icon-btn text-accent play-file-btn" data-path="${item.file_path}" title="Play">
          <i data-lucide="play"></i>
        </button>
      </td>
    </tr>
  `).join('');

  lucide.createIcons();

  tbody.querySelectorAll('.play-file-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.api.openFilePath(btn.getAttribute('data-path'));
    });
  });
}

document.getElementById('history-search').addEventListener('input', (e) => {
  const query = e.target.value.toLowerCase();
  const filtered = allHistoryCache.filter(item => 
    item.file_name.toLowerCase().includes(query) ||
    (item.series_name && item.series_name.toLowerCase().includes(query))
  );
  renderHistory(filtered);
});

async function loadFolders() {
  const folders = await window.api.getFolders();
  const list = document.getElementById('folders-list');
  
  if (folders.length === 0) {
    list.innerHTML = '<li class="folder-item" style="justify-content: center; color: var(--text-secondary)">No folders added yet</li>';
  } else {
    list.innerHTML = folders.map(f => `
      <li class="folder-item">
        <span class="folder-path">${f.folder_path}</span>
        <button class="icon-btn text-danger remove-folder-btn" data-path="${f.folder_path}">
          <i data-lucide="trash-2"></i>
        </button>
      </li>
    `).join('');
    
    lucide.createIcons();

    list.querySelectorAll('.remove-folder-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        await window.api.removeFolder(btn.getAttribute('data-path'));
        loadFolders();
      });
    });
  }

  const statusBox = document.getElementById('import-status-box');
  const status = await window.api.getImportStatus();
  if (status) {
    statusBox.innerHTML = `
      <p style="color: var(--text-primary); font-weight: 500; margin-bottom: 8px">Import Summary:</p>
      <p>VLC: ${status.vlc} | MPC: ${status.mpc} | Windows: ${status.windows}</p>
      <p style="margin-top: 8px; color: var(--accent-color)">Total records imported: ${status.total}</p>
    `;
  } else {
    statusBox.innerHTML = '<p>No import performed yet.</p>';
  }
}

document.getElementById('btn-add-folder').addEventListener('click', async () => {
  const result = await window.api.addFolder();
  if (result && result.success) {
    loadFolders();
  }
});

document.getElementById('btn-open-file-nav').addEventListener('click', () => {
  window.api.openFile();
});

// Import banner
function showImportBanner(results) {
  const banner = document.getElementById('import-banner');
  const text = document.getElementById('import-banner-text');
  text.textContent = `Imported ${results.total} files (VLC: ${results.vlc}, MPC: ${results.mpc}, Windows: ${results.windows})`;
  banner.classList.add('show');
  setTimeout(() => {
    banner.classList.remove('show');
  }, 5000);
}

// Global listeners
window.api.onHistoryUpdated(() => {
  loadSidebarStats();
  if (activeTab === 'continue') loadContinueWatching();
  else if (activeTab === 'history') loadAllHistory();
});

window.api.onImportComplete((results) => {
  showImportBanner(results);
  window.api.onHistoryUpdated();
});

// Initial load
loadSidebarStats();
loadContinueWatching();
