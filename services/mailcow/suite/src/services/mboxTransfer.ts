import { withImap, type MailServerCredentials } from './mailClient.js';
import { formatMboxMessage, InvalidMboxError, mboxMaxBytes, mboxMaxMessages, type MboxMessage } from '../../../src/mbox.ts';

function folderTooLarge(): InvalidMboxError {
  return new InvalidMboxError('Mappen overskrider MBOX-grænsen på 20 MiB eller 10.000 mails.');
}

export async function exportMbox(creds: MailServerCredentials, folder: string): Promise<Buffer> {
  return withImap(creds, async (client) => {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      if (!client.mailbox || !client.mailbox.exists) return Buffer.alloc(0);
      if (client.mailbox.exists > mboxMaxMessages) throw folderTooLarge();

      const uids: number[] = [];
      let sourceBytes = 0;
      for await (const item of client.fetch('1:*', { uid: true, size: true })) {
        sourceBytes += item.size ?? 0;
        if (sourceBytes > mboxMaxBytes || uids.length >= mboxMaxMessages) throw folderTooLarge();
        uids.push(item.uid);
      }
      if (!uids.length) return Buffer.alloc(0);

      const entries: Buffer[] = [];
      let bytes = 0;
      for await (const item of client.fetch(uids, { source: true, internalDate: true }, { uid: true })) {
        if (!item.source) throw new Error('IMAP returnerede en mail uden indhold.');
        const entry = formatMboxMessage(item.source, item.internalDate || undefined);
        bytes += entry.length;
        if (bytes > mboxMaxBytes) throw folderTooLarge();
        entries.push(entry);
      }
      if (entries.length !== uids.length) {
        throw new Error('Mappen blev ændret under eksport. Prøv igen.');
      }
      return Buffer.concat(entries, bytes);
    } finally {
      lock.release();
    }
  });
}

export async function importMbox(
  creds: MailServerCredentials,
  folder: string,
  messages: MboxMessage[],
  signal: AbortSignal
): Promise<number> {
  return withImap(creds, async (client) => {
    let imported = 0;
    for (const message of messages) {
      if (signal.aborted) break;
      try {
        if (!await client.append(folder, message.source, [], message.receivedAt)) break;
        imported++;
      } catch {
        break;
      }
    }
    return imported;
  });
}
