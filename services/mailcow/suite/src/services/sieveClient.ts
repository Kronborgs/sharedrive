import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import type { MailServerCredentials } from './mailClient.js';
import { suiteContext } from '../sharedrive-context.js';

export interface SieveConditionDTO {
  field: 'from' | 'to' | 'subject' | 'header' | 'size';
  customHeader?: string;
  comparator: 'contains' | 'is' | 'matches' | 'over' | 'under';
  value: string;
}

export interface SieveActionDTO {
  type: 'fileinto' | 'redirect' | 'keep' | 'discard' | 'reject' | 'addflag_seen' | 'addflag_flagged';
  target?: string;
}

export interface SieveRuleDTO {
  id: string;
  name: string;
  enabled: boolean;
  matchType: 'allof' | 'anyof';
  conditions: SieveConditionDTO[];
  actions: SieveActionDTO[];
  stopProcessing: boolean;
}

export interface SieveScriptInfoDTO {
  name: string;
  active: boolean;
}

export interface SieveOverviewDTO {
  supported: boolean;
  host: string;
  port: number;
  scripts: SieveScriptInfoDTO[];
  activeScriptName: string;
  rawScript: string;
  rules: SieveRuleDTO[];
  hasUnparsedCustomBlocks: boolean;
}

interface ManageSieveResponse {
  status: 'OK' | 'NO' | 'BYE';
  code?: string;
  message: string;
  lines: string[];
}

/**
 * Lav-niveau ManageSieve (RFC 5804) klient med STARTTLS og SASL PLAIN autentificering.
 * Kompatibel med Dovecot / Mailcow / Pigeonhole / SOGo på port 4190.
 */
class ManageSieveClient {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private pendingResolve: ((res: ManageSieveResponse) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;

  constructor(
    private host: string,
    private port: number,
    private allowInsecureTls: boolean,
    private serverName: string = host
  ) {}

  async connect(username: string, password: string, clientIp?: string): Promise<void> {
    const rawSocket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`ManageSieve timeout mod ${this.host}:${this.port}`));
      }, 10000);
      s.once('connect', () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    this.attachSocket(rawSocket);
    const greeting = await this.waitForResponse();
    if (greeting.status !== 'OK') {
      throw new Error(`ManageSieve server afviste forbindelse: ${greeting.message}`);
    }

    const supportsStartTls = greeting.lines.some((l) =>
      l.toUpperCase().includes('"STARTTLS"')
    );

    let capabilityLines: string[] = greeting.lines;

    if (!supportsStartTls) {
      rawSocket.destroy();
      throw new Error('ManageSieve kræver STARTTLS.');
    }

    {
      const tlsResp = await this.sendCommand('STARTTLS');
      if (tlsResp.status !== 'OK') {
        throw new Error(`ManageSieve STARTTLS fejlede: ${tlsResp.message}`);
      }

      rawSocket.removeAllListeners('data');
      rawSocket.removeAllListeners('error');
      this.buffer = Buffer.alloc(0);

      const tlsSocket = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const secureSock = tls.connect(
          {
            socket: rawSocket,
            servername: this.serverName,
            rejectUnauthorized: !this.allowInsecureTls
          },
          () => resolve(secureSock)
        );
        secureSock.once('error', reject);
      });

      this.attachSocket(tlsSocket);
      // Dovecot/Pigeonhole sender ofte nye capabilities automatisk efter STARTTLS, eller svarer på CAPABILITY
      // Vi venter kortvarigt på om serveren sender en ny OK greeting efter TLS handshake
      const postTls = await this.waitForResponseWithTimeout(600);
      if (postTls) {
        capabilityLines = postTls.lines;
      } else {
        const capResp = await this.sendCommand('CAPABILITY');
        capabilityLines = capResp.lines;
      }
    }

    // Videregiv brugerens rigtige IP til Dovecot (kræver login_trusted_networks med Suite-serverens IP).
    // Dovecot annoncerer kun XCLIENT for betroede forbindelser, så ellers springes dette over.
    const cleanIp = (clientIp || '').trim().replace(/^::ffff:/i, '');
    const supportsXclient = capabilityLines.some((l) => l.toUpperCase().includes('"XCLIENT"'));
    if (cleanIp && net.isIP(cleanIp) !== 0 && supportsXclient) {
      try {
        await this.sendCommand(`XCLIENT ADDR=${cleanIp}`);
      } catch {
        // Ignorér – login fortsætter med serverens egen IP
      }
    }

    // SASL PLAIN: base64(\0username\0password)
    const authPayload = Buffer.from(`\u0000${username}\u0000${password}`, 'utf8').toString('base64');
    const gate = suiteContext.getStore()?.authGate;
    const authenticate = async () => {
      const response = await this.sendCommand(`AUTHENTICATE "PLAIN" "${authPayload}"`);
      if (gate && response.status === 'NO') gate.blocked = true;
      return response;
    };
    const authResp = await (gate ? gate.run(authenticate) : authenticate());
    if (authResp.status !== 'OK') {
      throw new Error(`ManageSieve login afvist: ${authResp.message}`);
    }
  }

  private attachSocket(sock: net.Socket | tls.TLSSocket) {
    this.socket = sock;
    sock.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.tryParseBuffer();
    });
    sock.on('error', (err: Error) => {
      if (this.pendingReject) {
        const rej = this.pendingReject;
        this.pendingResolve = null;
        this.pendingReject = null;
        rej(err);
      }
    });
  }

  private waitForResponse(): Promise<ManageSieveResponse> {
    return new Promise<ManageSieveResponse>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
      this.tryParseBuffer();
    });
  }

  private waitForResponseWithTimeout(ms: number): Promise<ManageSieveResponse | null> {
    return new Promise<ManageSieveResponse | null>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingResolve) {
          this.pendingResolve = null;
          this.pendingReject = null;
        }
        resolve(null);
      }, ms);

      this.pendingResolve = (res) => {
        clearTimeout(timer);
        resolve(res);
      };
      this.pendingReject = () => {
        clearTimeout(timer);
        resolve(null);
      };
      this.tryParseBuffer();
    });
  }

  private tryParseBuffer() {
    if (!this.pendingResolve) return;

    let offset = 0;
    const lines: string[] = [];

    while (offset < this.buffer.length) {
      const nlIdx = this.buffer.indexOf(0x0a, offset); // \n
      if (nlIdx === -1) return; // Venter på komplet linje

      let lineEnd = nlIdx;
      if (lineEnd > offset && this.buffer[lineEnd - 1] === 0x0d) {
        lineEnd -= 1; // Fjern \r
      }

      const lineStr = this.buffer.subarray(offset, lineEnd).toString('utf8');
      offset = nlIdx + 1;

      // Tjek om linjen slutter med en literal: {123+} eller {123}
      const litMatch = lineStr.match(/\{(\d+)\+?\}$/);
      if (litMatch) {
        const litByteLen = Number(litMatch[1]);
        if (offset + litByteLen > this.buffer.length) {
          return; // Venter på hele literal-blokken
        }
        const literalContent = this.buffer
          .subarray(offset, offset + litByteLen)
          .toString('utf8');
        offset += litByteLen;

        // Efter en literal følger typisk \r\n
        if (offset < this.buffer.length && this.buffer[offset] === 0x0d) offset += 1;
        if (offset < this.buffer.length && this.buffer[offset] === 0x0a) offset += 1;

        lines.push(literalContent);
        continue;
      }

      const statusMatch = lineStr.match(/^(OK|NO|BYE)(?:\s+\(([^)]+)\))?(?:\s+"?(.*?)"?)?$/i);
      if (statusMatch) {
        this.buffer = this.buffer.subarray(offset);
        const resolve = this.pendingResolve;
        this.pendingResolve = null;
        this.pendingReject = null;
        resolve({
          status: statusMatch[1].toUpperCase() as 'OK' | 'NO' | 'BYE',
          code: statusMatch[2],
          message: statusMatch[3] || statusMatch[1],
          lines
        });
        return;
      }

      lines.push(lineStr);
    }
  }

  async sendCommand(cmd: string): Promise<ManageSieveResponse> {
    if (!this.socket) throw new Error('ManageSieve socket er ikke forbundet.');
    const p = this.waitForResponse();
    this.socket.write(`${cmd}\r\n`, 'utf8');
    return p;
  }

  async listScripts(): Promise<{ scripts: SieveScriptInfoDTO[]; activeScriptName: string }> {
    const resp = await this.sendCommand('LISTSCRIPTS');
    if (resp.status !== 'OK') {
      throw new Error(`Kunne ikke hente Sieve-scripts: ${resp.message}`);
    }
    const scripts: SieveScriptInfoDTO[] = [];
    let activeScriptName = '';

    for (const line of resp.lines) {
      const m = line.match(/^"((?:[^"\\]|\\.)*)"(\s+ACTIVE)?$/i);
      if (m) {
        const name = m[1].replace(/\\"/g, '"');
        const active = Boolean(m[2]);
        scripts.push({ name, active });
        if (active) activeScriptName = name;
      }
    }
    return { scripts, activeScriptName };
  }

  async getScript(name: string): Promise<string> {
    const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const resp = await this.sendCommand(`GETSCRIPT "${escaped}"`);
    if (resp.status !== 'OK') {
      throw new Error(`Kunne ikke læse Sieve-script "${name}": ${resp.message}`);
    }
    return resp.lines.join('\n');
  }

  async putScript(name: string, content: string, setActive = true): Promise<void> {
    const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const normalizedContent = content.replace(/\r?\n/g, '\r\n');
    const byteLen = Buffer.byteLength(normalizedContent, 'utf8');

    const resp = await this.sendCommand(`PUTSCRIPT "${escaped}" {${byteLen}+}\r\n${normalizedContent}`);
    if (resp.status !== 'OK') {
      throw new Error(`Sieve syntaksfejl eller afvisning fra server: ${resp.message}`);
    }

    if (setActive) {
      const actResp = await this.sendCommand(`SETACTIVE "${escaped}"`);
      if (actResp.status !== 'OK') {
        throw new Error(`Kunne ikke aktivere Sieve-script "${name}": ${actResp.message}`);
      }
    }
  }

  async close(): Promise<void> {
    if (!this.socket) return;
    try {
      this.socket.write('LOGOUT\r\n');
      this.socket.end();
    } catch {
      this.socket.destroy();
    }
    this.socket = null;
  }
}

/**
 * Parser et eksisterende Sieve-script (både vores egne JSON-annoterede regler, SOGo-regler og Roundcube/Dovecot regler)
 * til strukturerede SieveRuleDTO objekter til den visuelle regelsbygger.
 */
export function parseSieveScriptToRules(rawScript: string): {
  rules: SieveRuleDTO[];
  hasUnparsedCustomBlocks: boolean;
} {
  if (!rawScript || !rawScript.trim()) {
    return { rules: [], hasUnparsedCustomBlocks: false };
  }

  const rules: SieveRuleDTO[] = [];

  // 1. Tjek først om scriptet indeholder vores eller Roundcube/SOGo regel-blokke:
  // Vi understøtter både:
  //   # rule:[Navn] (Roundcube standard!)
  //   # @imap-sync-rule: {...json...}
  //   og almindelige if/elsif blokke fra SOGo / Mailcow.
  const lines = rawScript.replace(/\r\n/g, '\n').split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Hvis linjen har vores fulde JSON-metadata kommentar:
    if (line.startsWith('# @imap-sync-rule:')) {
      const jsonPart = line.slice('# @imap-sync-rule:'.length).trim();
      try {
        const parsedRule = JSON.parse(jsonPart) as SieveRuleDTO;
        if (parsedRule && parsedRule.name && Array.isArray(parsedRule.conditions)) {
          rules.push({
            ...parsedRule,
            id: parsedRule.id || crypto.randomUUID()
          });
          // Spring den efterfølgende if-blok over så vi ikke dobbeltparser den
          i += 1;
          while (i < lines.length && !lines[i].trim().startsWith('# @imap-sync-rule:') && !lines[i].trim().startsWith('# rule:[')) {
            if (lines[i].trim() === '}') {
              i += 1;
              break;
            }
            i += 1;
          }
          continue;
        }
      } catch {
        // Fald tilbage til generel parser
      }
    }

    i += 1;
  }

  if (rules.length > 0) {
    return { rules, hasUnparsedCustomBlocks: false };
  }

  // 2. Generel parser til eksisterende SOGo / Roundcube / Mailcow Sieve-scripts!
  // Finder "# rule:[Navn]" efterfulgt af if/elsif (...) { ... } ELLER enhver top-level if (...) { ... }
  const blockRegex =
    /(?:#\s*rule:\[(.*?)\]\s*\n)?(if|elsif)\s+([\s\S]*?)\{\s*([\s\S]*?)\n\}/gi;
  let match: RegExpExecArray | null;
  let ruleCounter = 1;

  while ((match = blockRegex.exec(rawScript)) !== null) {
    const ruleName = (match[1] || `Filterregel #${ruleCounter}`).trim();
    const condRaw = match[3].trim();
    const bodyRaw = match[4].trim();
    ruleCounter += 1;

    const matchType: 'allof' | 'anyof' = /^allof/i.test(condRaw) ? 'allof' : 'anyof';
    const conditions: SieveConditionDTO[] = [];

    // Match header :contains / :is / :matches ["From"] ["værdi"] eller "From" "værdi"
    const headerCondRegex =
      /header\s+:(contains|is|matches)\s+(?:\[\s*"([^"]+)"\s*\]|"([^"]+)")\s+(?:\[\s*"([^"]+)"\s*\]|"([^"]+)")/gi;
    let hm: RegExpExecArray | null;
    while ((hm = headerCondRegex.exec(condRaw)) !== null) {
      const comp = hm[1].toLowerCase() as 'contains' | 'is' | 'matches';
      const hdr = (hm[2] || hm[3] || '').trim();
      const val = (hm[4] || hm[5] || '').trim();
      const lowerHdr = hdr.toLowerCase();

      if (lowerHdr === 'from') {
        conditions.push({ field: 'from', comparator: comp, value: val });
      } else if (lowerHdr === 'to' || lowerHdr === 'cc') {
        conditions.push({ field: 'to', comparator: comp, value: val });
      } else if (lowerHdr === 'subject') {
        conditions.push({ field: 'subject', comparator: comp, value: val });
      } else {
        conditions.push({ field: 'header', customHeader: hdr, comparator: comp, value: val });
      }
    }

    // Match address :contains "from" "værdi" (bruges ofte af SOGo!)
    const addressCondRegex =
      /address\s+:(contains|is|matches)\s+(?:\[\s*"([^"]+)"\s*\]|"([^"]+)")\s+(?:\[\s*"([^"]+)"\s*\]|"([^"]+)")/gi;
    let am: RegExpExecArray | null;
    while ((am = addressCondRegex.exec(condRaw)) !== null) {
      const comp = am[1].toLowerCase() as 'contains' | 'is' | 'matches';
      const hdr = (am[2] || am[3] || '').toLowerCase();
      const val = (am[4] || am[5] || '').trim();
      conditions.push({
        field: hdr.includes('to') ? 'to' : 'from',
        comparator: comp,
        value: val
      });
    }

    // Match size :over / :under 100K
    const sizeCondRegex = /size\s+:(over|under)\s+([0-9]+[KMG]?)/gi;
    let sm: RegExpExecArray | null;
    while ((sm = sizeCondRegex.exec(condRaw)) !== null) {
      conditions.push({
        field: 'size',
        comparator: sm[1].toLowerCase() as 'over' | 'under',
        value: sm[2]
      });
    }

    if (conditions.length === 0) {
      conditions.push({
        field: 'subject',
        comparator: 'contains',
        value: ''
      });
    }

    // Parse actions i { ... }
    const actions: SieveActionDTO[] = [];
    const fileintoRegex = /fileinto\s+(?:":create"\s+)?"([^"]+)"/gi;
    let fm: RegExpExecArray | null;
    while ((fm = fileintoRegex.exec(bodyRaw)) !== null) {
      actions.push({ type: 'fileinto', target: fm[1] });
    }

    const redirectRegex = /redirect\s+(?:":copy"\s+)?"([^"]+)"/gi;
    let rm: RegExpExecArray | null;
    while ((rm = redirectRegex.exec(bodyRaw)) !== null) {
      actions.push({ type: 'redirect', target: rm[1] });
    }

    if (/addflag\s+"\\\\Seen"/i.test(bodyRaw) || /setflag\s+"\\\\Seen"/i.test(bodyRaw)) {
      actions.push({ type: 'addflag_seen' });
    }
    if (/addflag\s+"\\\\Flagged"/i.test(bodyRaw) || /setflag\s+"\\\\Flagged"/i.test(bodyRaw)) {
      actions.push({ type: 'addflag_flagged' });
    }
    if (/\bdiscard\s*;/i.test(bodyRaw)) {
      actions.push({ type: 'discard' });
    }
    if (/\bkeep\s*;/i.test(bodyRaw)) {
      actions.push({ type: 'keep' });
    }

    if (actions.length === 0) {
      actions.push({ type: 'keep' });
    }

    const stopProcessing = /\bstop\s*;/i.test(bodyRaw);

    rules.push({
      id: crypto.randomUUID(),
      name: ruleName,
      enabled: true,
      matchType,
      conditions,
      actions,
      stopProcessing
    });
  }

  const hasUnparsedCustomBlocks = rawScript.trim().length > 0 && rules.length === 0;
  return { rules, hasUnparsedCustomBlocks };
}

function escapeSieveStr(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Kompilerer strukturerede SieveRuleDTO objekter til et standard RFC 5228 Sieve-script
 * (kompatibelt med både Mailcow/Dovecot, Roundcube `# rule:[...]` og SOGo).
 */
export function compileRulesToSieveScript(rules: SieveRuleDTO[]): string {
  const requires = new Set<string>();
  const activeRules = rules.filter((r) => r.enabled);

  for (const r of activeRules) {
    for (const a of r.actions) {
      if (a.type === 'fileinto') requires.add('fileinto');
      if (a.type === 'addflag_seen' || a.type === 'addflag_flagged') requires.add('imap4flags');
      if (a.type === 'reject') requires.add('reject');
    }
  }

  const out: string[] = [
    '# ============================================================================',
    '# Genereret af Sharedrive Mail (Kompatibel med Mailcow, Dovecot, SOGo & Roundcube)',
    '# ============================================================================'
  ];

  if (requires.size > 0) {
    const reqList = Array.from(requires)
      .map((r) => `"${r}"`)
      .join(', ');
    out.push(`require [${reqList}];`);
    out.push('');
  }

  for (const rule of rules) {
    // Gem metadata i en kommentar, så endda deaktiverede regler huskes på serveren!
    out.push(`# @imap-sync-rule: ${JSON.stringify(rule)}`);
    out.push(`# rule:[${rule.name}]`);

    if (!rule.enabled) {
      out.push(`# (Deaktiveret regel: ${rule.name})`);
      out.push('');
      continue;
    }

    const condExprs = rule.conditions
      .filter((c) => c.value.trim().length > 0)
      .map((c) => {
        const val = escapeSieveStr(c.value.trim());
        if (c.field === 'size') {
          const sizeComp = c.comparator === 'under' ? ':under' : ':over';
          const cleanSize = /^[0-9]+[KMG]?$/i.test(val) ? val.toUpperCase() : '100K';
          return `size ${sizeComp} ${cleanSize}`;
        }
        const comp =
          c.comparator === 'is'
            ? ':is'
            : c.comparator === 'matches'
              ? ':matches'
              : ':contains';
        const headerName =
          c.field === 'from'
            ? 'From'
            : c.field === 'to'
              ? 'To'
              : c.field === 'subject'
                ? 'Subject'
                : escapeSieveStr(c.customHeader || 'Subject');
        return `header ${comp} "${headerName}" "${val}"`;
      });

    if (condExprs.length === 0) {
      condExprs.push('true');
    }

    const testClause =
      condExprs.length === 1
        ? condExprs[0]
        : `${rule.matchType} (${condExprs.join(', ')})`;

    out.push(`if ${testClause} {`);

    for (const act of rule.actions) {
      if (act.type === 'fileinto' && act.target) {
        out.push(`  fileinto "${escapeSieveStr(act.target)}";`);
      } else if (act.type === 'redirect' && act.target) {
        out.push(`  redirect "${escapeSieveStr(act.target)}";`);
      } else if (act.type === 'addflag_seen') {
        out.push('  addflag "\\\\Seen";');
      } else if (act.type === 'addflag_flagged') {
        out.push('  addflag "\\\\Flagged";');
      } else if (act.type === 'discard') {
        out.push('  discard;');
      } else if (act.type === 'reject' && act.target) {
        out.push(`  reject "${escapeSieveStr(act.target)}";`);
      } else if (act.type === 'keep') {
        out.push('  keep;');
      }
    }

    if (rule.stopProcessing) {
      out.push('  stop;');
    }

    out.push('}');
    out.push('');
  }

  return out.join('\n');
}

function getSievePort(): number {
  return Number(process.env.DEFAULT_SIEVE_PORT || 4190);
}

/**
 * Henter alle eksisterende Sieve-scripts og det aktive script fra Mailcow/SOGo/Dovecot (port 4190).
 */
export async function fetchSieveOverview(creds: MailServerCredentials): Promise<SieveOverviewDTO> {
  const host = creds.imapHost;
  const port = getSievePort();
  const allowInsecure = process.env.ALLOW_INSECURE_TLS === 'true';
  const client = new ManageSieveClient(host, port, allowInsecure, creds.imapServerName);

  try {
    await client.connect(creds.username, creds.password, creds.clientIp);
    const { scripts, activeScriptName } = await client.listScripts();

    // Hvis der er et aktivt script (f.eks. "sogo" i Mailcow/SOGo eller "roundcube" eller "imap-sync"), hentes det
    const targetScript =
      activeScriptName ||
      scripts.find((s) => /sogo|roundcube|mailcow|default|imap-sync/i.test(s.name))?.name ||
      scripts[0]?.name ||
      '';

    let rawScript = '';
    if (targetScript) {
      rawScript = await client.getScript(targetScript);
    }

    const parsed = parseSieveScriptToRules(rawScript);

    return {
      supported: true,
      host,
      port,
      scripts,
      activeScriptName: targetScript || 'sogo',
      rawScript,
      rules: parsed.rules,
      hasUnparsedCustomBlocks: parsed.hasUnparsedCustomBlocks
    };
  } finally {
    await client.close();
  }
}

/**
 * Henter et specifikt navngivet Sieve-script fra serveren (f.eks. hvis brugeren skifter mellem "sogo" og et andet script).
 */
export async function fetchSpecificSieveScript(
  creds: MailServerCredentials,
  scriptName: string
): Promise<{ scriptName: string; rawScript: string; rules: SieveRuleDTO[] }> {
  const host = creds.imapHost;
  const port = getSievePort();
  const allowInsecure = process.env.ALLOW_INSECURE_TLS === 'true';
  const client = new ManageSieveClient(host, port, allowInsecure, creds.imapServerName);

  try {
    await client.connect(creds.username, creds.password, creds.clientIp);
    const rawScript = await client.getScript(scriptName);
    const parsed = parseSieveScriptToRules(rawScript);
    return {
      scriptName,
      rawScript,
      rules: parsed.rules
    };
  } finally {
    await client.close();
  }
}

/**
 * Gemmer og aktiverer enten visuelle regler (kompileret til Sieve) ELLER et råt Sieve-script direkte på Mailcow/SOGo.
 */
export async function saveSieveRulesOrScript(
  creds: MailServerCredentials,
  params: {
    scriptName?: string;
    rules?: SieveRuleDTO[];
    rawScript?: string;
  }
): Promise<SieveOverviewDTO> {
  const host = creds.imapHost;
  const port = getSievePort();
  const allowInsecure = process.env.ALLOW_INSECURE_TLS === 'true';
  const client = new ManageSieveClient(host, port, allowInsecure, creds.imapServerName);

  try {
    await client.connect(creds.username, creds.password, creds.clientIp);
    const { activeScriptName } = await client.listScripts();

    // Bevar eksisterende scriptnavn (f.eks. "sogo" på Mailcow), så reglerne også er synlige i SOGo!
    const targetName = (params.scriptName || activeScriptName || 'sogo').trim();
    const contentToSave =
      typeof params.rawScript === 'string'
        ? params.rawScript
        : compileRulesToSieveScript(params.rules || []);

    await client.putScript(targetName, contentToSave, true);
  } finally {
    await client.close();
  }

  return fetchSieveOverview(creds);
}
