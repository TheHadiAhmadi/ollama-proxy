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
const ADMIN_TOKEN_FILE = path.join(os.homedir(), '.ollama', 'admin-token');
const MODEL_STATS_FILE = path.join(os.homedir(), '.ollama', 'model-stats.json');
const AUDIT_LOGS_DIR = path.join(os.homedir(), '.ollama', 'audit-logs');

if (!fs.existsSync(AUDIT_LOGS_DIR)) {
  fs.mkdirSync(AUDIT_LOGS_DIR, { recursive: true });
}

const OLLAMA_CLOUD_MODELS = [
  "minimax-m2", "gemma3:27b", "gemma4:31b", "glm-5", "glm-5.1",
  "kimi-k2-thinking", "qwen3-next:80b", "nemotron-3-nano:30b", "ministral-3:14b",
  "rnj-1:8b", "gpt-oss:120b", "minimax-m2.1", "minimax-m2.7", "minimax-m2.5",
  "gemma3:4b", "kimi-k2.6", "qwen3-coder-next", "ministral-3:8b", "cogito-2.1:671b",
  "gpt-oss:20b", "nemotron-3-ultra", "minimax-m3", "mistral-large-3:675b",
  "devstral-2:123b", "qwen3.5:397b", "nemotron-3-super", "glm-4.6", "qwen3-vl:235b",
  "ministral-3:3b", "devstral-small-2:24b", "gemma3:12b", "deepseek-v3.2",
  "deepseek-v4-pro", "deepseek-v3.1:671b", "qwen3-vl:235b-instruct",
  "gemini-3-flash-preview", "glm-4.7", "kimi-k2:1t", "kimi-k2.5",
  "qwen3-coder:480b", "deepseek-v4-flash"
];

let modelStats = {};
let apiKeys = [];
let disabledKeys = new Map();
const DISABLE_DURATION = 60 * 60 * 1000;
const thoughtSignatureCache = new Map();
const sessionToCacheKey = new Map();
let adminToken = null;
const userUsageStats = new Map();

function getUserKey(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  return 'unknown';
}

function updateUserUsage(userKey, modelName) {
  if (!userUsageStats.has(userKey)) {
    userUsageStats.set(userKey, {
      apiKey: userKey,
      requestCount: 0,
      models: new Map()
    });
  }
  const stats = userUsageStats.get(userKey);
  stats.requestCount++;
  stats.models.set(modelName, (stats.models.get(modelName) || 0) + 1);
}

app.get('/api/user-usage', (req, res) => {
  const usage = Array.from(userUsageStats.values()).map(user => {
    const models = {};
    for (const [modelName, count] of user.models.entries()) {
      models[modelName] = count;
    }
    return {
      apiKey: user.apiKey,
      requestCount: user.requestCount,
      models
    };
  }).sort((a, b) => b.requestCount - a.requestCount);
  
  res.json({ users: usage });
});

function loadModelStats() {
  try {
    if (fs.existsSync(MODEL_STATS_FILE)) {
      const content = fs.readFileSync(MODEL_STATS_FILE, 'utf8');
      modelStats = JSON.parse(content);
      console.log('Loaded model stats');
    } else {
      initializeModelStats();
    }
  } catch (err) {
    console.error('Failed to load model stats:', err.message);
    initializeModelStats();
  }
}

function initializeModelStats() {
  modelStats = {};
  for (const model of OLLAMA_CLOUD_MODELS) {
    modelStats[model] = {
      successCount: 0,
      failCount: 0,
      totalResponseTime: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalRequests: 0,
      lastUsed: null,
      score: 0
    };
  }
  saveModelStats();
}

function saveModelStats() {
  try {
    fs.writeFileSync(MODEL_STATS_FILE, JSON.stringify(modelStats, null, 2));
  } catch (err) {
    console.error('Failed to save model stats:', err.message);
  }
}

function calculateModelScore(stats) {
  if (stats.successCount === 0) return 0;
  const successRate = stats.successCount / (stats.totalRequests || 1);
  const avgResponseTime = stats.totalResponseTime / stats.successCount;
  const avgTokensPerSec = stats.totalOutputTokens > 0 
    ? (stats.totalOutputTokens / stats.totalResponseTime) * 1000 
    : 0;
  const throughputScore = Math.min(avgTokensPerSec / 100, 1);
  const recencyBonus = stats.lastUsed ? Math.max(0, 1 - (Date.now() - new Date(stats.lastUsed).getTime()) / (24 * 60 * 60 * 1000)) : 0;
  return (successRate * 0.35) + (throughputScore * 0.35) + (Math.max(0, 1 - avgResponseTime / 60000) * 0.2) + (recencyBonus * 0.1);
}

function updateModelStats(model, success, responseTime, inputTokens, outputTokens) {
  if (!modelStats[model]) {
    modelStats[model] = {
      successCount: 0,
      failCount: 0,
      totalResponseTime: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalRequests: 0,
      lastUsed: null,
      score: 0
    };
  }
  modelStats[model].totalRequests++;
  if (success) {
    modelStats[model].successCount++;
    modelStats[model].totalResponseTime += responseTime;
    modelStats[model].totalInputTokens += inputTokens || 0;
    modelStats[model].totalOutputTokens += outputTokens || 0;
  } else {
    modelStats[model].failCount++;
  }
  modelStats[model].lastUsed = new Date().toISOString();
  modelStats[model].score = calculateModelScore(modelStats[model]);
  saveModelStats();
}

function saveAuditLog(model, inputTokens, outputTokens, requestBody, responseBody, metadata) {
  try {
    const timestamp = new Date().toISOString();
    const filename = `${timestamp.replace(/[:.]/g, '-')}-${model}.md`;
    const filepath = path.join(AUDIT_LOGS_DIR, filename);
    
    const content = `---
model: ${model}
timestamp: ${timestamp}
input_tokens: ${inputTokens}
output_tokens: ${outputTokens}
response_time_ms: ${metadata.responseTime}
success: ${metadata.success}
user_api_key: ${metadata.userApiKey || 'unknown'}
---

## Request Body
\`\`\`json
${JSON.stringify(requestBody, null, 4)}
\`\`\`

## Response Body
\`\`\`json
${JSON.stringify(responseBody, null, 4)}
\`\`\`
`;
    fs.writeFileSync(filepath, content);
  } catch (err) {
    console.error('Failed to save audit log:', err.message);
  }
}

function getBestModel() {
  const sorted = Object.entries(modelStats)
    .map(([model, stats]) => ({ model, score: stats.score }))
    .sort((a, b) => b.score - a.score);
  return sorted[0]?.model || 'minimax-m2.5';
}

function getTopModels(count = 5) {
  return Object.entries(modelStats)
    .map(([model, stats]) => ({ model, ...stats }))
    .sort((a, b) => b.score - a.score)
    .slice(0, count);
}

app.get('/api/models/ranked', (req, res) => {
  const models = getTopModels(20);
  res.json({ models });
});

app.get('/api/audit-logs', (req, res) => {
  try {
    const files = fs.readdirSync(AUDIT_LOGS_DIR);
    const logs = files
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const filepath = path.join(AUDIT_LOGS_DIR, f);
        const content = fs.readFileSync(filepath, 'utf8');
        const frontmatter = content.split('---')[1];
        const metadata = {};
        frontmatter.split('\n').forEach(line => {
          const [key, ...value] = line.split(':');
          if (key && value.length) {
            metadata[key.trim()] = value.join(':').trim();
          }
        });
        return {
          filename: f,
          ...metadata
        };
      })
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 100);
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function testModel(model) {
  const testPrompt = "Say 'OK' if you can hear me.";
  const selectedKey = getRandomApiKey();
  if (!selectedKey) return { success: false, error: 'No API key available' };
  
  const startTime = Date.now();
  try {
    const response = await axios.post(
      `${OLLAMA_CLOUD_URL}/chat/completions`,
      {
        model: model,
        messages: [{ role: 'user', content: testPrompt }],
        max_tokens: 20
      },
      {
        headers: { 'authorization': `Bearer ${selectedKey}` },
        timeout: 30000
      }
    );
    const responseTime = Date.now() - startTime;
    let inputTokens = 0;
    let outputTokens = 0;
    if (response.data?.usage) {
      inputTokens = response.data.usage.prompt_tokens || 0;
      outputTokens = response.data.usage.completion_tokens || 0;
    }
    if (response.status === 200 && response.data?.choices) {
      updateModelStats(model, true, responseTime, inputTokens, outputTokens);
      saveAuditLog(model, inputTokens, outputTokens, { model, messages: [{ role: 'user', content: testPrompt }] }, response.data, { success: true, responseTime, userApiKey: selectedKey?.slice(0, 8) });
      return { success: true, responseTime, inputTokens, outputTokens };
    } else {
      updateModelStats(model, false, responseTime, inputTokens, outputTokens);
      return { success: false, error: 'Invalid response' };
    }
  } catch (err) {
    const responseTime = Date.now() - startTime;
    updateModelStats(model, false, responseTime, 0, 0);
    return { success: false, error: err.message };
  }
}

async function testAllModels() {
  console.log('Testing all models...');
  const results = [];
  for (const model of OLLAMA_CLOUD_MODELS) {
    const result = await testModel(model);
    results.push({ model, ...result });
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('Model testing complete:', results.filter(r => r.success).length, 'successful');
  return results;
}

app.get('/api/models/test', async (req, res) => {
  if (req.headers.authorization !== `Bearer ${adminToken}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const results = await testAllModels();
  res.json({ results });
});

setInterval(async () => {
  await testAllModels();
}, 60 * 60 * 1000);

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
      console.log('Admin token loaded');
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
loadModelStats();
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
  const isStreaming = req.body && req.body.stream !== false;
  let model = req.body?.model;
  const isGemini = isGeminiModel(model);

  const userKey = getUserKey(req);
  let modelName = model || 'unknown';
  
  updateUserUsage(userKey, modelName);

  let requestData;
  if (['GET', 'HEAD'].includes(req.method)) {
    requestData = undefined;
  } else {
    requestData = req.body;
  }

  if (model === 'auto') {
    const bestModel = getBestModel();
    model = bestModel;
    modelName = bestModel;
    requestData = { ...requestData, model: bestModel };
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] Auto-selected model: ${bestModel}\n`);
  }

  const requestStartTime = Date.now();
  const maxRetries = 3;
  let attempt = 0;
  let lastError = null;

  while (attempt < maxRetries) {
    attempt++;
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
      const responseTime = Date.now() - requestStartTime;
      let inputTokens = 0;
      let outputTokens = 0;
      let responseDataForAudit = null;
      
      if (response.status === 429) {
        updateModelStats(modelName, false, responseTime, 0, 0);
        if (currentApiKey) {
          disableApiKey(currentApiKey);
        }
        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] Rate limit hit, disabled API key ${currentApiKey?.slice(0, 8)}...\n\n`);
      }
      
      if (response.status === 401) {
        updateModelStats(modelName, false, responseTime, 0, 0);
        if (currentApiKey) {
          disableApiKey(currentApiKey);
        }
        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] Unauthorized (401), disabled API key ${currentApiKey?.slice(0, 8)}...\n\n`);
        if (attempt < maxRetries && getEnabledApiKeys().length > 0) {
          continue;
        }
        if (attempt >= maxRetries) {
          return res.status(401).json({ error: 'Unauthorized - all available keys disabled after retries' });
        }
      }

      if (response.status >= 200 && response.status < 300) {
        if (!isStreaming && response.data?.usage) {
          inputTokens = response.data.usage.prompt_tokens || 0;
          outputTokens = response.data.usage.completion_tokens || 0;
          responseDataForAudit = response.data;
        }
        updateModelStats(modelName, true, responseTime, inputTokens, outputTokens);
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
        if (responseDataForAudit) {
          saveAuditLog(modelName, inputTokens, outputTokens, requestData, responseData, { success: true, responseTime, userApiKey: userKey });
        }
        res.json(responseData);
        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] Response completed\n\n`);
      }
      return;
    } catch (error) {
      const responseTime = Date.now() - requestStartTime;
      updateModelStats(modelName, false, responseTime, 0, 0);
      console.error('Proxy error:', error.message);
      fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] Used API key: ${currentApiKey}\n`);
      fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] Error: ${error.message}\n\n`);
      lastError = error;
      if (attempt < maxRetries && getEnabledApiKeys().length > 0) {
        continue;
      }
      return res.status(500).json({ error: error.message });
    }
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Ollama proxy server running on port ${PORT}`);
  console.log(`Logging to ${LOG_FILE}`);
  console.log(`Dashboard available at http://localhost:${PORT}`);
});
