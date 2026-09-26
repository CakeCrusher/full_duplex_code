import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import type { AgentProfile } from './adapter.ts';

// The page's modules are TypeScript in web/, served as JavaScript.
const MODULES = ['app', 'audio-io', 'bridge-client', 'page-ui', 'webrtc-peer', 'profile', 'timeline', 'cues', 'audio-worklet'];
export const PAGE_FILES: Readonly<Record<string, [file: string, type: string]>> = {
  '/': ['index.html', 'text/html'], '/icon.svg': ['icon.svg', 'image/svg+xml'], '/style.css': ['style.css', 'text/css'],
  ...Object.fromEntries(MODULES.map(name => [`/${name}.js`, [`${name}.ts`, 'text/javascript']])),
};

const escape = (text: string) => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const capitalized = (text: string) => text[0].toUpperCase() + text.slice(1);

// The agent's wording for the page: {{name}} and similar placeholders in
// index.html, and the profile itself for the page's modules.
export function renderPage(template: string, profile: AgentProfile): string {
  const words: Record<string, string> = { ...profile as unknown as Record<string, string>, Transport: capitalized(profile.transport), Wire: capitalized(profile.wire), profile: JSON.stringify(profile) };
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => Object.hasOwn(words, key) ? escape(String(words[key])) : match);
}

export function stripTypes(code: string): string {
  // Node reports this API as experimental once per process; keep that notice
  // out of the terminal the agent is drawing in.
  const emitWarning = process.emitWarning;
  process.emitWarning = (() => {}) as typeof process.emitWarning;
  try { return stripTypeScriptTypes(code, { mode: 'strip' }); } finally { process.emitWarning = emitWarning; }
}

/** A page file as served, read from disk on each request. */
export function pageFile(root: string, url: string, profile: AgentProfile): { body: string | Buffer; type: string } | undefined {
  if (!Object.hasOwn(PAGE_FILES, url)) return undefined;
  const [name, type] = PAGE_FILES[url];
  const file = path.join(root, 'web', name);
  if (name === 'index.html') return { body: renderPage(fs.readFileSync(file, 'utf8'), profile), type };
  if (name.endsWith('.ts')) return { body: stripTypes(fs.readFileSync(file, 'utf8')), type };
  return { body: fs.readFileSync(file), type };
}
