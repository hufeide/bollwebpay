/**
 * kv-local.js — 本地文件版 KV, 接口对齐 Cloudflare KV 在 store.js 里的用法:
 *   - get(key, 'json')  → 解析后的对象 / null
 *   - put(key, string)  → 持久化(这里存到 .data/kv.json)
 *
 * 这样 store.js / x402.js 不用改一行, 即可在 Node 本地跑(无需 Cloudflare 账号/ wrangler)。
 */

import fs from 'node:fs';
import path from 'node:path';

export function createLocalKV(file) {
  const dir = path.dirname(file);
  let map = {};
  try {
    map = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    map = {};
  }

  function persist() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(map, null, 2));
    } catch (e) {
      console.error('[kv-local] persist failed:', e.message);
    }
  }

  return {
    async get(key, type = 'text') {
      const v = map[key];
      if (v === undefined || v === null) return null;
      if (type === 'json') {
        try { return JSON.parse(v); } catch { return null; }
      }
      return v;
    },
    async put(key, value) {
      // store.js 总是传已经 stringify 过的字符串; 这里原样存
      map[key] = value;
      persist();
      return undefined;
    },
  };
}
