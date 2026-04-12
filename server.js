const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = 6754;
const OLLAMA_CLOUD_URL = 'https://ollama.com';
const LOG_FILE = path.join(__dirname, 'logs.txt');
const API_KEYS_FILE = path.join(os.homedir(), '.ollama', 'apikeys');

let apiKeys = [];

function loadApiKeys() {
  try {
    const content = fs.readFileSync(API_KEYS_FILE, 'utf8');
    apiKeys = content.split('\n').filter(line => line.trim() !== '').map(x => x.split('=')[1]);
    if (apiKeys.length === 0) {
      console.error('No API keys found in', API_KEYS_FILE);
    } else {
      console.log(`Loaded ${apiKeys.length} API keys from ${API_KEYS_FILE}`);
    }
  } catch (err) {
    console.error('Failed to load API keys:', err.message);
  }
}

function getRandomApiKey() {
  if (apiKeys.length === 0) return null;
  return apiKeys[Math.floor(Math.random() * apiKeys.length)];
}

loadApiKeys();

app.use(express.json({ limit: '50mb' }));

app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  let logEntry = `[${timestamp}] ${req.method} ${req.url}\n`;

  if (req.body) {
    logEntry += `  Body: ${JSON.stringify(req.body)}\n`;
  }

  fs.appendFileSync(LOG_FILE, logEntry);

  next();
});

let currentApiKey = null;

app.all('*', async (req, res, next) => {
  currentApiKey = getRandomApiKey();

  const headers = { ...req.headers };
  delete headers.host;

  if (currentApiKey) {
    headers['authorization'] = `Bearer ${currentApiKey}`;
  }

  const isStreaming = req.body && req.body.stream !== false;
  const requestData = ['GET', 'HEAD'].includes(req.method) ? undefined : req.body;

  try {
    const response = await axios({
      method: req.method,
      url: `${OLLAMA_CLOUD_URL}${req.url}`,
      headers,
      data: requestData,
      responseType: isStreaming ? 'stream' : 'json',
      timeout: 120000
    });

    res.set(response.headers);
    res.status(response.status);

    if (isStreaming) {
      response.data.pipe(res);

      response.data.on('error', (err) => {
        console.error('Stream error:', err.message);
      });

      response.data.on('end', () => {
        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] Response completed\n\n`);
      });
    } else {
      res.json(response.data);

      fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] Response completed\n\n`);
    }
  } catch (error) {
    console.error('Proxy error:', error.message);
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] Used API key: ${currentApiKey}\n`);
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] Error: ${error.message}\n\n`);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Ollama proxy server running on port ${PORT}`);
  console.log(`Logging to ${LOG_FILE}`);
});
