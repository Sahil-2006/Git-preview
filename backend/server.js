const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { chromium } = require('playwright');
const util = require('util');
const execAsync = util.promisify(exec);

const app = express();
const port = process.env.PORT || 3001;

// Enable CORS with specific options
app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.json());

// Health check endpoint with detailed status
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    port: port,
    version: process.version
  });
});

// Create temporary projects directory
let projectsDir = path.join(__dirname, 'temp-projects');

// Safely clean up directory
const cleanupDirectory = async (dir) => {
  try {
    if (await fs.pathExists(dir)) {
      await fs.emptyDir(dir);
    } else {
      await fs.ensureDir(dir);
    }
    return dir;
  } catch (error) {
    console.error('Error cleaning up directory:', error);
    // If directory is locked, create a new one with timestamp
    const newDir = `${dir}-${Date.now()}`;
    await fs.ensureDir(newDir);
    return newDir;
  }
};

// Initialize projects directory
(async () => {
  try {
    projectsDir = await cleanupDirectory(projectsDir);
    console.log('Projects directory initialized:', projectsDir);
  } catch (error) {
    console.error('Failed to initialize projects directory:', error);
    process.exit(1); // Exit if we can't set up the projects directory
  }
})();

// Validate GitHub URL
const validateGitHubUrl = (url) => {
  try {
    const urlObj = new URL(url);
    if (urlObj.hostname !== 'github.com') {
      throw new Error('Not a GitHub URL');
    }
    const parts = urlObj.pathname.split('/').filter(Boolean);
    if (parts.length < 2) {
      throw new Error('Invalid GitHub repository URL format');
    }
    return true;
  } catch (error) {
    throw new Error('Invalid URL: ' + error.message);
  }
};

// Helper to detect project type and get setup commands
const detectProjectType = async (projectPath) => {
  const files = await fs.readdir(projectPath);
  const hasFile = (name) => files.includes(name);
  
  if (hasFile('package.json')) {
    const packageJson = await fs.readJson(path.join(projectPath, 'package.json'));
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
    
    if (deps['next']) return { type: 'next', startCmd: 'npm run dev', port: 3000 };
    if (deps['react-scripts']) return { type: 'create-react-app', startCmd: 'npm start', port: 3000 };
    if (deps['@vue/cli-service']) return { type: 'vue', startCmd: 'npm run serve', port: 8080 };
    if (deps['vite']) return { type: 'vite', startCmd: 'npm run dev', port: 5173 };
    
    // Check for static site with dev dependencies
    if (hasFile('index.html')) return { type: 'static', startCmd: 'npx serve', port: 3000 };
    
    return { type: 'node', startCmd: packageJson.scripts?.start || 'node index.js', port: 3000 };
  }
  
  if (hasFile('index.html')) return { type: 'static', startCmd: 'npx serve', port: 3000 };
  
  throw new Error('Unable to detect project type. Repository must contain either package.json or index.html');
};

// Clone and setup repository
const setupRepository = async (repoUrl) => {
  const projectId = uuidv4();
  const projectPath = path.join(projectsDir, projectId);
  
  try {
    console.log('Cloning repository:', repoUrl);
    await execAsync(`git clone ${repoUrl} ${projectPath}`);
    console.log('Repository cloned successfully');
    
    // Detect project type
    console.log('Detecting project type...');
    const projectConfig = await detectProjectType(projectPath);
    console.log('Project type detected:', projectConfig.type);
    
    // Install dependencies if needed
    if (projectConfig.type !== 'static') {
      console.log('Installing dependencies...');
      try {
        await execAsync('npm install --force --legacy-peer-deps', { cwd: projectPath });
        console.log('Dependencies installed successfully');
      } catch (installError) {
        console.error('Error installing dependencies:', installError);
        throw new Error(`Failed to install dependencies: ${installError.message}`);
      }
    }
    
    return { projectPath, projectConfig };
  } catch (error) {
    console.error('Error in setupRepository:', error);
    try {
      await fs.remove(projectPath);
    } catch (cleanupError) {
      console.error('Error cleaning up project directory:', cleanupError);
    }
    if (error.message.includes('fatal: repository') || error.message.includes('fatal: not a git repository')) {
      throw new Error('Repository not found or access denied');
    }
    throw error;
  }
};

// Start development server
const startDevServer = async (projectPath, startCmd) => {
  return new Promise((resolve, reject) => {
    console.log('Starting development server with command:', startCmd);
    const process = exec(startCmd, { cwd: projectPath });
    
    let output = '';
    let errorOutput = '';
    
    // Collect output for debugging
    process.stdout.on('data', (data) => {
      output += data;
      console.log('Server output:', data);
      if (data.includes('ready') || data.includes('started') || data.includes('running') || data.includes('compiled')) {
        console.log('Server started successfully');
        resolve(process);
      }
    });
    
    process.stderr.on('data', (data) => {
      errorOutput += data;
      console.error('Server error:', data);
      // Only reject if it's a real error, not just warnings
      if (data.toLowerCase().includes('error') && 
          !data.toLowerCase().includes('warn') && 
          !data.toLowerCase().includes('deprecated') &&
          !data.toLowerCase().includes('peer')) {
        reject(new Error(`Server error: ${data}`));
      }
    });
    
    // Timeout after 5 minutes for large projects
    setTimeout(() => {
      reject(new Error(`Server start timeout. Output: ${output}\nErrors: ${errorOutput}`));
    }, 300000);
  });
};

app.post('/preview', async (req, res) => {
  const { repoUrl } = req.body;
  
  if (!repoUrl) {
    return res.status(400).json({ error: 'Repository URL is required' });
  }

  let projectPath;
  let serverProcess;

  try {
    // Validate GitHub URL
    validateGitHubUrl(repoUrl);
    
    // Setup repository
    const setup = await setupRepository(repoUrl);
    projectPath = setup.projectPath;
    
    // Start development server
    serverProcess = await startDevServer(setup.projectPath, setup.projectConfig.startCmd);
    
    // Wait a bit longer for the server to be fully ready
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // Generate preview URL
    const previewUrl = `http://localhost:${setup.projectConfig.port}`;
    
    // Take screenshot using Playwright
    console.log('Taking screenshot...');
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 720 });
    
    try {
      await page.goto(previewUrl, { 
        waitUntil: 'networkidle',
        timeout: 60000 
      });
      
      // Wait for any animations to complete
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const screenshot = await page.screenshot({ fullPage: true });
      await browser.close();
      
      // Clean up
      if (serverProcess) {
        try {
          serverProcess.kill();
        } catch (error) {
          console.error('Error killing server process:', error);
        }
      }
      
      if (projectPath) {
        try {
          await fs.remove(projectPath);
        } catch (error) {
          console.error('Error removing project directory:', error);
        }
      }
      
      res.json({
        success: true,
        previewUrl,
        screenshot: screenshot.toString('base64'),
        message: 'Preview generated successfully'
      });
    } catch (screenshotError) {
      console.error('Error taking screenshot:', screenshotError);
      throw new Error(`Failed to take screenshot: ${screenshotError.message}`);
    }
  } catch (error) {
    console.error('Error:', error);
    
    // Clean up on error
    if (serverProcess) {
      try {
        serverProcess.kill();
      } catch (error) {
        console.error('Error killing server process:', error);
      }
    }
    
    if (projectPath) {
      try {
        await fs.remove(projectPath);
      } catch (error) {
        console.error('Error removing project directory:', error);
      }
    }
    
    res.status(500).json({ 
      error: 'Failed to generate preview',
      details: error.message 
    });
  }
});

// Start the server with error handling and retry logic
const startServer = (retries = 5) => {
  const server = app.listen(port, '0.0.0.0', (error) => {
    if (error) {
      console.error('Error starting server:', error);
      if (retries > 0 && error.code === 'EADDRINUSE') {
        console.log(`Port ${port} in use, retrying in 1 second... (${retries} retries left)`);
        setTimeout(() => startServer(retries - 1), 1000);
      } else {
        process.exit(1);
      }
      return;
    }
    console.log(`Server running on http://localhost:${port}`);
  });

  // Handle server errors
  server.on('error', (error) => {
    console.error('Server error:', error);
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Retrying...`);
      setTimeout(() => {
        server.close();
        startServer(retries - 1);
      }, 1000);
    } else {
      process.exit(1);
    }
  });

  // Handle graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down gracefully...');
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return server;
};

// Start the server
startServer();