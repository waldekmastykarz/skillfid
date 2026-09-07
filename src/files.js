import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { stableStringify } from './json.js';

export async function readJson(filePath) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); }
  catch (error) { throw new Error(`Could not read ${filePath}: ${error.message}`); }
}

export async function readJsonl(filePath) {
  try {
    return (await readFile(filePath, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) { throw new Error(`Could not read ${filePath}: ${error.message}`); }
}

export async function writeJson(filePath, value) {
  await writeFile(filePath, `${stableStringify(value, 2)}\n`, 'utf8');
}

export async function writeJsonl(filePath, values) {
  await writeFile(filePath, values.map((value) => stableStringify(value)).join('\n') + (values.length ? '\n' : ''), 'utf8');
}

export async function copyDirectory(source, destination) {
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
}

export async function hashDirectory(root) {
  const digest = createHash('sha256');
  for (const filePath of await allFiles(root)) {
    digest.update(path.relative(root, filePath).split(path.sep).join('/'), 'utf8');
    digest.update('\0');
    digest.update(await readFile(filePath));
    digest.update('\0');
  }
  return digest.digest('hex');
}

export async function replaceDirectory(staging, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await rename(staging, destination);
}

export { mkdir, rm };

async function allFiles(root) {
  const files = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await allFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}