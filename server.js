const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = 6754;
const OLLAMA_CLOUD_URL = 'https://ollama.com';
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const LOG_FILE = path.join(DATA_DIR, 'logs.txt');
const API_KEYS_FILE = path.join(DATA_DIR, 'apikeys');
const ADMIN_TOKEN_FILE = path.join(DATA_DIR, 'admin-token');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let apiKeys = [];
let disabledKeys = new Map();
const DISABLE_DURATION = 60 * 60 * 1000;
const thoughtSignatureCache = new Map();
const sessionToCacheKey = new Map();
let adminToken = null;

function generateId() {
  return Math.random().toString(36).substring(2, 15);
}

function loadApiKeys() {
  try {
    const content = fs.readFileSync(API_KEYS_FILE, 'utf8');
    const lines = content.split('\n').filter(line => line.trim() !== '');
    apiKeys = lines.map(line => {
      const parts = line.split('=');
      const name = parts[0] || 'Unnamed';
      const key = parts[1] || parts[0];
      return {
        id: generateId(),
        name,
        key,
        enabled: true,
        createdAt: new Date().toISOString(),
        lastUsed: null,
        requestCount: 0
      };
    });
    if (apiKeys.length === 0) {
      console.error('No API keys found in', API_KEYS_FILE);
    } else {
      console.log(`Loaded ${apiKeys.length} API keys from ${API_KEYS_FILE}`);
    }
  } catch (err) {
    console.error('Failed to load API keys:', err.message);
  }
}

function saveApiKeys() {
  try {
    const content = apiKeys.map(k => `${k.name}=${k.key}`).join('\n');
    fs.writeFileSync(API_KEYS_FILE, content);
    return true;
  } catch (err) {
    console.error('Failed to save API keys:', err.message);
    return false;
  }
}

function loadAdminToken() {
  try {
    if (fs.existsSync(ADMIN_TOKEN_FILE)) {
      adminToken = fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8').trim();
      console.log('Admin token loaded', adminToken);
    } else {
      adminToken = generateAdminToken();
      const dir = path.dirname(ADMIN_TOKEN_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(ADMIN_TOKEN_FILE, adminToken);
      console.log('Generated new admin token:', adminToken);
    }
  } catch (err) {
    console.error('Failed to load admin token:', err.message);
  }
}

function generateAdminToken() {
  return 'admin_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function getEnabledApiKeys() {
  return apiKeys.filter(key => key.enabled && isApiKeyEnabled(key.key));
}

function getRandomApiKey() {
  const enabledKeys = getEnabledApiKeys();
  if (enabledKeys.length === 0) return null;
  return enabledKeys[Math.floor(Math.random() * enabledKeys.length)].key;
}

function disableApiKey(apiKey) {
  const reEnableTime = Date.now() + DISABLE_DURATION;
  disabledKeys.set(apiKey, reEnableTime);
  console.log(`Disabled API key ${apiKey.slice(0, 8)}... until ${new Date(reEnableTime).toISOString()}`);
}

function isApiKeyEnabled(apiKey) {
  if (!disabledKeys.has(apiKey)) return true;
  const reEnableTime = disabledKeys.get(apiKey);
  return Date.now() >= reEnableTime;
}

function reEnableExpiredKeys() {
  const now = Date.now();
  for (const [apiKey, reEnableTime] of disabledKeys.entries()) {
    if (now >= reEnableTime) {
      disabledKeys.delete(apiKey);
      console.log(`Re-enabled API key ${apiKey.slice(0, 8)}...`);
    }
  }
}

function parseLogs() {
  const content = fs.readFileSync(LOG_FILE, 'utf8');
  const lines = content.split('\n').filter(line => line.trim() !== '');
  
  const hourlyStats = new Map();
  const dailyStats = new Map();
  const apikeyStats = new Map();
  
  let currentApiKey = null;
  let currentTimestamp = null;
  
  for (const line of lines) {
    const timestampMatch = line.match(/^\[(\d{4}-\d{2}-\d{2}T\d{2}):\d{2}:\d{2}\.\d+Z\]/);
    
    if (timestampMatch) {
      const hourKey = timestampMatch[1];
      const dateKey = hourKey.split('T')[0];
      
      if (line.includes('POST') || line.includes('GET')) {
        currentTimestamp = hourKey;
        hourlyStats.set(hourKey, (hourlyStats.get(hourKey) || 0) + 1);
        dailyStats.set(dateKey, (dailyStats.get(dateKey) || 0) + 1);
      }
    }
    
    if (line.includes('Used API key:')) {
      const keyMatch = line.match(/API key ([^\s.]+)\.\.\./);
      if (keyMatch && currentTimestamp) {
        currentApiKey = keyMatch[1];
        const keyShort = currentApiKey.slice(0, 8);
        
        const keyHourKey = `${currentTimestamp}|${keyShort}`;
        apikeyStats.set(keyHourKey, (apikeyStats.get(keyHourKey) || 0) + 1);
      }
    }
  }
  
  return { hourlyStats, dailyStats, apikeyStats };
}

function isGeminiModel(model) {
  return model && model.toLowerCase().includes('gemini');
}

function extractAndStrip(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  
  if (Array.isArray(obj)) {
    return obj.map(item => extractAndStrip(item));
  }
  
  const result = {};
  let thoughtSig = null;
  let id = null;
  
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'thought_signature') {
      thoughtSig = value;
      continue;
    }
    if (key === 'id' && typeof value === 'string') {
      id = value;
    }
    result[key] = extractAndStrip(value);
  }
  
  if (thoughtSig && id) {
    thoughtSignatureCache.set(id, thoughtSig);
  }
  
  return result;
}

function cacheAndStripSignatures(data, cacheKey) {
  const signatures = new Map();

  function extractAndStrip(obj) {
    if (typeof obj !== 'object' || obj === null) return obj;

    if (Array.isArray(obj)) {
      return obj.map(item => extractAndStrip(item));
    }

    const result = {};
    let thoughtSig = null;
    let id = null;

    for (const [key, value] of Object.entries(obj)) {
      if (key === 'thought_signature') {
        thoughtSig = value;
        continue;
      }
      if (key === 'id' && typeof value === 'string') {
        id = value;
      }
      if ((key === 'functionCall' || key === 'function_call' || key === 'toolUse') && typeof value === 'object' && value !== null) {
        const nestedSig = value.thought_signature;
        const nestedId = value.id || value.name;
        if (nestedSig && nestedId) {
          signatures.set(nestedId, nestedSig);
          thoughtSignatureCache.set(nestedId, nestedSig);
        }
        result[key] = extractAndStrip(value);
      } else {
        result[key] = extractAndStrip(value);
      }
    }

    if (thoughtSig && id) {
      signatures.set(id, thoughtSig);
      thoughtSignatureCache.set(id, thoughtSig);
    }

    return result;
  }

  const cleaned = extractAndStrip(data);

  if (signatures.size > 0) {
    thoughtSignatureCache.set(cacheKey, signatures);
  }

  return { cleaned, signatures };
}

function transformGeminiResponse(data, sessionId) {
  if (!data) return data;

  let cacheKey = null;

  if (data.metadata?.session_id) {
    cacheKey = data.metadata.session_id;
  } else if (sessionId) {
    cacheKey = sessionId;
  }

  const { cleaned, signatures } = cacheAndStripSignatures(data, cacheKey);

  return { cleaned, cacheKey };
}

function injectSignatures(data, cacheKey) {
  if (!data) return data;

  if (data.messages && Array.isArray(data.messages)) {
    for (const message of data.messages) {
      if (message.content && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const sig = thoughtSignatureCache.get(block.tool_use_id);
            if (sig) {
              block.thought_signature = sig;
            }
          }
        }
      }
    }
    return data;
  }

  if (!cacheKey) return data;

  let signatures = thoughtSignatureCache.get(cacheKey);
  if (!signatures || signatures.size === 0) {
    signatures = thoughtSignatureCache.get(`tool_${cacheKey}`);
  }
  if (!signatures || signatures.size === 0) return data;

  function inject(obj) {
    if (typeof obj !== 'object' || obj === null) return obj;

    if (Array.isArray(obj)) {
      return obj.map(item => inject(item));
    }

    const result = {};
    let idForSig = null;

    for (const [key, value] of Object.entries(obj)) {
      if (key === 'id' && typeof value === 'string') {
        result[key] = value;
        idForSig = value;
      } else if (key === 'functionCall' || key === 'function_call' || key === 'toolUse') {
        result[key] = inject(value);
        const funcId = value?.id || value?.name || value?.functionCall?.name;
        const sig = signatures.get(funcId);
        if (sig && typeof result[key] === 'object') {
          result[key]['thought_signature'] = sig;
        }
      } else if (key === 'type' && value === 'tool_use') {
        result[key] = value;
        const toolId = obj.id;
        if (toolId) {
          const sig = signatures.get(toolId);
          if (sig) {
            result['thought_signature'] = sig;
          }
        }
      } else if (key === 'type' && value === 'tool_result') {
        result[key] = value;
        const toolUseId = obj.tool_use_id;
        if (toolUseId) {
          const toolSigs = thoughtSignatureCache.get(`tool_${toolUseId}`);
          const sig = toolSigs?.get(toolUseId) || signatures.get(toolUseId);
          if (sig) {
            result['thought_signature'] = sig;
          }
        }
      } else {
        result[key] = inject(value);
      }
    }

    if (idForSig) {
      const sig = signatures.get(idForSig);
      if (sig && !result.thought_signature) {
        result['thought_signature'] = sig;
      }
    }

    return result;
  }

  if (data.content) {
    data.content = data.content.map(block => inject(block));
  }

  return data;
}

loadApiKeys();
loadAdminToken();
setInterval(reEnableExpiredKeys, 60000);

app.use(express.json({ limit: '50mb' }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') && req.path !== '/api/token') {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization required' });
    }
    const token = authHeader.substring(7);
    if (token !== adminToken) {
	    console.log(adminToken, token)
      return res.status(401).json({ error: 'Invalid admin token' });
    }
  }
  next();
});

app.get('/api/keys', (req, res) => {
  const keysWithUsage = apiKeys.map(key => {
    const isRateLimited = !isApiKeyEnabled(key.key);
    return {
      id: key.id,
      name: key.name,
      key: key.key,
      enabled: key.enabled,
      createdAt: key.createdAt,
      lastUsed: key.lastUsed || null,
      requestCount: key.requestCount || 0,
      isRateLimited
    };
  });
  res.json({ keys: keysWithUsage });
});

app.post('/api/keys', (req, res) => {
  const { name, key } = req.body;
  if (!key || key.trim() === '') {
    return res.status(400).json({ error: 'Key is required and cannot be empty' });
  }
  const newKey = {
    id: generateId(),
    name: name || key.slice(0, 12),
    key: key.trim(),
    enabled: true,
    createdAt: new Date().toISOString(),
    lastUsed: null,
    requestCount: 0
  };
  apiKeys.push(newKey);
  if (!saveApiKeys()) {
    return res.status(500).json({ error: 'Failed to save API keys' });
  }
  res.json({ key: newKey });
});

app.delete('/api/keys/:id', (req, res) => {
  const index = apiKeys.findIndex(k => k.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'API key not found' });
  }
  const removed = apiKeys.splice(index, 1)[0];
  disabledKeys.delete(removed.key);
  if (!saveApiKeys()) {
    return res.status(500).json({ error: 'Failed to save API keys' });
  }
  res.json({ success: true });
});

app.put('/api/keys/:id/enable', (req, res) => {
  const key = apiKeys.find(k => k.id === req.params.id);
  if (!key) {
    return res.status(404).json({ error: 'API key not found' });
  }
  key.enabled = true;
  if (!saveApiKeys()) {
    return res.status(500).json({ error: 'Failed to save API keys' });
  }
  res.json({ key });
});

app.put('/api/keys/:id/disable', (req, res) => {
  const key = apiKeys.find(k => k.id === req.params.id);
  if (!key) {
    return res.status(404).json({ error: 'API key not found' });
  }
  key.enabled = false;
  if (!saveApiKeys()) {
    return res.status(500).json({ error: 'Failed to save API keys' });
  }
  res.json({ key });
});

app.put('/api/keys/:id/rotate', (req, res) => {
  const key = apiKeys.find(k => k.id === req.params.id);
  if (!key) {
    return res.status(404).json({ error: 'API key not found' });
  }
  const { newKey } = req.body;
  if (!newKey || newKey.trim() === '') {
    return res.status(400).json({ error: 'New key is required' });
  }
  disabledKeys.delete(key.key);
  key.key = newKey.trim();
  if (!saveApiKeys()) {
    return res.status(500).json({ error: 'Failed to save API keys' });
  }
  res.json({ key });
});

app.get('/api/usage', (req, res) => {
  const { hourlyStats, dailyStats, apikeyStats } = parseLogs();
  
  const keyTotals = new Map();
  for (const [keyHour, count] of apikeyStats.entries()) {
    const [_, keyShort] = keyHour.split('|');
    keyTotals.set(keyShort, (keyTotals.get(keyShort) || 0) + count);
  }
  
  const usageByApiKey = {};
  for (const apiKey of apiKeys) {
    const keyShort = apiKey.key.slice(0, 8);
    usageByApiKey[apiKey.id] = {
      name: apiKey.name,
      keyPrefix: keyShort,
      requestCount: keyTotals.get(keyShort) || 0
    };
  }
  
  const sortedDays = Array.from(dailyStats.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const last7Days = sortedDays.slice(-7);
  const dailyUsage = Object.fromEntries(last7Days);
  
  const sortedHours = Array.from(hourlyStats.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const last24Hours = sortedHours.slice(-24);
  const hourlyUsage = Object.fromEntries(last24Hours);
  
  res.json({
    byApiKey: usageByApiKey,
    daily: dailyUsage,
    hourly: hourlyUsage
  });
});

app.get('/api/stats', (req, res) => {
  const totalKeys = apiKeys.length;
  const enabledKeys = apiKeys.filter(k => k.enabled).length;
  const disabledCount = totalKeys - enabledKeys;
  
  let totalRequests = 0;
  for (const key of apiKeys) {
    totalRequests += key.requestCount || 0;
  }
  
  res.json({
    totalKeys,
    enabledKeys,
    disabledCount,
    totalRequests
  });
});

app.get('/api/token', (req, res) => {
  res.json({ token: adminToken });
});

app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  let logEntry = `[${timestamp}] ${req.method} ${req.url}\n`;
  if (req.body) {
    logEntry += `  Body: ${JSON.stringify(req.body)}\n`;
  }
  fs.appendFileSync(LOG_FILE, logEntry);
  next();
});

app.all('*', async (req, res, next) => {
  const selectedKey = getRandomApiKey();
  currentApiKey = selectedKey;
  
  const headers = { ...req.headers };
  delete headers.host;
  
  if (currentApiKey) {
    headers['authorization'] = `Bearer ${currentApiKey}`;
    const keyRecord = apiKeys.find(k => k.key === currentApiKey);
    if (keyRecord) {
      keyRecord.lastUsed = new Date().toISOString();
      keyRecord.requestCount = (keyRecord.requestCount || 0) + 1;
    }
  }
  
  const isStreaming = req.body && req.body.stream !== false;
  const model = req.body?.model;
  const isGemini = isGeminiModel(model);
  
  let requestData;
  if (['GET', 'HEAD'].includes(req.method)) {
    requestData = undefined;
  } else {
    requestData = req.body;
  }
  
  try {
    const response = await axios({
      method: req.method,
      url: `${OLLAMA_CLOUD_URL}${req.url}`,
      headers,
      data: requestData,
      responseType: isStreaming ? 'stream' : 'json',
      timeout: 120000,
      validateStatus: () => true
    });
    res.set(response.headers);
    res.status(response.status);
    
    if (response.status === 429) {
      if (currentApiKey) {
        disableApiKey(currentApiKey);
      }
      fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] Rate limit hit, disabled API key ${currentApiKey?.slice(0, 8)}...\n\n`);
    }
    
    if (isStreaming) {
      if (isGemini) {
        let buffer = '';
        let cacheKey = null;
        
        response.data.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          
          for (const line of lines) {
            if (line.trim() && line.startsWith('data: ')) {
              const jsonStr = line.slice(6);
              if (jsonStr.trim() === '[DONE]') {
                res.write(line + '\n');
                continue;
              }
              try {
                const parsed = JSON.parse(jsonStr);
                const { cleaned, cacheKey: newCacheKey } = transformGeminiResponse(parsed, cacheKey);
                if (newCacheKey && !cacheKey) {
                  cacheKey = newCacheKey;
                }
                res.write('data: ' + JSON.stringify(cleaned) + '\n');
              } catch (e) {
                res.write(line + '\n');
              }
            } else {
              res.write(line + '\n');
            }
          }
        });
        
        response.data.on('end', () => {
          if (buffer) {
            if (buffer.trim() && buffer.startsWith('data: ')) {
              try {
                const parsed = JSON.parse(buffer.slice(6));
                const { cleaned, cacheKey: newCacheKey } = transformGeminiResponse(parsed, cacheKey);
                if (newCacheKey && !cacheKey) {
                  cacheKey = newCacheKey;
                }
                res.write('data: ' + JSON.stringify(cleaned) + '\n');
              } catch (e) {
                res.write(buffer);
              }
            } else {
              res.write(buffer);
            }
          }
          res.end();
          fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] Response completed\n\n`);
        });
      } else {
        response.data.pipe(res);
        response.data.on('error', (err) => {
          console.error('Stream error:', err.message);
        });
        response.data.on('end', () => {
          fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] Response completed\n\n`);
        });
      }
    } else {
      let responseData = response.data;
      if (isGemini) {
        const { cleaned, cacheKey } = transformGeminiResponse(responseData);
        responseData = injectSignatures(cleaned, cacheKey);
      }
      res.json(responseData);
      fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] Response completed\n\n`);
    }
  } catch (error) {
    console.error('Proxy error:', error.message);
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] Used API key: ${currentApiKey}\n`);
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] Error: ${error.message}\n\n`);
    res.status(500).json({ error: error.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Ollama proxy server running on port ${PORT}`);
  console.log(`Logging to ${LOG_FILE}`);
  console.log(`Dashboard available at http://localhost:${PORT}`);
});
