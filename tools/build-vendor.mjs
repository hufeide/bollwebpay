// 把 qrcode / crypto-js 打包成浏览器可用的独立全局脚本(public/vendor/*.js)
// 这样部署后无需从 CDN 加载, 也无需前端打包工具。
import { build } from 'esbuild';
import { mkdirSync } from 'fs';

mkdirSync('public/vendor', { recursive: true });

const targets = [
  { entry: 'tools/qrcode.entry.js', out: 'public/vendor/qrcode.js', name: 'QRCode' },
  { entry: 'tools/crypto.entry.js', out: 'public/vendor/crypto-js.js', name: 'CryptoJS' },
];

for (const t of targets) {
  await build({
    entryPoints: [t.entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2018',
    outfile: t.out,
    minify: true,
    legalComments: 'none',
  });
  console.log('built', t.out);
}
