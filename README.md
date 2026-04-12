# Ollama Proxy

A middleware proxy server that routes requests to [Ollama Cloud](https://ollama.com) while automatically rotating through multiple API keys.

## How It Works

1. **API Key Rotation**: Loads API keys from `~/.ollama/apikeys` and randomly selects one for each request
2. **Proxy Middleware**: Forwards all incoming requests to `https://ollama.com` with the selected API key
3. **Streaming Support**: Handles streaming responses properly
4. **Request Logging**: Logs all requests and responses to `logs.txt`

## Setup

```bash
npm install
```

Create your API keys file at `~/.ollama/apikeys`:

```
KEY1=sk-xxxxxxxxxxxxx
KEY2=sk-yyyyyyyyyyyyy
KEY3=sk-zzzzzzzzzzzzz
```

## Usage

```bash
node server.js
```

The proxy server runs on port **6754** by default.

## API

All requests are proxied to `https://ollama.com`. For example:

```bash
curl -X POST http://localhost:6754/api/chat \
  -H "Content-Type: application/json" \
  -d '{"model": "llama3", "messages": [{"role": "user", "content": "Hello"}]}'
```