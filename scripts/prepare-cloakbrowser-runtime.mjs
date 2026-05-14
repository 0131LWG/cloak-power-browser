import {createHash} from 'crypto';
import {createReadStream, existsSync, mkdirSync, rmSync} from 'fs';
import {cp, readFile, readdir, stat} from 'fs/promises';
import path from 'path';
import {fileURLToPath} from 'url';
import {execFileSync} from 'child_process';
import extract from 'extract-zip';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(rootDir, 'cloakbrowser.runtime.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

const args = Object.fromEntries(
  process.argv.slice(2).map(item => {
    const [key, ...rest] = item.replace(/^--/, '').split('=');
    return [key, rest.join('=') || true];
  }),
);

const platformKey = String(args.platform || `${process.platform}-${process.arch}`);
const archivePath = args.archive ? path.resolve(String(args.archive)) : '';
const platformRuntimes = manifest.platforms[platformKey];
const runtimes = Array.isArray(platformRuntimes) ? platformRuntimes : platformRuntimes ? [platformRuntimes] : [];
const runtimeConfig =
  runtimes.find(item => item.tag === args.version || item.tag === args.tag) ||
  runtimes.find(item => item.recommended) ||
  runtimes[0];

if (!runtimeConfig) {
  fail(`Unsupported platform "${platformKey}". Known platforms: ${Object.keys(manifest.platforms).join(', ')}`);
}

if (!archivePath || !existsSync(archivePath)) {
  fail(`Archive is required. Example: npm run cloak:prepare -- --platform=${platformKey} --archive=/path/to/${runtimeConfig.asset}`);
}

const checksum = await sha256File(archivePath);
if (checksum !== runtimeConfig.sha256) {
  fail(`SHA-256 mismatch for ${archivePath}\nexpected: ${runtimeConfig.sha256}\nactual:   ${checksum}`);
}

const vendorDir = path.join(rootDir, 'vendor', 'cloakbrowser');
const platformDir = path.join(vendorDir, platformKey, runtimeConfig.tag);
const extractDir = path.join(vendorDir, '.extract', platformKey);

rmSync(platformDir, {recursive: true, force: true});
rmSync(extractDir, {recursive: true, force: true});
mkdirSync(platformDir, {recursive: true});
mkdirSync(extractDir, {recursive: true});

if (archivePath.endsWith('.zip')) {
  await extract(archivePath, {dir: extractDir});
} else if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
  execFileSync('tar', ['-xzf', archivePath, '-C', extractDir], {stdio: 'inherit'});
} else {
  fail(`Unsupported archive type: ${archivePath}`);
}

const runtimeRoot = await findRuntimeRoot(extractDir, runtimeConfig.executable);
if (!runtimeRoot) {
  fail(`Could not find executable "${runtimeConfig.executable}" inside extracted archive.`);
}

await cp(runtimeRoot, platformDir, {recursive: true});
rmSync(extractDir, {recursive: true, force: true});

console.log(`Prepared CloakBrowser runtime: ${platformKey}`);
console.log(`Source tag: ${runtimeConfig.tag}`);
console.log(`Runtime dir: ${platformDir}`);
console.log(`Executable: ${path.join(platformDir, runtimeConfig.executable)}`);

async function findRuntimeRoot(baseDir, executableRelativePath) {
  const directExecutable = path.join(baseDir, executableRelativePath);
  if (existsSync(directExecutable)) {
    return baseDir;
  }

  const entries = await readdir(baseDir);
  for (const entry of entries) {
    const candidate = path.join(baseDir, entry);
    const info = await stat(candidate);
    if (!info.isDirectory()) {
      continue;
    }
    const executable = path.join(candidate, executableRelativePath);
    if (existsSync(executable)) {
      return candidate;
    }
  }

  return '';
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
