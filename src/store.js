// Persistent record of requests we have already messaged (secondary duplicate
// guard — the primary guard is the in-chat scan, chatAlreadySent). If DATA_DIR
// is ephemeral (no Railway Volume) the store resets on restart and the in-chat
// scan still prevents double-sends.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';

const FILE = path.join(config.dataDir, 'sent.json');

async function ensureDir() {
  await fs.mkdir(config.dataDir, { recursive: true });
}

export async function loadSent() {
  try {
    return new Map(Object.entries(JSON.parse(await fs.readFile(FILE, 'utf8'))));
  } catch {
    return new Map();
  }
}

export async function markSent(bookingId, meta = {}) {
  try {
    await ensureDir();
    const sent = await loadSent();
    sent.set(String(bookingId), { at: new Date().toISOString(), ...meta });
    await fs.writeFile(FILE, JSON.stringify(Object.fromEntries(sent), null, 2), 'utf8');
  } catch (err) {
    log.warn('Could not persist sent-store (continuing):', err.message);
  }
}

export async function wasSent(bookingId) {
  return (await loadSent()).has(String(bookingId));
}
