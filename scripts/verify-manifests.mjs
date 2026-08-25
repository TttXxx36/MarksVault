import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const readManifest = (target) => {
  const file = path.join(root, '.output', target, 'manifest.json');
  if (!fs.existsSync(file)) throw new Error(`缺少构建 Manifest: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};

const chrome = readManifest('chrome-mv3');
const edge = readManifest('edge-mv3');
const firefox = readManifest('firefox-mv2');

for (const [name, manifest] of [['chrome', chrome], ['edge', edge]]) {
  if (manifest.manifest_version !== 3) throw new Error(`${name} 必须使用 Manifest V3`);
  if (!Array.isArray(manifest.optional_host_permissions) || !manifest.optional_host_permissions.includes('https://*/*')) {
    throw new Error(`${name} 缺少 AI 运行时可选 HTTPS origin 权限`);
  }
  if (!Array.isArray(manifest.host_permissions) || !manifest.host_permissions.includes('https://api.github.com/*')) {
    throw new Error(`${name} 缺少 GitHub API host permission`);
  }
}

if (firefox.manifest_version !== 2) throw new Error('Firefox v2 必须保持 Manifest V2 兼容基线');
if (firefox.browser_specific_settings?.gecko?.id !== 'marksvault@tttxxx36.github.io') {
  throw new Error('Firefox 缺少稳定 Gecko Add-on ID');
}
if (!firefox.browser_specific_settings?.gecko?.data_collection_permissions) {
  throw new Error('Firefox 缺少数据收集声明');
}
if (firefox.optional_host_permissions) {
  throw new Error('Firefox MV2 不应声明 Chromium optional_host_permissions');
}

console.log(JSON.stringify({
  chrome: { manifestVersion: chrome.manifest_version, optionalOrigins: chrome.optional_host_permissions?.length ?? 0 },
  edge: { manifestVersion: edge.manifest_version, optionalOrigins: edge.optional_host_permissions?.length ?? 0 },
  firefox: { manifestVersion: firefox.manifest_version, geckoId: firefox.browser_specific_settings.gecko.id },
}, null, 2));
