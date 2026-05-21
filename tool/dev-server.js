// Simple dev server — serves static files + proxies /api/optimize via dynamic import
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT || 3456;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const SYSTEM_PROMPT = `你是一个专业的AI提示词优化专家。你的任务是把用户用大白话写的需求，转成高质量、结构化的提示词，让任何AI模型都能给出更好的回答。

优化原则：
1. 识别用户的真实意图和场景
2. 补充合适的角色设定、背景信息
3. 明确输出要求：格式、长度、风格、禁忌
4. 保持用户使用的语言
5. 如果用户的问题比较模糊，合理推测并补充细节

输出规则：
- 直接输出优化后的提示词，不要有任何前缀或后缀
- 不要加"好的""以下是优化后的提示词"等开头语
- 不要解释你为什么这样优化
- 用清晰的结构组织，但不要过度复杂化
- 篇幅适中，不要啰嗦`;

function mapError(status) {
  switch (status) {
    case 401: return 'API Key 无效，请检查后重试';
    case 402: return 'API 余额不足，请充值后重试';
    case 429: return '请求太频繁，请稍后重试';
    default: return `请求失败 (${status})`;
  }
}

async function handleAPI(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  // Read body
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    res.writeHead(400, cors());
    res.end(JSON.stringify({ error: '请求格式错误' }));
    return;
  }

  const { prompt, target } = body;
  if (!prompt?.trim()) return send(res, 400, { error: '请提供需要优化的提示词' });
  if (prompt.length > 5000) return send(res, 400, { error: '提示词不能超过5000字' });
  if (!target?.apiKey) return send(res, 400, { error: '请先设置 API Key' });

  const endpoint = target.endpoint || 'https://api.deepseek.com/v1/chat/completions';
  const model = target.model || 'deepseek-chat';

  try {
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${target.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        temperature: 0.4,
        max_tokens: 2048,
      }),
      signal: AbortSignal.timeout(25000),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error('Upstream error:', upstream.status, errText.slice(0, 300));
      return send(res, upstream.status, { error: mapError(upstream.status) });
    }

    const data = await upstream.json();
    const optimized = data.choices?.[0]?.message?.content ?? '';

    if (!optimized.trim()) {
      return send(res, 500, { error: 'AI 返回了空内容，请尝试重新生成' });
    }

    send(res, 200, { optimized });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return send(res, 504, { error: 'AI 接口响应超时，请稍后重试' });
    }
    console.error('Optimize error:', e);
    send(res, 500, { error: '优化失败，请稍后重试' });
  }
}

function cors() {
  return { 'Access-Control-Allow-Origin': '*' };
}

function send(res, status, data) {
  res.writeHead(status, { ...cors(), 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function handleStatic(req, res) {
  let path = req.url.split('?')[0];
  if (path === '/') path = '/index.html';

  const filePath = join(__dirname, path);

  // Prevent directory traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': mime });
    const stream = createReadStream(filePath);
    stream.pipe(res);
    stream.on('error', () => {
      res.writeHead(500);
      res.end('Error reading file');
    });
  } catch {
    // Try adding .html for clean URLs
    const htmlPath = join(__dirname, path + '.html');
    try {
      const info = await stat(htmlPath);
      if (info.isFile()) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        const stream = createReadStream(htmlPath);
        stream.pipe(res);
        stream.on('error', () => { res.end(); });
        return;
      }
    } catch {}

    res.writeHead(404);
    res.end('Not found');
  }
}

const server = createServer(async (req, res) => {
  if (req.url.startsWith('/api/optimize')) {
    return handleAPI(req, res);
  }
  return handleStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`\n  ✨ 开发服务器已启动: http://localhost:${PORT}`);
  console.log(`  📄 提示词优化器: http://localhost:${PORT}/prompt-optimizer\n`);
});
