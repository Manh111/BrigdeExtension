#!/usr/bin/env node
// S.C.O.R.E — Node.js System Bridge
// WebSocket server that acts as the "arm" of the agent on Windows

const http = require('http');
const { WebSocketServer } = require('ws');
const { exec, execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 7478;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('S.C.O.R.E System Bridge is running\n');
});

const wss = new WebSocketServer({ server });
let discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL || '';

console.log(`\n╔══════════════════════════════════════════╗`);
console.log(`║   S.C.O.R.E System Bridge v1.0.0         ║`);
console.log(`║   WebSocket listening on port ${PORT}      ║`);
console.log(`╚══════════════════════════════════════════╝\n`);

if (discordWebhookUrl) {
  console.log('[BRIDGE] Discord webhook enabled via DISCORD_WEBHOOK_URL');
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
  default: os.homedir() + '\\Documents\\SCORE_Files'
};

// ─── Launch Application ───────────────────────────────────────────────────────
function launchApp(appName, ws) {
  const paths = APP_PATHS[appName.toLowerCase()] || [appName];

  let launched = false;
  for (const appPath of paths) {
    try {
      const expandedPath = appPath.replace('%USERNAME%', os.userInfo().username)
                                   .replace('%LOCALAPPDATA%', process.env.LOCALAPPDATA || '');

      // Try direct spawn first, then system start
      if (os.platform() === 'win32') {
        exec(`start "" "${expandedPath}"`, (err) => {
          if (!err) {
            ws.send(JSON.stringify({ type: 'APP_LAUNCHED', app: appName, success: true }));
          }
        });
      } else {
        // Linux/Mac fallback
        exec(`${appPath}`, (err) => {
          if (!err) ws.send(JSON.stringify({ type: 'APP_LAUNCHED', app: appName, success: true }));
        });
      }
      launched = true;
      break;
    } catch (e) {
      continue;
    }
  }

  if (!launched) {
    // Last resort: try system command
    exec(appName, (err, stdout, stderr) => {
      if (!err) {
        ws.send(JSON.stringify({ type: 'APP_LAUNCHED', app: appName, success: true }));
      } else {
        ws.send(JSON.stringify({ type: 'APP_LAUNCHED', app: appName, success: false, error: err.message }));
      }
    });
  }
}

// ─── Move File ────────────────────────────────────────────────────────────────
function moveFile(filename, destination, ws) {
  const downloadsDir = path.join(os.homedir(), 'Downloads');
  const srcPath = path.join(downloadsDir, filename);

  // Resolve destination
  let destDir = SUBJECT_FOLDERS[destination.toLowerCase()] || destination;
  if (!path.isAbsolute(destDir)) {
    destDir = path.join(os.homedir(), 'Documents', destDir);
  }

  // Create destination if not exists
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const destPath = path.join(destDir, filename);

  try {
    if (fs.existsSync(srcPath)) {
      fs.renameSync(srcPath, destPath);
      ws.send(JSON.stringify({ type: 'FILE_MOVED', from: srcPath, to: destPath, success: true }));
    } else {
      ws.send(JSON.stringify({ type: 'FILE_MOVED', success: false, error: `File not found: ${srcPath}` }));
    }
  } catch (e) {
    ws.send(JSON.stringify({ type: 'FILE_MOVED', success: false, error: e.message }));
  }
}

// ─── System Stats ─────────────────────────────────────────────────────────────
async function getSystemStats(ws) {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  // CPU usage calculation
  let totalIdle = 0, totalTick = 0;
  cpus.forEach(cpu => {
    for (const type in cpu.times) totalTick += cpu.times[type];
    totalIdle += cpu.times.idle;
  });
  const cpuUsage = Math.round(100 - (100 * totalIdle / totalTick));

  // Get processes (Windows)
  let processes = [];
  if (os.platform() === 'win32') {
    try {
      const output = execSync('tasklist /FO CSV /NH', { timeout: 3000 }).toString();
      processes = output.split('\n').slice(0, 10).map(line => {
        const parts = line.replace(/"/g, '').split(',');
        return { name: parts[0], pid: parts[1], mem: parts[4] };
      }).filter(p => p.name);
    } catch (e) {}
  }

  ws.send(JSON.stringify({
    type: 'SYSTEM_STATS',
    data: {
      cpu: Math.max(0, Math.min(100, cpuUsage)),
      memUsed: Math.round(usedMem / 1024 / 1024),
      memTotal: Math.round(totalMem / 1024 / 1024),
      memPercent: Math.round((usedMem / totalMem) * 100),
      platform: os.platform(),
      uptime: Math.round(os.uptime()),
      processes: processes.slice(0, 5)
    }
  }));
}

// ─── Execute System Command ───────────────────────────────────────────────────
function executeCommand(command, ws) {
  exec(command, { timeout: 30000 }, (err, stdout, stderr) => {
    ws.send(JSON.stringify({
      type: 'COMMAND_RESULT',
      command,
      output: stdout || stderr || err?.message || 'Command executed',
      success: !err
    }));
  });
}

// ─── WebSocket Connection Handler ─────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[BRIDGE] Client connected: ${clientIp}`);

  // Send welcome
  ws.send(JSON.stringify({
    type: 'BRIDGE_READY',
    platform: os.platform(),
    version: '1.0.0',
    capabilities: ['launch_app', 'move_file', 'system_stats', 'execute_command', 'discord_notify', 'set_discord_webhook']
  }));

  // Start stats polling
  const statsInterval = setInterval(() => {
    if (ws.readyState === 1) getSystemStats(ws);
  }, 2000);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log(`[BRIDGE] Received: ${msg.type}`);

      switch (msg.type) {
        case 'HANDSHAKE':
          console.log(`[BRIDGE] Extension handshake confirmed`);
          break;

        case 'GET_STATS':
          getSystemStats(ws);
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
          if (os.platform() === 'win32') {
            exec(`taskkill /IM "${msg.process}" /F`, (err) => {
              ws.send(JSON.stringify({ type: 'PROCESS_KILLED', process: msg.process, success: !err }));
            });
          }
          break;

        case 'SET_DISCORD_WEBHOOK':
          discordWebhookUrl = (msg.url || '').trim();
          ws.send(JSON.stringify({
            type: 'DISCORD_WEBHOOK_SET',
            success: Boolean(discordWebhookUrl)
          }));
          break;

        case 'DISCORD_NOTIFY': {
          sendDiscordWebhook({
            content: msg.content,
            username: msg.username || 'S.C.O.R.E Agent'
          }).then((result) => {
            ws.send(JSON.stringify({
              type: 'DISCORD_NOTIFY_RESULT',
              requestId: msg.requestId || null,
              success: result.ok,
              error: result.reason || null
            }));
          });
          break;
        }
      }
    } catch (e) {
      console.error('[BRIDGE] Parse error:', e.message);
    }
  });

  ws.on('close', () => {
    clearInterval(statsInterval);
    console.log('[BRIDGE] Client disconnected');
  });

  ws.on('error', (err) => {
    console.error('[BRIDGE] Error:', err.message);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║   S.C.O.R.E System Bridge v1.0.0         ║`);
  console.log(`║   Listening on port ${PORT}               ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
  console.log('[BRIDGE] Ready. Waiting for connection...\n');
});
