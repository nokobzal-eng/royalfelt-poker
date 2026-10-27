// Bundles the client and the shared engine into one self-contained HTML file
// that runs fully offline (you vs. the bots). Output: dist/demo.html
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let html = read('public/index.html');
html = html.replace('<link rel="stylesheet" href="style.css">', () => `<style>\n${read('public/style.css')}\n</style>`);
html = html.replace(/<script src="\/socket.io\/socket.io.js"[^>]*><\/script>\n/, '');
for (const f of ['shared/engine.js', 'shared/bot.js', 'shared/lobby.js', 'public/fx.js', 'public/app.js']) {
  const tag = f.startsWith('shared') ? `<script src="/${f}"></script>` : `<script src="${f.slice(7)}"></script>`;
  html = html.replace(tag, () => `<script>\n${read(f)}\n</script>`);
}
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/demo.html'), html);
// Artifact flavour: the host supplies the document skeleton, so keep only title, styles and body.
const art = html
  .replace(/^[\s\S]*?<head>/, '')
  .replace(/<meta charset[^>]*>\n|<meta name="viewport"[^>]*>\n/g, '')
  .replace('</head>\n<body>', '')
  .replace(/<\/body>\s*<\/html>\s*$/, '');
fs.writeFileSync(path.join(root, 'dist/artifact.html'), art);
console.log('dist/demo.html', (html.length / 1024).toFixed(0) + ' KB');
