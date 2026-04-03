#!/usr/bin/env node
// S.C.O.R.E — Node.js System Bridge
// WebSocket server that acts as the "arm" of the agent on Windows

const http = require('http');
const { WebSocketServer } = require('ws');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT || 7478);
const HOST = process.env.BRIDGE_HOST || (process.env.PORT || process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_ID ? '0.0.0.0' : '127.0.0.1');
const STRICT_MODE = process.env.BRIDGE_STRICT_MODE === '1';
const BRIDGE_TOKEN = (process.env.BRIDGE_TOKEN || '').trim();
const MAX_COMMAND_LENGTH = 512;
const MAX_COMMAND_OUTPUT = 50 * 1024;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('S.C.O.R.E System Bridge is running\n');
});

const wss = new WebSocketServer({ server });
let discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL || '';

console.log('\n╔══════════════════════════════════════════╗');
console.log('║   S.C.O.R.E System Bridge v1.1.0         ║');
console.log(`║   WebSocket listening on ${HOST}:${PORT}   ║`);
console.log('╚══════════════════════════════════════════╝\n');

if (discordWebhookUrl) {
  console.log('[BRIDGE] Discord webhook enabled via DISCORD_WEBHOOK_URL');
}
if (BRIDGE_TOKEN) {
  console.log('[BRIDGE] Token authentication is enabled');
}
if (STRICT_MODE) {
  console.log('[BRIDGE] Strict mode is enabled');
}

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    console.error('[BRIDGE] Failed to send message:', err.message);
  }
}

function truncateOutput(text, maxLen = MAX_COMMAND_OUTPUT) {
  const value = String(text || '');
  if (value.length <= maxLen) return { text: value, truncated: false };
  return { text: `${value.slice(0, maxLen)}\n[OUTPUT TRUNCATED]`, truncated: true };
}

function expandEnvPath(rawPath) {
  if (typeof rawPath !== 'string') return '';
  return rawPath
    .replace('%USERNAME%', os.userInfo().username)
    .replace('%LOCALAPPDATA%', process.env.LOCALAPPDATA || '');
}

function isValidDiscordWebhook(urlText) {
  if (!urlText) return true;
  try {
    const parsed = new URL(urlText);
    if (parsed.protocol !== 'https:') return false;
    return parsed.hostname === 'discord.com' || parsed.hostname === 'canary.discord.com' || parsed.hostname === 'ptb.discord.com';
  } catch {
    return false;
  }
}

function isSafeFilename(filename) {
  if (typeof filename !== 'string') return false;
  if (!filename.trim()) return false;
  if (filename.includes('..')) return false;
  if (filename.includes('/') || filename.includes('\\')) return false;
  if (/^[a-zA-Z]:/.test(filename)) return false;
  return true;
}

function isSafeProcessName(name) {
  if (typeof name !== 'string') return false;
  const normalized = name.trim();
  if (!normalized) return false;
  return /^[\w.\- ()]+$/.test(normalized);
}

function isPotentiallyDangerousCommand(command) {
  // Keep compatibility by allowing most commands, but block obviously dangerous shell chaining patterns.
  return /[\r\n\0]|&&|\|\||\|\s*\w|;/.test(command);
}

// ─── App Paths (Windows) ──────────────────────────────────────────────────────
const APP_PATHS = {
  godot: [
    'C:\\Program Files\\Godot\\Godot_v4.x_stable_win64.exe',
    '%LOCALAPPDATA%\\Programs\\Godot\\Godot.exe',
    'godot4'
  ],
  vscode: [
    'C:\\Users\\%USERNAME%\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
    'code'
  ],
  ssms: [
    'C:\\Program Files (x86)\\Microsoft SQL Server Management Studio 19\\Common7\\IDE\\Ssms.exe',
    'C:\\Program Files (x86)\\Microsoft SQL Server Management Studio 18\\Common7\\IDE\\Ssms.exe'
  ],
  notepad: ['notepad.exe'],
  explorer: ['explorer.exe'],
  chrome: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'chrome'
  ],
  intellij: [
    'C:\\Program Files\\JetBrains\\IntelliJ IDEA Community Edition*\\bin\\idea64.exe',
    'idea'
  ]
};

// ─── Subject Folder Mapping ───────────────────────────────────────────────────
const SUBJECT_FOLDERS = {
  uml: 'D:\\Study\\Software_Engineering\\UML',
  java: 'D:\\Study\\Java',
  se: 'D:\\Study\\Software_Engineering',
  backpack: 'D:\\Projects\\Backpack_Rush',
  default: path.join(os.homedir(), 'Documents', 'SCORE_Files')
};

// ─── Launch Application ───────────────────────────────────────────────────────
async function launchApp(appName, ws) {
  if (typeof appName !== 'string' || !appName.trim()) {
    safeSend(ws, { type: 'APP_LAUNCHED', app: appName || '', success: false, error: 'Invalid app name' });
    return;
  }

  const normalized = appName.trim().toLowerCase();
  const hasMappedApp = Boolean(APP_PATHS[normalized]);
  if (STRICT_MODE && !hasMappedApp) {
    safeSend(ws, {
      type: 'APP_LAUNCHED',
      app: appName,
      success: false,
      error: 'App is not allowed in strict mode'
    });
    return;
  }

  const paths = hasMappedApp ? APP_PATHS[normalized] : [appName.trim()];

  const runCommand = (command, options = {}) => new Promise((resolve) => {
    exec(command, options, (err) => resolve({ ok: !err, err }));
  });

  for (const appPath of paths) {
    const expandedPath = expandEnvPath(appPath);
    const isWindowsPath = os.platform() === 'win32' && /[\\/]/.test(expandedPath);
    const launchCommand = os.platform() === 'win32' && isWindowsPath
      ? `start "" "${expandedPath}"`
      : expandedPath;

    const result = await runCommand(launchCommand);
    if (result.ok) {
      safeSend(ws, { type: 'APP_LAUNCHED', app: appName, success: true });
      return;
    }
  }

  safeSend(ws, {
    type: 'APP_LAUNCHED',
    app: appName,
    success: false,
    error: `Unable to launch ${appName}`
  });
}

// ─── Move File ────────────────────────────────────────────────────────────────
function moveFile(filename, destination, ws) {
  if (!isSafeFilename(filename)) {
    safeSend(ws, { type: 'FILE_MOVED', success: false, error: 'Invalid filename' });
    return;
  }

  const destinationKey = String(destination || 'default').trim().toLowerCase();
  const mappedDestination = SUBJECT_FOLDERS[destinationKey] || destination || SUBJECT_FOLDERS.default;

  const downloadsDir = path.join(os.homedir(), 'Downloads');
  const srcPath = path.resolve(path.join(downloadsDir, filename));
  if (!srcPath.startsWith(path.resolve(downloadsDir) + path.sep)) {
    safeSend(ws, { type: 'FILE_MOVED', success: false, error: 'Source path is outside Downloads' });
    return;
  }

  let destDir = mappedDestination;
  if (!path.isAbsolute(destDir)) {
    destDir = path.join(os.homedir(), 'Documents', String(destDir));
  }
  destDir = path.resolve(destDir);

  const destPath = path.resolve(path.join(destDir, filename));
  if (!destPath.startsWith(destDir + path.sep)) {
    safeSend(ws, { type: 'FILE_MOVED', success: false, error: 'Invalid destination path' });
    return;
  }

  try {
    if (!fs.existsSync(srcPath)) {
      safeSend(ws, { type: 'FILE_MOVED', success: false, error: `File not found: ${srcPath}` });
      return;
    }

    fs.mkdirSync(destDir, { recursive: true });
    fs.renameSync(srcPath, destPath);
    safeSend(ws, { type: 'FILE_MOVED', from: srcPath, to: destPath, success: true });
  } catch (e) {
    safeSend(ws, { type: 'FILE_MOVED', success: false, error: e.message });
  }
}

function getProcessListWindows() {
  return new Promise((resolve) => {
    const child = spawn('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true });
    let output = '';

    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });

    child.on('error', () => resolve([]));

    child.on('close', () => {
      const processes = output
        .split(/\r?\n/)
        .slice(0, 15)
        .map((line) => {
          const parts = line.replace(/"/g, '').split(',');
          return { name: parts[0], pid: parts[1], mem: parts[4] };
        })
        .filter((p) => p.name);
      resolve(processes.slice(0, 5));
    });

    setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Ignore kill errors for timeout protection.
      }
    }, 3000);
  });
}

// ─── System Stats ─────────────────────────────────────────────────────────────
async function getSystemStats(ws) {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  let totalIdle = 0;
  let totalTick = 0;
  cpus.forEach((cpu) => {
    for (const type in cpu.times) totalTick += cpu.times[type];
    totalIdle += cpu.times.idle;
  });
  const cpuUsage = Math.round(100 - (100 * totalIdle / totalTick));

  let processes = [];
  if (os.platform() === 'win32') {
    processes = await getProcessListWindows();
  }

  safeSend(ws, {
    type: 'SYSTEM_STATS',
    data: {
      cpu: Math.max(0, Math.min(100, cpuUsage)),
      memUsed: Math.round(usedMem / 1024 / 1024),
      memTotal: Math.round(totalMem / 1024 / 1024),
      memPercent: Math.round((usedMem / totalMem) * 100),
      platform: os.platform(),
      uptime: Math.round(os.uptime()),
      processes
    }
  });
}

// ─── Execute System Command ───────────────────────────────────────────────────
function executeCommand(command, ws) {
  if (typeof command !== 'string' || !command.trim()) {
    safeSend(ws, { type: 'COMMAND_RESULT', command: '', output: 'Invalid command', success: false });
    return;
  }

  const normalized = command.trim();
  if (normalized.length > MAX_COMMAND_LENGTH) {
    safeSend(ws, {
      type: 'COMMAND_RESULT',
      command: normalized.slice(0, MAX_COMMAND_LENGTH),
      output: 'Command too long',
      success: false
    });
    return;
  }

  if (STRICT_MODE && isPotentiallyDangerousCommand(normalized)) {
    safeSend(ws, {
      type: 'COMMAND_RESULT',
      command: normalized,
      output: 'Command blocked by strict mode policy',
      success: false
    });
    return;
  }

  exec(normalized, { timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    const rawOutput = stdout || stderr || err?.message || 'Command executed';
    const { text, truncated } = truncateOutput(rawOutput);
    safeSend(ws, {
      type: 'COMMAND_RESULT',
      command: normalized,
      output: text,
      success: !err,
      truncated
    });
  });
}

function killProcess(processName, ws) {
  if (os.platform() !== 'win32') {
    safeSend(ws, { type: 'PROCESS_KILLED', process: processName || '', success: false, error: 'Unsupported platform' });
    return;
  }

  if (!isSafeProcessName(processName)) {
    safeSend(ws, { type: 'PROCESS_KILLED', process: processName || '', success: false, error: 'Invalid process name' });
    return;
  }

  const child = spawn('taskkill', ['/IM', processName.trim(), '/F'], { windowsHide: true });
  child.on('close', (code) => {
    safeSend(ws, { type: 'PROCESS_KILLED', process: processName, success: code === 0 });
  });
  child.on('error', (err) => {
    safeSend(ws, { type: 'PROCESS_KILLED', process: processName, success: false, error: err.message });
  });
}

async function sendDiscordWebhook({ content, username = 'S.C.O.R.E Bridge' }) {
  if (!discordWebhookUrl) return { ok: false, reason: 'Discord webhook not configured' };
  if (!content || typeof content !== 'string') return { ok: false, reason: 'Invalid content' };

  try {
    const resp = await fetch(discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, username })
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { ok: false, reason: `Discord HTTP ${resp.status}: ${body}` };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function isAuthorizedRequest(req) {
  if (!BRIDGE_TOKEN) return true;

  const authHeader = req.headers.authorization || '';
  if (authHeader === `Bearer ${BRIDGE_TOKEN}`) return true;

  try {
    const origin = `http://${req.headers.host || `${HOST}:${PORT}`}`;
    const url = new URL(req.url || '/', origin);
    if (url.searchParams.get('token') === BRIDGE_TOKEN) return true;
  } catch {
    // Ignore URL parse errors.
  }

  return false;
}

// ─── WebSocket Connection Handler ─────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  if (!isAuthorizedRequest(req)) {
    console.warn(`[BRIDGE] Unauthorized connection attempt from ${clientIp}`);
    try {
      ws.close(1008, 'Unauthorized');
    } catch {
      // Ignore close errors.
    }
    return;
  }

  console.log(`[BRIDGE] Client connected: ${clientIp}`);

  safeSend(ws, {
    type: 'BRIDGE_READY',
    platform: os.platform(),
    version: '1.1.0',
    capabilities: ['launch_app', 'move_file', 'system_stats', 'execute_command', 'discord_notify', 'set_discord_webhook']
  });

  const statsInterval = setInterval(() => {
    if (ws.readyState === 1) {
      getSystemStats(ws).catch(() => {
        // Avoid unhandled async errors in polling loop.
      });
    }
  }, 2000);

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      console.error('[BRIDGE] Parse error:', e.message);
      return;
    }

    console.log(`[BRIDGE] Received: ${msg.type}`);

    switch (msg.type) {
      case 'HANDSHAKE':
        console.log('[BRIDGE] Extension handshake confirmed');
        break;

      case 'GET_STATS':
        getSystemStats(ws).catch(() => {
          safeSend(ws, { type: 'SYSTEM_STATS', data: { cpu: 0, memUsed: 0, memTotal: 0, memPercent: 0, platform: os.platform(), uptime: 0, processes: [] } });
        });
        break;

      case 'LAUNCH_APP':
        launchApp(msg.app, ws);
        break;

      case 'MOVE_FILE':
        moveFile(msg.filename, msg.destination, ws);
        break;

      case 'EXECUTE_COMMAND':
        executeCommand(msg.command, ws);
        break;

      case 'KILL_PROCESS':
        killProcess(msg.process, ws);
        break;

      case 'SET_DISCORD_WEBHOOK': {
        const nextWebhook = String(msg.url || '').trim();
        if (!isValidDiscordWebhook(nextWebhook)) {
          safeSend(ws, { type: 'DISCORD_WEBHOOK_SET', success: false, error: 'Invalid Discord webhook URL' });
          break;
        }
        discordWebhookUrl = nextWebhook;
        safeSend(ws, { type: 'DISCORD_WEBHOOK_SET', success: Boolean(discordWebhookUrl) });
        break;
      }

      case 'DISCORD_NOTIFY':
        sendDiscordWebhook({
          content: msg.content,
          username: msg.username || 'S.C.O.R.E Agent'
        }).then((result) => {
          safeSend(ws, {
            type: 'DISCORD_NOTIFY_RESULT',
            requestId: msg.requestId || null,
            success: result.ok,
            error: result.reason || null
          });
        });
        break;

      default:
        safeSend(ws, { type: 'BRIDGE_ERROR', success: false, error: `Unknown message type: ${msg.type}` });
        break;
    }
  });

  ws.on('close', () => {
    clearInterval(statsInterval);
    console.log('[BRIDGE] Client disconnected');
  });

  ws.on('error', (err) => {
    clearInterval(statsInterval);
    console.error('[BRIDGE] Error:', err.message);
    try {
      ws.close(1011, 'Server error');
    } catch {
      // Ignore close errors.
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   S.C.O.R.E System Bridge v1.1.0         ║');
  console.log(`║   Listening on ${HOST}:${PORT}             ║`);
  console.log('╚══════════════════════════════════════════╝\n');
  console.log('[BRIDGE] Ready. Waiting for connection...\n');
});

