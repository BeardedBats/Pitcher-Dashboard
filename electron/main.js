const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const net = require("net");

let mainWindow = null;
let backendProcess = null;
let backendPort = null;

// Find a free port for the backend
function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

// Get the path to the bundled Python backend
function getBackendPath() {
  if (app.isPackaged) {
    const exeName = process.platform === "win32" ? "backend.exe" : "backend";
    return path.join(process.resourcesPath, "backend", exeName);
  }
  return null; // Dev mode
}

async function startBackend() {
  backendPort = await getFreePort();
  const backendPath = getBackendPath();

  if (backendPath) {
    console.log(`Starting bundled backend on port ${backendPort}...`);
    backendProcess = spawn(backendPath, [], {
      env: { ...process.env, PORT: String(backendPort) },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else {
    const backendDir = path.join(__dirname, "..", "backend");
    const pythonCmd = process.platform === "win32" ? "python" : "python3";
    console.log(`Starting dev backend on port ${backendPort}...`);
    backendProcess = spawn(
      pythonCmd,
      ["-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", String(backendPort)],
      {
        cwd: backendDir,
        env: { ...process.env, PORT: String(backendPort) },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
  }

  backendProcess.stdout.on("data", (data) => {
    console.log(`[backend] ${data.toString().trim()}`);
  });
  backendProcess.stderr.on("data", (data) => {
    console.log(`[backend] ${data.toString().trim()}`);
  });
  backendProcess.on("error", (err) => {
    console.error("Failed to start backend:", err);
    dialog.showErrorBox(
      "Backend Error",
      `Failed to start the backend server.\n\n${err.message}`
    );
  });
  backendProcess.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.log(`Backend exited with code ${code}`);
    }
  });

  await waitForBackend(backendPort);
}

function waitForBackend(port, maxRetries = 30) {
  return new Promise((resolve) => {
    let attempts = 0;
    const check = () => {
      const req = net.createConnection({ port, host: "127.0.0.1" }, () => {
        req.end();
        resolve();
      });
      req.on("error", () => {
        attempts++;
        if (attempts >= maxRetries) {
          console.warn("Backend did not start in time, proceeding anyway...");
          resolve();
        } else {
          setTimeout(check, 500);
        }
      });
    };
    check();
  });
}

function getFrontendBuildDir() {
  if (app.isPackaged) {
    // extraResources puts frontend-build alongside backend in resources/
    return path.join(process.resourcesPath, "frontend-build");
  }
  return path.join(__dirname, "..", "frontend-build");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 700,
    title: "Nick's Live Pitcher Data Dashboard",
    backgroundColor: "#12131E",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (app.isPackaged) {
    // Load from built frontend — inject port script into the HTML directly
    const buildDir = getFrontendBuildDir();
    const indexPath = path.join(buildDir, "index.html");
    const originalHtml = fs.readFileSync(indexPath, "utf8");

    // Inject the port as the very first thing in <head>, before any app scripts
    const portScript = `<script>window.__BACKEND_PORT__=${backendPort};</script>`;
    const modifiedHtml = originalHtml.replace("<head>", `<head>${portScript}`);

    // Write modified HTML to same directory so relative paths still work
    const launchPath = path.join(buildDir, "_launch.html");
    fs.writeFileSync(launchPath, modifiedHtml);
    mainWindow.loadFile(launchPath);
  } else {
    // Dev mode: load from React dev server
    mainWindow.loadURL("http://localhost:3000");
    // In dev, port injection happens after load — api.js falls back to 8000
    // which is fine since dev backend runs on 8000
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Open a new window with a hash route (e.g. #player/12345 or #card/2026-03-08/12345/789)
function openNewWindow(hash) {
  const child = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: "Nick's Live Pitcher Data Dashboard",
    backgroundColor: "#12131E",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (app.isPackaged) {
    const buildDir = getFrontendBuildDir();
    const indexPath = path.join(buildDir, "index.html");
    const originalHtml = fs.readFileSync(indexPath, "utf8");
    const portScript = `<script>window.__BACKEND_PORT__=${backendPort};</script>`;
    const modifiedHtml = originalHtml.replace("<head>", `<head>${portScript}`);
    // Write a unique launch file for each new window to avoid conflicts
    const launchPath = path.join(buildDir, `_launch_${Date.now()}.html`);
    fs.writeFileSync(launchPath, modifiedHtml);
    child.loadFile(launchPath, { hash });
    // Clean up temp file after load
    child.webContents.on("did-finish-load", () => {
      try { fs.unlinkSync(launchPath); } catch (e) { /* ignore */ }
    });
  } else {
    child.loadURL(`http://localhost:3000#${hash}`);
  }
}

ipcMain.handle("open-new-window", (_event, hash) => {
  openNewWindow(hash);
});

app.whenReady().then(async () => {
  try {
    await startBackend();
    createWindow();
  } catch (err) {
    console.error("Startup error:", err);
    dialog.showErrorBox("Startup Error", err.message);
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (backendProcess) {
    console.log("Shutting down backend...");
    if (process.platform === "win32") {
      // On Windows, kill the entire process tree so cmd/python children die too
      try {
        spawn("taskkill", ["/pid", String(backendProcess.pid), "/T", "/F"], { stdio: "ignore" });
      } catch (e) {
        backendProcess.kill();
      }
    } else {
      backendProcess.kill();
    }
    backendProcess = null;
  }
});
