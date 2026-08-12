// faham · Neon HTTP → 普通 Postgres 网关（只在本地开发用）
//
// functions/_lib.js 对 Neon 的 HTTP 端点发这样的请求：
//     POST /sql
//     Neon-Connection-String: postgresql://…
//     Neon-Raw-Text-Output: true
//     {"query": "select …", "params": [...]}
// 回：{"rows":[…], "fields":[…], "rowCount":n, "command":"SELECT"}
// 错：非 2xx + {"message","code","constraint"}
//
// 这个文件就负责把上面那套翻译成 pg 的查询，好让应用代码在本地与线上
// 跑的是同一段逻辑——本地改一套、线上跑另一套，等于没测。
//
// 关键细节：Neon-Raw-Text-Output 表示所有值都以「Postgres 的文本形式」返回，
// 不做 JS 类型转换。这不是小事——
//   · 时间戳必须是 "2026-08-01 16:41:02.599023+00"，不是 JS Date 的 toString，
//     否则前端 new Date() 解析出来是 Invalid Date；
//   · int8/count 必须是字符串 "0"；
//   · text[] 必须是 "{a,b}"，因为复核页就是按这个格式解析的。
// 所以下面给每个查询挂了一个恒等 type parser，让 pg 原样吐出文本。

import http from 'node:http';
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.PGHOST, port: +(process.env.PGPORT || 5432),
  user: process.env.PGUSER, password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE, max: 8,
});

// 恒等解析器：拿到什么文本就回什么文本，与 Neon-Raw-Text-Output 对齐
const RAW = { getTypeParser: () => (v) => v };

const send = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
};

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return pool.query('select 1')
      .then(() => send(res, 200, { ok: true }))
      .catch(e => send(res, 503, { ok: false, message: e.message }));
  }
  if (req.method !== 'POST' || !req.url.startsWith('/sql')) {
    return send(res, 404, { message: 'not found' });
  }

  let raw = '';
  req.on('data', c => {
    raw += c;
    if (raw.length > 1_000_000) { req.destroy(); }
  });
  req.on('end', async () => {
    let body;
    try { body = JSON.parse(raw || '{}'); }
    catch { return send(res, 400, { message: 'bad json' }); }

    const { query, params = [] } = body;
    if (typeof query !== 'string' || !query.trim()) {
      return send(res, 400, { message: 'missing query' });
    }

    try {
      const r = await pool.query({ text: query, values: params, types: RAW });
      send(res, 200, {
        command: r.command,
        rowCount: r.rowCount,
        rows: r.rows,
        fields: (r.fields || []).map(f => ({
          name: f.name, dataTypeID: f.dataTypeID, tableID: f.tableID,
          columnID: f.columnID, dataTypeSize: f.dataTypeSize,
          dataTypeModifier: f.dataTypeModifier, format: 'text',
        })),
        rowAsArray: false,
      });
    } catch (e) {
      // 形状对齐 Neon：_lib.js 的 friendly() 靠 message 里的关键字翻译成人话，
      // 约束名与 RAISE 的文本都必须原样带出来，否则本地看到的报错跟线上不一样。
      send(res, 400, {
        message: e.message,
        code: e.code,
        constraint: e.constraint,
        detail: e.detail,
        severity: e.severity,
      });
    }
  });
});

server.listen(+(process.env.PORT || 8080), '0.0.0.0', () => {
  console.log(`sqlgate listening on ${process.env.PORT || 8080} → ` +
              `${process.env.PGHOST}:${process.env.PGPORT}/${process.env.PGDATABASE}`);
});
