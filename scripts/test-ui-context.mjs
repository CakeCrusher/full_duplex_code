import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Harness } from '../src/server.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-ui-context-'));
const harness = await new Harness({ root, runDir: dir, cwd: dir, sessionId: randomUUID(), apiKey: 'unused-ui-test-key' }).start();
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(harness.browserUrl);
  await page.waitForFunction(() => document.querySelector('#connection').textContent.includes('Waiting'));
  harness.observer.input('Typed terminal context is visible');
  await page.getByText('Input to Claude Code', { exact: true }).waitFor();
  await page.getByText('Typed terminal context is visible', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('Typed terminal context is visible', { exact: true }).waitFor();
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Browser activity and history reload passed; no paid voice session opened.');
} finally { await browser?.close(); await harness.close(); fs.rmSync(dir, { recursive: true, force: true }); }
