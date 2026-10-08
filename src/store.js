// Persistent record of requests we have already messaged (secondary duplicate
// guard — the primary guard is the in-chat scan, chatAlreadySent). If DATA_DIR
// is ephemeral (no Railway Volume) the store resets on restart; the Sheet
// journal (restored every cycle) and the in-chat scan still prevent
// double-sends.
//
// Every write is ATOMIC (write a temp file, then rename over the old one): a
// container killed mid-write would leave half a JSON file, which loadSent reads
// as "empty" — the next write then replaced the whole history with one entry.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';

const FILE = path.join(config.dataDir, 'sent.json');

async function ensureDir() {
  await fs.mkdir(config.dataDir, { recursive: true });
}

let tmpSeq = 0;
async function writeJsonAtomic(file, obj) {
  await ensureDir();
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.rename(tmp, file);
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
    const sent = await loadSent();
    sent.set(String(bookingId), { at: new Date().toISOString(), ...meta });
    await writeJsonAtomic(FILE, Object.fromEntries(sent));
  } catch (err) {
    log.warn('Could not persist sent-store (continuing):', err.message);
  }
}

export async function wasSent(bookingId) {
  return (await loadSent()).has(String(bookingId));
}
