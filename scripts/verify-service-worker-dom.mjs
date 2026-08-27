import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

/**
 * Regression check for MV3 service-worker registration.
 *
 * A service worker has no DOM. Vite's module-preload polyfill is a browser-page
 * bootstrap that touches document at module evaluation time, so any statically
 * imported copy in the worker dependency graph makes registration fail with
 * "document is not defined" (Edge status code 15).
 */

const browser = process.argv[2] || 'edge';
const outputTarget = browser === 'firefox' ? 'firefox-mv2' : `${browser}-mv3`;
const outputRoot = path.resolve(process.cwd(), `.output/${outputTarget}`);
const entry = path.join(outputRoot, 'background.js');

if (!fs.existsSync(entry)) {
  throw new Error(`Missing ${entry}. Build the ${browser} target before running this check.`);
}

const staticImportPattern = /\bimport\s*(?:[^'"`]*?from\s*)?['"]([^'"]+)['"]/g;
const visited = new Set();
const domPolyfillModules = [];

const resolveImport = (fromFile, specifier) => {
  if (!specifier.startsWith('.')) return null;
  const candidate = path.resolve(path.dirname(fromFile), specifier);
  if (fs.existsSync(candidate)) return candidate;
  if (fs.existsSync(`${candidate}.js`)) return `${candidate}.js`;
  return null;
};

const visit = (file) => {
  const resolved = path.resolve(file);
  if (visited.has(resolved)) return;
  visited.add(resolved);

  const source = fs.readFileSync(resolved, 'utf8');
  // This is the top-level signature emitted by Vite's module-preload polyfill.
  if (/\(function\(\)\{\s*let\s+[A-Za-z_$][\w$]*\s*=\s*document\.createElement\(\s*[`'"]link[`'"]\s*\)\.relList/.test(source)) {
    domPolyfillModules.push(path.relative(process.cwd(), resolved));
  }

  staticImportPattern.lastIndex = 0;
  for (const match of source.matchAll(staticImportPattern)) {
    const dependency = resolveImport(resolved, match[1]);
    if (dependency) visit(dependency);
  }
};

visit(entry);

if (domPolyfillModules.length > 0) {
  throw new Error([
    'Service-worker dependency graph contains a DOM-only modulepreload polyfill.',
    'This reproduces Edge/Chrome registration failure: document is not defined (status code 15).',
    ...domPolyfillModules.map((file) => `- ${file}`),
  ].join('\n'));
}

const createEventTargetMock = () => ({
  addListener() {},
  removeListener() {},
});

/**
 * Evaluate the emitted worker in a DOM-less VM. This catches a top-level DOM
 * access that a text scan could miss while keeping browser data completely
 * synthetic and avoiding any real API or bookmark calls.
 */
const browserApi = {
  runtime: {
    id: 'marksvault-dom-smoke',
    onInstalled: createEventTargetMock(),
    onStartup: createEventTargetMock(),
    onMessage: createEventTargetMock(),
    getManifest: () => ({ version: '0.0.0-dom-smoke' }),
    getURL: () => 'extension://marksvault-dom-smoke/',
  },
  bookmarks: {
    onCreated: createEventTargetMock(),
    onRemoved: createEventTargetMock(),
    onChanged: createEventTargetMock(),
    onMoved: createEventTargetMock(),
  },
  alarms: {
    onAlarm: createEventTargetMock(),
    create: async () => undefined,
  },
  storage: {
    local: { get: async () => ({}), set: async () => undefined, remove: async () => undefined },
    sync: { get: async () => ({}), set: async () => undefined, remove: async () => undefined },
  },
};

const context = vm.createContext({
  AbortController,
  Blob,
  DOMException,
  Headers,
  Promise,
  Response,
  Request,
  TextDecoder,
  TextEncoder,
  URL,
  URLSearchParams,
  browser: browserApi,
  chrome: browserApi,
  clearTimeout,
  console,
  crypto: globalThis.crypto,
  fetch: async () => { throw new Error('DOM smoke fetch must not be called'); },
  setTimeout,
  structuredClone,
});

const moduleCache = new Map();
const loadModule = async (file) => {
  const resolved = path.resolve(file);
  if (moduleCache.has(resolved)) return moduleCache.get(resolved);
  const module = new vm.SourceTextModule(fs.readFileSync(resolved, 'utf8'), {
    context,
    identifier: resolved,
    initializeImportMeta(meta) {
      meta.url = pathToFileURL(resolved).href;
    },
    importModuleDynamically: async (specifier, referencingModule) => {
      const dependency = resolveImport(referencingModule.identifier, specifier);
      if (!dependency) throw new Error(`Unexpected dynamic import in smoke test: ${specifier}`);
      const child = await loadModule(dependency);
      if (child.status === 'unlinked') await child.link(linker);
      if (child.status !== 'evaluated') await child.evaluate();
      return child;
    },
  });
  moduleCache.set(resolved, module);
  return module;
};

const linker = async (specifier, referencingModule) => {
  const dependency = resolveImport(referencingModule.identifier, specifier);
  if (!dependency) throw new Error(`Unexpected external import in smoke test: ${specifier}`);
  return loadModule(dependency);
};

const rootModule = await loadModule(entry);
await rootModule.link(linker);
await rootModule.evaluate();

console.log(`PASS: ${browser} background dependency graph evaluates without document in a DOM-less worker.`);
