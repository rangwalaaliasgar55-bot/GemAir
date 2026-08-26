#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const htmlPath = path.join(__dirname, '..', 'renderer', 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
if (html.includes('stonic-skin.css')) {
  console.log('stonic-skin already linked');
  process.exit(0);
}
const link = '  <link rel="stylesheet" href="stonic-skin.css" />\n';
if (html.includes('style.css')) {
  html = html.replace(/(href="style\.css"[^>]*>)/, '$1\n' + link.trim());
} else {
  html = html.replace('</head>', link + '</head>');
}
fs.writeFileSync(htmlPath, html);
console.log('stonic-skin.css linked in index.html');
