<div align="center">
  <h1>🎬 LastPlayed</h1>
  <p>A modern desktop application that automatically tracks your local media watch history</p>
  <p>
    <a href="#features">Features</a> • 
    <a href="#tech-stack">Tech Stack</a> • 
    <a href="#setup--development-instructions">Getting Started</a>
  </p>
  <br />
</div>

LastPlayed scans selected folders for new episodes, lets you resume right where you left off, and can even import your past viewing history from players like VLC and MPC-HC.

## Features

- **Continue Watching View:** Instantly see the last episode you watched for every TV series and resume playback with one click.
- **Auto-Detection:** Uses intelligent folder parsing to group your files into TV shows and detects episode formats (e.g. S02E05).
- **Background Tracking:** Quietly monitors your media folders for new files and updates your library automatically.
- **Legacy History Import:** Pulls in past viewing history from VLC, MPC-HC, MPC-BE, and Windows Recent files on your very first launch.
- **Premium UI:** Built with Electron, HTML/CSS, and Lucide icons, featuring a beautiful dark-mode interface and dynamic animations.

## Tech Stack

<div align="center">
  <img src="https://img.shields.io/badge/Electron-191970?style=for-the-badge&logo=electron&logoColor=white" alt="Electron.js" />
  <img src="https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white" alt="HTML5" />
  <img src="https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white" alt="CSS3" />
  <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" alt="JavaScript" />
  <img src="https://img.shields.io/badge/SQLite-07405E?style=for-the-badge&logo=sqlite&logoColor=white" alt="SQLite" />
  <img src="https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js" />
</div>

---

## Setup & Development Instructions

### Prerequisites
Make sure you have [Node.js](https://nodejs.org/) installed on your machine (v16 or higher is recommended).

### 1. Install Dependencies
Clone or download the repository, then run:
```bash
npm install
```
*Note: This project uses a native sqlite module. The `postinstall` script will automatically compile it to match Electron's internal Node version.*

### 2. Run in Development Mode
To launch the app for testing or development:
```bash
npm start
```

### 3. Build for Production
To package the app into a standalone Windows installer (`.exe` file):
```bash
npm run build
```
The compiled setup executable will be located in the `dist` folder.

> **Adding a Custom Icon:** If you want a custom app icon, place an `icon.ico` file inside the `assets/` directory and add `icon: assets/icon.ico` under the `win` section of `electron-builder.yml` before building.
