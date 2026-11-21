const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const { spawn, execFile } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { chromium } = require('playwright');
const net = require('net');
const http = require('http');
const util = require('util');
const execFileAsync = util.promisify(execFile);

const app = express();
const port = Number(process.env.PORT) || 3001;
const host = process.env.HOST || '127.0.0.1';
const projectsDir = path.resolve(__dirname, 'temp-projects');
const previews = new Map();
const reservedPorts = new Set();
const MAX_ACTIVE_PREVIEWS = 3;
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 60 * 60_000;
const requestedTtl = Number(process.env.PREVIEW_TTL_MS);
const PREVIEW_TTL_MS = Number.isFinite(requestedTtl)
  ? Math.max(MIN_TTL_MS, Math.min(requestedTtl, MAX_TTL_MS))
  : 15 * 60_000;
const frontendOrigins = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  ...(process.env.FRONTEND_ORIGIN ? [process.env.FRONTEND_ORIGIN] : [])
]);
let previewsStarting = 0;
let shuttingDown = false;

app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && !frontendOrigins.has(origin)) {
    return res.status(403).json({ error: 'This local service only accepts requests from the configured frontend.' });
  }
  next();
});

app.use(cors({
  origin: (origin, callback) => callback(null, !origin || frontendOrigins.has(origin)),
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  maxAge: 600
}));
app.use(express.json({ limit: '2kb' }));

app.get('/health', (req, res) => {
  res.json({
    status: shuttingDown ? 'shutting-down' : 'ok',
    activePreviews: previews.size,
    startingPreviews: previewsStarting,
    maxActivePreviews: MAX_ACTIVE_PREVIEWS,
    previewTtlMs: PREVIEW_TTL_MS
  });
});

const canonicalGitHubUrl = (value) => {
  if (typeof value !== 'string' || value.length > 300) {
    throw new Error('Enter a public GitHub repository URL.');
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a valid GitHub repository URL.');
  }

  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Only public repositories on https://github.com are supported.');
  }

  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?\/?$/i);
  if (!match || match[1] === '.' || match[1] === '..') {
    throw new Error('Use a repository URL in the form https://github.com/owner/repository.');
  }

  const repository = match[2].replace(/\.git$/i, '');
  if (!repository || repository === '.' || repository === '..') {
    throw new Error('Use a repository URL in the form https://github.com/owner/repository.');
  }

  return 'https://github.com/' + match[1] + '/' + repository + '.git';
};

const detectProjectType = async (projectPath) => {
  const rootEntries = await fs.readdir(projectPath);
  const hasFile = (name) => rootEntries.includes(name);
  let packageJson = null;

  if (hasFile('package.json')) {
    try {
      packageJson = await fs.readJson(path.join(projectPath, 'package.json'));
    } catch {
      throw new Error('The repository has an invalid package.json.');
    }
  }

  const scripts = packageJson && packageJson.scripts ? packageJson.scripts : {};
  const dependencies = {
    ...(packageJson && packageJson.dependencies ? packageJson.dependencies : {}),
    ...(packageJson && packageJson.devDependencies ? packageJson.devDependencies : {})
  };

  if (dependencies.next && scripts.dev) return { type: 'next', script: 'dev' };
  if (dependencies['react-scripts'] && scripts.start) return { type: 'create-react-app', script: 'start' };
  if (dependencies['@vue/cli-service'] && scripts.serve) return { type: 'vue', script: 'serve' };
  if (dependencies.vite && scripts.dev) return { type: 'vite', script: 'dev' };
  if (hasFile('index.html') && !scripts.start) return { type: 'static' };
  if (scripts.start) return { type: 'node', script: 'start' };

  throw new Error('Unable to detect a supported project. Add a supported framework script or a root index.html.');
};

const runNpm = async (args, options) => {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return execFileAsync(command, args, {
    ...options,
    shell: process.platform === 'win32',
    windowsHide: true,
    timeout: options.timeout || 180_000,
    maxBuffer: 4 * 1024 * 1024
  });
};

const setupRepository = async (repoUrl) => {
  const projectId = uuidv4();
  const projectPath = path.join(projectsDir, projectId);

  try {
    await fs.ensureDir(projectsDir);
    await execFileAsync('git', ['clone', '--depth', '1', '--', repoUrl, projectPath], {
      timeout: 120_000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024
    });

    const projectConfig = await detectProjectType(projectPath);
    if (projectConfig.type !== 'static') {
      await runNpm(['install', '--no-audit', '--no-fund', '--legacy-peer-deps'], {
        cwd: projectPath,
        timeout: 180_000
      });
    }

    return { projectPath, projectConfig };
  } catch (error) {
    await removeOwnedProject(projectPath);
    if (error.code === 'ETIMEDOUT' || error.killed) {
      throw new Error('Repository setup timed out. Try a smaller public repository.');
    }
    if (error.code === 'ENOENT' && error.syscall === 'spawn git') {
      throw new Error('Git was not found. Install Git and restart the local preview service.');
    }
    if (error.message && error.message.includes('repository not found')) {
      throw new Error('Repository not found or unavailable. Only public GitHub repositories can be previewed.');
    }
    throw new Error('Repository setup failed: ' + (error.message || 'unknown error'));
  }
};

const allocatePort = async () => {
  while (true) {
    const selectedPort = await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const candidate = probe.address().port;
        probe.close((error) => error ? reject(error) : resolve(candidate));
      });
    });
    if (!reservedPorts.has(selectedPort)) {
      reservedPorts.add(selectedPort);
      return selectedPort;
    }
  }
};

const createStaticPreview = async (projectPath, previewPort) => {
  const staticApp = express();
  staticApp.use((req, res, next) => {
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(req.path);
    } catch {
      return res.sendStatus(400);
    }
    if (decodedPath.split('/').some((part) => part === '.git' || part === 'node_modules')) {
      return res.sendStatus(404);
    }
    next();
  });
  staticApp.use(express.static(projectPath, {
    dotfiles: 'deny',
    index: ['index.html'],
    redirect: false,
    fallthrough: true
  }));
  staticApp.get('*', async (req, res, next) => {
    try {
      const indexPath = path.join(projectPath, 'index.html');
      if (await fs.pathExists(indexPath)) return res.sendFile(indexPath);
      return res.sendStatus(404);
    } catch (error) {
      next(error);
    }
  });

  const server = await new Promise((resolve, reject) => {
    const listener = staticApp.listen(previewPort, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  return { server, process: null, logs: '' };
};

const createNpmPreview = (projectPath, projectConfig, previewPort) => {
  const args = ['run', projectConfig.script];
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(previewPort),
    BROWSER: 'none',
    CI: 'true'
  };

  if (projectConfig.type === 'next') {
    args.push('--', '--hostname', '127.0.0.1', '--port', String(previewPort));
  } else if (projectConfig.type === 'vite') {
    args.push('--', '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort');
  } else if (projectConfig.type === 'vue') {
    args.push('--', '--host', '127.0.0.1', '--port', String(previewPort));
  }

  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawn(command, args, {
    cwd: projectPath,
    env,
    shell: process.platform === 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let logs = '';
  let startError = null;
  const collect = (chunk) => {
    logs = (logs + chunk.toString()).slice(-8000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('error', (error) => {
    startError = error.message;
    logs = (logs + '\n' + error.message).slice(-8000);
  });

  return { process: child, server: null, get logs() { return logs; }, get startError() { return startError; } };
};

const sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration));

const probeHttp = (url) => new Promise((resolve) => {
  const request = http.get(url, (response) => {
    response.resume();
    resolve(response.statusCode < 500);
  });
  request.setTimeout(2000, () => {
    request.destroy();
    resolve(false);
  });
  request.on('error', () => resolve(false));
});

const waitForPreview = async (url, launch, timeoutMs = 90_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const child = launch.process;
    if (launch.startError) {
      throw new Error('Could not start the repository server: ' + launch.startError);
    }
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error('The repository server stopped before becoming ready. ' + launch.logs);
    }
    if (await probeHttp(url)) return;
    await sleep(500);
  }
  throw new Error('Preview server did not become ready in time. ' + launch.logs);
};

const removeOwnedProject = async (projectPath) => {
  if (!projectPath) return;
  const resolvedPath = path.resolve(projectPath);
  const isUuidChild = path.dirname(resolvedPath) === projectsDir &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(path.basename(resolvedPath));
  if (isUuidChild) await fs.remove(resolvedPath);
};

const stopProcess = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;

  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        timeout: 10_000,
        windowsHide: true
      });
      return;
    } catch {
      // Fall back to the direct child if taskkill is unavailable.
    }
  }

  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(4000)
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL');
    } catch {
      // The process may have exited between the check and the signal.
    }
  }
};

const closeServer = async (server) => {
  if (!server || !server.listening) return;
  await new Promise((resolve) => server.close(() => resolve()));
};

const stopPreview = async (previewId) => {
  const preview = previews.get(previewId);
  if (!preview) return false;

  previews.delete(previewId);
  clearTimeout(preview.expiryTimer);
  try {
    await stopProcess(preview.process);
    await closeServer(preview.server);
    await removeOwnedProject(preview.projectPath);
  } finally {
    reservedPorts.delete(preview.port);
  }
  return true;
};

app.get('/preview/:id', (req, res) => {
  const preview = previews.get(req.params.id);
  if (!preview) return res.status(404).json({ error: 'Preview not found or expired.' });
  if (preview.process && (preview.process.exitCode !== null || preview.process.signalCode !== null)) {
    void stopPreview(req.params.id);
    return res.status(410).json({ error: 'Preview process has stopped.' });
  }
  res.json({
    status: 'running',
    previewUrl: preview.previewUrl,
    expiresAt: preview.expiresAt
  });
});

app.delete('/preview/:id', async (req, res) => {
  const stopped = await stopPreview(req.params.id);
  if (!stopped) return res.status(404).json({ error: 'Preview not found or already stopped.' });
  res.json({ success: true, message: 'Preview stopped and its temporary clone removed.' });
});

app.post('/preview', async (req, res) => {
  if (shuttingDown) return res.status(503).json({ error: 'The local preview service is shutting down.' });
  let repoUrl;
  try {
    repoUrl = canonicalGitHubUrl(req.body && req.body.repoUrl);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  if (previews.size + previewsStarting >= MAX_ACTIVE_PREVIEWS) {
    return res.status(429).json({ error: 'All preview slots are in use. Stop a preview and try again.' });
  }

  previewsStarting += 1;
  let projectPath;
  let launch;
  let previewPort;
  let browser;
  let published = false;

  try {
    const setup = await setupRepository(repoUrl);
    projectPath = setup.projectPath;
    previewPort = await allocatePort();

    launch = setup.projectConfig.type === 'static'
      ? await createStaticPreview(projectPath, previewPort)
      : createNpmPreview(projectPath, setup.projectConfig, previewPort);

    const previewUrl = 'http://127.0.0.1:' + previewPort;
    await waitForPreview(previewUrl, launch);

    let screenshot = null;
    let warning = null;
    try {
      browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await page.goto(previewUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await sleep(750);
      screenshot = (await page.screenshot({ fullPage: false })).toString('base64');
    } catch (error) {
      warning = 'The live preview is running, but a screenshot could not be created: ' + error.message;
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
        browser = null;
      }
    }

    const previewId = uuidv4();
    const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();
    const session = {
      projectPath,
      port: previewPort,
      process: launch.process,
      server: launch.server,
      previewUrl,
      expiresAt,
      expiryTimer: null
    };
    session.expiryTimer = setTimeout(() => {
      void stopPreview(previewId).catch((error) => console.error('Preview cleanup failed:', error.message));
    }, PREVIEW_TTL_MS);
    if (session.expiryTimer.unref) session.expiryTimer.unref();

    previews.set(previewId, session);
    published = true;
    res.json({
      success: true,
      sessionId: previewId,
      previewUrl,
      expiresAt,
      screenshot,
      warning,
      message: 'Preview is live until it is stopped or expires.'
    });
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    if (launch) {
      await stopProcess(launch.process);
      await closeServer(launch.server);
    }
    await removeOwnedProject(projectPath);
    if (previewPort !== undefined) reservedPorts.delete(previewPort);
    console.error('Preview generation failed:', error.message);
    res.status(500).json({
      error: 'Failed to generate preview.',
      details: error.message
    });
  } finally {
    previewsStarting -= 1;
    if (!published && previewPort !== undefined) reservedPorts.delete(previewPort);
  }
});

const server = app.listen(port, host, () => {
  console.log('Local preview API listening at http://' + host + ':' + port);
});

server.on('error', (error) => {
  console.error('Unable to start the local preview API:', error.message);
  process.exitCode = 1;
});

const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  await Promise.all([...previews.keys()].map((previewId) => stopPreview(previewId)));
};

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
