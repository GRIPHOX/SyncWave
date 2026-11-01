// @electron/rebuild names the @discordjs/opus output folder with a literal
// "{libc_version}" on Windows, so node-pre-gyp can't find it at runtime.
// The binary is N-API (ABI-stable), so we just give the folder the name
// node-pre-gyp expects for the installed Electron version.
const fs = require('fs');
const path = require('path');

const prebuild = path.join(__dirname, '..', 'node_modules', '@discordjs', 'opus', 'prebuild');
const electronVersion = require('electron/package.json').version.split('.').slice(0, 2).join('.');
const wanted = `electron-v${electronVersion}-napi-v3-win32-x64-unknown-unknown`;

if (!fs.existsSync(prebuild)) {
  console.log('[fix-opus] no prebuild folder; opusscript fallback will be used');
  process.exit(0);
}
const dirs = fs.readdirSync(prebuild).filter((d) => fs.existsSync(path.join(prebuild, d, 'opus.node')));
if (dirs.includes(wanted)) {
  console.log(`[fix-opus] ${wanted} ok`);
  process.exit(0);
}
const source = dirs.find((d) => d.startsWith(`electron-v${electronVersion}-`)) ?? dirs.find((d) => d.includes('napi-v3'));
if (!source) {
  console.log('[fix-opus] no opus.node found; opusscript fallback will be used');
  process.exit(0);
}
fs.cpSync(path.join(prebuild, source), path.join(prebuild, wanted), { recursive: true });
console.log(`[fix-opus] copied ${source} -> ${wanted}`);
