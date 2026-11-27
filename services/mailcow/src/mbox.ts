const messageHeader = /^[!-9;-~]+:[^\r\n]*\r?\n/;
const separatorLine = /^From \S+ ((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2}(?: [^\r\n ]+)* \d{4}(?: [^\r\n]*)?)\r?\n/gm;

export const mboxMaxBytes = 20 * 1024 * 1024;
export const mboxMaxMessages = 10_000;
export const mboxType = 'application/mbox';

export class InvalidMboxError extends Error {}

export interface MboxMessage {
  source: Buffer;
  receivedAt?: Date;
}

export function parseMbox(data: Buffer): MboxMessage[] {
  if (data.length > mboxMaxBytes) throw new InvalidMboxError('MBOX-filen må højst fylde 20 MiB.');

  // Latin-1 gives each byte a single code unit, including MIME attachments and legacy mail encodings.
  const source = data.toString('latin1');
  const messages: MboxMessage[] = [];
  let messageStart: number | undefined;
  let receivedAt: Date | undefined;
  for (const separator of source.matchAll(separatorLine)) {
    if (messageStart === undefined && separator.index !== 0) break;
    if (messageStart !== undefined) appendMessage(messages, source.slice(messageStart, separator.index), receivedAt);
    messageStart = separator.index + separator[0].length;
    receivedAt = parseEnvelopeDate(separator[1]);
  }
  if (messageStart === undefined) throw new InvalidMboxError('Vælg en MBOX-fil med mindst én mail.');

  appendMessage(messages, source.slice(messageStart), receivedAt);
  return messages;
}

function parseEnvelopeDate(value: string): Date | undefined {
  const zoned = /(?:\b[A-Z]{2,5}\b|[+-]\d{4})/.test(value);
  const date = new Date(zoned ? value : value + ' UTC');
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function appendMessage(messages: MboxMessage[], entry: string, receivedAt?: Date) {
  if (messages.length >= mboxMaxMessages) throw new InvalidMboxError('MBOX-filen må højst indeholde 10.000 mails.');
  if (!messageHeader.test(entry.slice(0, 4096))) {
    throw new InvalidMboxError(`Mail nr. ${messages.length + 1} mangler en gyldig mailheader.`);
  }

  const unquoted = entry.replace(/^>(?=>*From )/gm, '');
  // Remove the blank separator line while retaining the message's final line ending.
  const source = Buffer.from(unquoted.replace(/(\r?\n)\r?\n$/, '$1'), 'latin1');
  messages.push({ source, receivedAt });
}

export function formatMboxMessage(message: Buffer, receivedAt?: Date | string): Buffer {
  const parsed = receivedAt === undefined ? new Date(0) : new Date(receivedAt);
  const date = Number.isFinite(parsed.getTime()) ? parsed : new Date(0);
  const [weekday, day, month, year, time] = date.toUTCString().replace(',', '').split(' ');
  const separator = `From MAILER-DAEMON ${weekday} ${month} ${String(Number(day)).padStart(2, ' ')} ${time} ${year}\n`;
  const escaped = message.toString('latin1').replace(/^(?=>*From )/gm, '>');
  return Buffer.from(separator + escaped + (escaped.endsWith('\n') ? '\n' : '\n\n'), 'latin1');
}
