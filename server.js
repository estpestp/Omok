const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const INDEX = path.join(__dirname, 'index.html');

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 40000) {
        reject(new Error('요청 데이터가 너무 커.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch { reject(new Error('요청 형식이 올바르지 않아.')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try { return send(res, 200, fs.readFileSync(INDEX, 'utf8'), 'text/html; charset=utf-8'); }
    catch { return send(res, 500, '페이지 파일을 읽지 못했어.', 'text/plain; charset=utf-8'); }
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, groqConfigured: Boolean(API_KEY) });
  }

  if (req.method === 'POST' && url.pathname === '/api/explain') {
    if (!API_KEY) return send(res, 503, { error: 'Groq API 키가 아직 설정되지 않았어. Render 환경 변수에 GROK_API_KEY를 추가해 줘.' });
    let body;
    try { body = await readJson(req); }
    catch (err) { return send(res, 400, { error: err.message }); }

    const history = body.history;
    const selectedIndex = Number(body.selectedIndex);
    if (!Array.isArray(history) || history.length < 1 || history.length > 81 ||
        !Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= history.length) {
      return send(res, 400, { error: '착수 기록이 올바르지 않아.' });
    }
    const valid = history.every((m, i) =>
      m && m.move === i + 1 && (m.color === '흑' || m.color === '백') &&
      typeof m.coordinate === 'string' && /^[A-I][1-9]$/.test(m.coordinate));
    if (!valid) return send(res, 400, { error: '착수 기록에 잘못된 좌표가 있어.' });

    const chosen = history[selectedIndex];
    const movesText = history.map(m => `${m.move}. ${m.color} ${m.coordinate}`).join('\n');
    const prompt = [
      '너는 한국어로 설명하는 친절한 오목 코치야.',
      '판은 9x9이며 열은 A-I, 행은 1-9야. 흑이 먼저 두고, 다섯 개 이상 연결하면 승리해. 금수 규칙은 없어.',
      '아래 착수 기록 순서대로 판을 복원하고, 지정한 착수가 놓인 바로 그 시점의 전략적 이유를 설명해.',
      '한국어로 초보 학생도 이해할 수 있게 답해. 설명은 기록으로 뒷받침되는 내용만 말하고, 불확실한 의도는 가능성이라고 표현해. 수를 실제로 두는 플레이어의 생각을 안다고 단정하지 마.',
      '아래 형식으로 간결하게 답해:',
      '• 이 수의 핵심 의도',
      '• 주변 돌과 연결되는 점',
      '• 상대가 다음에 노릴 수 있는 것',
      '• 이어서 생각해 볼 후보 수 1~2개와 이유',
      '• 한 줄 요약',
      '수업용 해설이며 절대적인 최선수 보장은 아니라고 필요하면 밝혀.',
      '',
      '착수 기록:',
      movesText,
      '',
      `분석할 착수: ${chosen.move}수, ${chosen.color} ${chosen.coordinate}`
    ].join('\n');

    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: 'system', content: 'You are a careful Gomoku teaching assistant. Explain board strategy in Korean, grounded in the provided move sequence.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.35,
          max_tokens: 700
        }),
        signal: AbortSignal.timeout(45000)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = data?.error?.message || data?.message || 'Groq API 요청이 실패했어.';
        const status = response.status === 401 || response.status === 403 ? 502 : response.status === 429 ? 429 : 502;
        console.error('Groq API error:', response.status, message);
        return send(res, status, { error: response.status === 401 || response.status === 403
          ? 'Groq API 인증에 실패했어. Render의 GROK_API_KEY를 확인해 줘.'
          : response.status === 429
            ? 'Groq API 사용 한도에 도달했어. 잠시 후 다시 시도해 줘.'
            : 'Groq API에서 응답을 받지 못했어. Render 로그를 확인해 줘.' });
      }
      const explanation = data?.choices?.[0]?.message?.content;
      if (typeof explanation !== 'string' || !explanation.trim()) {
        return send(res, 502, { error: 'Groq이 설명을 반환하지 않았어. 모델 설정을 확인해 줘.' });
      }
      return send(res, 200, { explanation: explanation.trim(), model: MODEL });
    } catch (err) {
      console.error('Groq request failed:', err.message);
      return send(res, 502, { error: err.name === 'TimeoutError' ? 'Groq 응답이 오래 걸려서 중단했어. 다시 시도해 줘.' : 'Groq에 연결하지 못했어. 네트워크와 API 설정을 확인해 줘.' });
    }
  }

  return send(res, 404, { error: '찾을 수 없는 주소야.' });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Omok server listening on ${PORT}; Groq key configured: ${Boolean(API_KEY)}`));
