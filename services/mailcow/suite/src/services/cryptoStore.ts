import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { suiteAccountDirectory, suiteProviderDirectory, suiteRoot } from '../sharedrive-context.js';

let cachedSecretKey: Buffer | null = null;

export const getWritableDataDir = suiteAccountDirectory;
export const getProviderDataDir = suiteProviderDirectory;
export const getCandidateDataDirs = () => [suiteAccountDirectory()];
export const getCandidateProviderDirs = () => [suiteProviderDirectory()];

function getSecretKey(): Buffer {
  if (cachedSecretKey) return cachedSecretKey;

  const envSecret = (process.env.SESSION_SECRET || process.env.SHARE_SECRET || '').trim();
  if (envSecret) {
    cachedSecretKey = crypto.createHash('sha256').update(envSecret).digest();
    return cachedSecretKey;
  }

  for (const dir of [suiteRoot()]) {
    for (const filename of ['.suite_secret', '.session_secret', '.share_secret']) {
      const keyFile = path.join(dir, filename);
      try {
        if (fs.existsSync(keyFile)) {
          const hex = fs.readFileSync(keyFile, 'utf8').trim();
          if (hex.length === 64) {
            cachedSecretKey = Buffer.from(hex, 'hex');
            return cachedSecretKey;
          }
        }
      } catch {
        // Ignorér EACCES
      }
    }
  }

  const newKey = crypto.randomBytes(32);
  cachedSecretKey = newKey;
  try {
    const writableKeyFile = path.join(suiteRoot(), '.suite_secret');
    fs.writeFileSync(writableKeyFile, newKey.toString('hex'), { mode: 0o600 });
  } catch {
    // Bevar nøglen i hukommelsen hvis disk-skrivning fejler
  }
  return newKey;
}

export function encryptText(plain: string): string {
  const key = getSecretKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decryptText(payload: string): string {
  const [ivHex, tagHex, encHex] = payload.split(':');
  if (!ivHex || !tagHex || !encHex) {
    throw new Error('Ugyldigt krypteret format');
  }
  const key = getSecretKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
  return dec.toString('utf8');
}

export function encryptJson(obj: unknown): string {
  return encryptText(JSON.stringify(obj));
}

export function decryptJson<T>(token: string): T | null {
  try {
    const json = decryptText(token);
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
