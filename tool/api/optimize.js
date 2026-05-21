/**
 * Vercel serverless function — AI Prompt Optimizer API proxy
 *
 * POST /api/optimize
 * Body: { prompt: string, target: { endpoint, apiKey, model } }
 *
 * Proxies to any OpenAI-compatible chat completions endpoint.
 * The optimization system prompt is server-side so users can't see/modify it.
 */

const MAX_BODY_SIZE = 50 * 1024;      // 50KB
const MAX_PROMPT_LENGTH = 5000;       // generous buffer above client-side 2000
const UPSTREAM_TIMEOUT_MS = 25000;    // 25s, below Vercel's 30s limit

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

export default async function handler(req, res) {
  // CORS — restrict to common origins; adjust if you have a fixed domain
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const origin = req.headers.origin || '';
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Body size guard
  const bodyStr = JSON.stringify(req.body || {});
  if (bodyStr.length > MAX_BODY_SIZE) {
    return res.status(413).json({ error: '请求内容过大，请精简提示词后重试' });
  }

  try {
    const { prompt, target } = req.body;

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: '请提供需要优化的提示词' });
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
      return res.status(400).json({ error: `提示词不能超过 ${MAX_PROMPT_LENGTH} 字` });
    }
    if (!target?.apiKey) {
      return res.status(400).json({ error: '请先设置 API Key' });
    }

    const endpoint = target.endpoint || 'https://api.deepseek.com/v1/chat/completions';
    const model = target.model || 'deepseek-chat';

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${target.apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ],
        temperature: 0.4,
        max_tokens: 2048
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Upstream error:', response.status, errText.slice(0, 500));
      return res.status(response.status).json({
        error: mapError(response.status, errText)
      });
    }

    const data = await response.json();
    const optimized = data.choices?.[0]?.message?.content ?? '';

    if (!optimized.trim()) {
      return res.status(500).json({ error: 'AI 返回了空内容，请尝试重新生成' });
    }

    return res.status(200).json({ optimized });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return res.status(504).json({ error: 'AI 接口响应超时，请稍后重试' });
    }
    console.error('Optimize error:', e);
    return res.status(500).json({ error: '优化失败，请稍后重试' });
  }
}

function mapError(status, body) {
  switch (status) {
    case 401: return 'API Key 无效，请检查后重试';
    case 402: return 'API 余额不足，请充值后重试';
    case 429: return '请求太频繁，请稍后重试';
    case 400: {
      try {
        const j = JSON.parse(body);
        return j.error?.message || '请求参数错误';
      } catch { return '请求参数错误'; }
    }
    default: return `请求失败 (${status})`;
  }
}
