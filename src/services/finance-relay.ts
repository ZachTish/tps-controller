import * as logger from "../logger";
import { App, Platform } from 'obsidian';
const CONFIG = 'tps-finance-relay-v1';
const KEY = 'tps-finance-relay-key';
const JOURNAL = 'tps-finance-relay-journal';
export const DEFAULT_FINANCE_FOLDER = '_assets/TPS Finance Relay';

export function financeRequestFolder(value: unknown): string {
    if (typeof value !== 'string') throw new Error('Enter a vault-relative request folder.');
    const folder = value.trim();
    if (!folder || new TextEncoder().encode(folder).length > 300 || folder.split('/').some(part => !part || part.startsWith('.') || part !== part.trim() || /[\\:*?"<>|\p{Cc}]/u.test(part) || /[. ]$/.test(part)))
        throw new Error('Use a vault-relative folder without hidden folders, empty segments, or traversal.');
    return folder;
}
const TTL = 30 * 60000;
const RESULT_GRACE = 6 * 60 * 60000;
const RETAIN = 24 * 60 * 60000;
const MAX_BYTES = 256000;
const MARKER = '<!-- tps-finance-relay:v1 -->';
const uuid = () => crypto.randomUUID();
const validID = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(s);
export type FinanceAction = 'connect' | 'reconnect' | 'sync' | 'disconnect';
export interface FinanceRelayItem {
    localItemId: string;
    institutionName: string;
    environment: string;
    lastSyncAt: string;
}
export interface FinanceLinkSession {
    linkToken: string;
    url: string;
    expiresAt: number;
    environment: string;
    clientRef: string;
    secretRef: string;
    itemId?: string;
}
export interface FinanceLinkResult {
    state: 'waiting' | 'complete' | 'cancelled';
    publicToken?: string;
    institutionName?: string;
}
export interface FinanceRelayBackend {
    version: 1;
    prepareHost?(): void;
    snapshot(): {
        items: FinanceRelayItem[];
        ready: boolean;
    };
    createLink(itemId?: string): Promise<FinanceLinkSession>;
    pollLink(session: FinanceLinkSession): Promise<FinanceLinkResult>;
    completeLink(session: FinanceLinkSession, result: FinanceLinkResult, requestId: string): Promise<void>;
    hasCompleted(requestId: string): boolean;
    sync(): Promise<void>;
    disconnect(itemId: string): Promise<void>;
}
interface Config {
    version: 1;
    mode: 'host' | 'client';
    relayId: string;
    deviceId: string;
    enabled: boolean;
    intervalMinutes: number;
    folder?: string;
    folderMove?: { from: string; to: string; hadSource: boolean };
}
interface Request {
    id: string;
    deviceId: string;
    action: FinanceAction;
    itemId?: string;
    createdAt: number;
    expiresAt: number;
}
export interface FinanceOperation {
    id: string;
    action: FinanceAction;
    itemId?: string;
    expiresAt: number;
    state: 'queued' | 'working' | 'awaiting-user' | 'complete' | 'failed' | 'uncertain';
    message: string;
    url?: string;
}
interface Job {
    request: Request;
    response: FinanceOperation;
    session?: FinanceLinkSession;
    phase: 'queued' | 'creating' | 'waiting' | 'exchanging' | 'done';
    attempts: number;
    nextAttempt: number;
}
interface Journal {
    version: 1;
    relayId: string;
    jobs: Record<string, Job>;
    pending: Request[];
    nextSyncAt: number;
    lastSyncAt: number;
    lastError: string;
}
export interface FinanceRelayStatus {
    configured: boolean;
    mode?: 'host' | 'client';
    enabled: boolean;
    online: boolean;
    message: string;
    updatedAt: number;
    lastSyncAt: number;
    items: FinanceRelayItem[];
}
function base64(bytes: Uint8Array): string { return btoa(Array.from(bytes, b => String.fromCharCode(b)).join('')); }
function unbase64(s: string): Uint8Array { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
export function validHostedLink(url: string): boolean {
    try {
        const u = new URL(url);
        return u.protocol === 'https:' && u.hostname === 'secure.plaid.com' && u.pathname.startsWith('/hl/') && !u.username && !u.password && !u.port;
    }
    catch {
        return false;
    }
}
export async function encodeRelay(value: unknown, key: string, identity: string): Promise<string> {
    const data = new TextEncoder().encode(JSON.stringify(value));
    if (data.length > MAX_BYTES)
        throw new Error('Finance relay message is too large.');
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const cryptoKey = await crypto.subtle.importKey('raw', unbase64(key), 'AES-GCM', false, ['encrypt']);
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(identity) }, cryptoKey, data);
    return `${MARKER}\n\n\`\`\`json\n${JSON.stringify({ v: 1, nonce: base64(nonce), ciphertext: base64(new Uint8Array(cipher)) })}\n\`\`\`\n`;
}
export async function decodeRelay(text: string, key: string, identity: string): Promise<any> {
    if (text.length > MAX_BYTES * 2)
        throw new Error('Finance relay message is too large.');
    const raw = text.match(/<!-- tps-finance-relay:v1 -->\s*```json\s*([^`]+)```/)?.[1];
    if (!raw)
        throw new Error('Unrecognized finance relay message.');
    const box = JSON.parse(raw);
    if (box.v !== 1 || typeof box.nonce !== 'string' || typeof box.ciphertext !== 'string')
        throw new Error('Invalid finance relay message.');
    const nonce = unbase64(box.nonce);
    if (nonce.length !== 12)
        throw new Error('Invalid finance relay nonce.');
    const cryptoKey = await crypto.subtle.importKey('raw', unbase64(key), 'AES-GCM', false, ['decrypt']);
    const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(identity) }, cryptoKey, unbase64(box.ciphertext));
    return JSON.parse(new TextDecoder().decode(data));
}
function validItem(item: any): item is FinanceRelayItem { return item && ['localItemId', 'institutionName', 'environment', 'lastSyncAt'].every(key => typeof item[key] === 'string' && item[key].length < 512); }
function safeError(error: unknown): string {
    const code = (error as {
        code?: unknown;
    })?.code;
    return typeof code === 'string' && /^[A-Z_]{1,70}$/.test(code)
        ? `Plaid returned ${code}. Check the connection on the Controller.`
        : 'The Controller could not finish this request. Check its Plaid connection and try again.';
}
/** One pinned Controller performs all bank operations. Vault sync only carries encrypted messages. */
export class FinanceRelayService {
    readonly version = 1;
    private running: Promise<void> | null = null;
    private queue: Promise<unknown> = Promise.resolve();
    private publishedResponses = new Map<string, string>();
    private timer: number | null = null;
    private stopped = false;
    private lastPublished = 0;
    private status: FinanceRelayStatus = { configured: false, enabled: false, online: false, message: 'Set up a finance Controller.', updatedAt: 0, lastSyncAt: 0, items: [] };
    private responses = new Map<string, FinanceOperation>();
    constructor(private app: App, private isController: () => boolean, private backend: () => FinanceRelayBackend | undefined, private now: () => number = Date.now) { }
    private exclusive<T>(action: () => Promise<T>): Promise<T> {
        const owner = this.app as App & {
            tpsFinanceQueue?: Promise<unknown>;
        };
        const operation = (owner.tpsFinanceQueue || Promise.resolve()).then(action);
        this.queue = operation.catch(() => undefined);
        owner.tpsFinanceQueue = this.queue;
        return operation;
    }
    private active(c: Config): boolean {
        return !this.stopped && this.isController() && !Platform.isMobile && this.getConfiguration()?.enabled === true;
    }
    getConfiguration(): Config | null {
        const raw = this.app.loadLocalStorage(CONFIG);
        if (raw == null)
            return null;
        if (raw.version !== 1 || !validID(raw.relayId) || !validID(raw.deviceId) || !['host', 'client'].includes(raw.mode)
            || typeof raw.enabled !== 'boolean' || !Number.isFinite(raw.intervalMinutes) || raw.intervalMinutes < 0 || raw.intervalMinutes > 1440)
            throw new Error('Invalid finance relay configuration.');
        if (raw.folder !== undefined && financeRequestFolder(raw.folder) !== raw.folder)
            throw new Error('Invalid finance request folder.');
        if (raw.folderMove && (raw.mode !== 'host' || typeof raw.folderMove.to !== 'string' || financeRequestFolder(raw.folderMove.to.slice(0, -(raw.relayId.length + 1))) + '/' + raw.relayId !== raw.folderMove.to || raw.folderMove.from.toLowerCase() === raw.folderMove.to.toLowerCase() || raw.folderMove.from.toLowerCase().startsWith(raw.folderMove.to.toLowerCase() + '/') || raw.folderMove.to.toLowerCase().startsWith(raw.folderMove.from.toLowerCase() + '/') || typeof raw.folderMove.hadSource !== 'boolean' || raw.folderMove.from !== `${raw.folder || DEFAULT_FINANCE_FOLDER}/${raw.relayId}` || !raw.folderMove.to.endsWith('/' + raw.relayId)))
            throw new Error('Invalid finance folder move.');
        return raw;
    }
    getRequestFolder(): string { return this.getConfiguration()?.folder || DEFAULT_FINANCE_FOLDER; }
    async setRequestFolder(value: string): Promise<void> {
        await this.exclusive(async () => {
            const folder = financeRequestFolder(value);
            let c = this.getConfiguration();
            if (!c || c.mode !== 'host' || Platform.isMobile) throw new Error('Change the request folder on the finance host.');
            c = await this.finishFolderMove(c);
            const old = c.folder || DEFAULT_FINANCE_FOLDER;
            if (old === folder) return;
            const from = `${old}/${c.relayId}`, to = `${folder}/${c.relayId}`;
            if (from.toLowerCase() === to.toLowerCase() || from.toLowerCase().startsWith(to.toLowerCase() + '/') || to.toLowerCase().startsWith(from.toLowerCase() + '/')) throw new Error('Choose a separate request folder.');
            const adapter = this.app.vault.adapter;
            if (await adapter.exists(to)) throw new Error('The destination already contains this connection. No files were replaced.');
            const hadSource = await adapter.exists(from);
            if (hadSource && (await adapter.stat(from))?.type !== 'folder') throw new Error('The finance request location is not a folder.');
            c = {...this.getConfiguration()!, folderMove: {from, to, hadSource}};
            this.app.saveLocalStorage(CONFIG, c); // Recover if the app closes after rename but before the new path is saved.
            await this.finishFolderMove(c);
        });
    }
    private async finishFolderMove(c: Config): Promise<Config> {
        const move = c.folderMove;
        if (!move) return c;
        const adapter = this.app.vault.adapter;
        const fromExists = await adapter.exists(move.from), toExists = await adapter.exists(move.to);
        if (fromExists && toExists) throw new Error('Both finance folders exist. Resolve the collision before resuming.');
        if (!fromExists && !toExists && move.hadSource) throw new Error('The finance folder being moved is missing. Restore it before resuming.');
        if (fromExists) {
            if ((await adapter.stat(move.from))?.type !== 'folder') throw new Error('The finance request location is not a folder.');
            let parent = '';
            for (const part of move.to.split('/').slice(0, -1)) {
                parent = parent ? `${parent}/${part}` : part;
                if (!await adapter.exists(parent)) await adapter.mkdir(parent);
            }
            await adapter.rename(move.from, move.to);
        }
        const next = {...this.getConfiguration()!, folder: move.to.slice(0, -(c.relayId.length + 1))};
        delete next.folderMove;
        this.app.saveLocalStorage(CONFIG, next);
        this.publishedResponses.clear();
        this.lastPublished = 0;
        logger.flow('FinanceRelay', 'folder-moved', {mode:c.mode});
        return next;
    }
    getStatus(): FinanceRelayStatus {
        const config = this.getConfiguration();
        if (!config)
            return { ...this.status, configured: false };
        const online = config.enabled && this.status.online && this.now() - this.status.updatedAt < 90000;
        const message = !config.enabled ? 'Finance connection paused.'
            : this.status.online && !online ? 'Waiting for the Controller and vault sync.' : this.status.message;
        return { ...this.status, configured: true, mode: config.mode, enabled: config.enabled, online, message };
    }
    getOperations(): FinanceOperation[] { return Array.from(this.responses.values()); }
    private secret(): string {
        const value = this.app.secretStorage.getSecret(KEY);
        if (!value || unbase64(value).length !== 32)
            throw new Error('Finance pairing key is missing. Pair this device again.');
        return value;
    }
    private journal(config: Config): Journal {
        const text = this.app.secretStorage.getSecret(JOURNAL);
        if (!text)
            throw new Error('Finance relay journal is missing. Restore its local state before continuing.');
        const raw = JSON.parse(text);
        if (raw.version !== 1 || raw.relayId !== config.relayId || !raw.jobs || Array.isArray(raw.jobs) || typeof raw.jobs !== 'object' || !Array.isArray(raw.pending) || raw.pending.some((r: any) => !this.validRequest(r, r?.id)) || Object.entries(raw.jobs).some(([id, j]: [
            string,
            any
        ]) => !validID(id) || !this.validRequest(j?.request, id) || !j.response || j.response.id !== id || !['queued', 'creating', 'waiting', 'exchanging', 'done'].includes(j.phase) || !['queued', 'working', 'awaiting-user', 'complete', 'failed', 'uncertain'].includes(j.response.state) || j.response.action !== j.request.action || !Number.isFinite(j.attempts) || !Number.isFinite(j.nextAttempt) || ['waiting', 'exchanging'].includes(j.phase) && (!j.session || typeof j.session.linkToken !== 'string' || !validHostedLink(j.session.url) || !Number.isFinite(j.session.expiresAt) || !['sandbox', 'development', 'production'].includes(j.session.environment) || typeof j.session.clientRef !== 'string' || typeof j.session.secretRef !== 'string')) || !Number.isFinite(raw.nextSyncAt) || !Number.isFinite(raw.lastSyncAt))
            throw new Error('Finance relay journal is invalid. Restore its local state before continuing.');
        return raw;
    }
    private save(journal: Journal): void { this.app.secretStorage.setSecret(JOURNAL, JSON.stringify(journal)); }
    async configureHost(folder = DEFAULT_FINANCE_FOLDER): Promise<void> {
        folder = financeRequestFolder(folder);
        if (!this.isController() || Platform.isMobile)
            throw new Error('Choose the Controller role on the always-running desktop first.');
        if (this.getConfiguration())
            throw new Error('This device already has a finance pairing.');
        const backend = this.backend();
        if (!backend)
            throw new Error('Enable TPS Finances 1.4.0+ before setting up the host.');
        backend.prepareHost?.();
        const config: Config = { version: 1, mode: 'host', folder, relayId: uuid(), deviceId: uuid(), enabled: true, intervalMinutes: 15 };
        this.app.secretStorage.setSecret(KEY, base64(crypto.getRandomValues(new Uint8Array(32))));
        this.save({ version: 1, relayId: config.relayId, jobs: {}, pending: [], nextSyncAt: this.now() + 15 * 60000, lastSyncAt: 0, lastError: '' });
        this.app.saveLocalStorage(CONFIG, config);
        await this.tick();
    }
    exportPairing(): string {
        const c = this.getConfiguration();
        if (!c || c.mode !== 'host' || !this.isController())
            throw new Error('Export pairing on the finance Controller.');
        return 'tps-finance-v1:' + base64(new TextEncoder().encode(JSON.stringify({ v: 1, relayId: c.relayId, key: this.secret(), folder: c.folder || DEFAULT_FINANCE_FOLDER })));
    }
    async importPairing(value: string): Promise<void> {
        await this.exclusive(async () => {
            if (!value.trim().startsWith('tps-finance-v1:') || value.length > 2048)
                throw new Error('Invalid finance pairing code.');
            const pairing = JSON.parse(new TextDecoder().decode(unbase64(value.trim().slice('tps-finance-v1:'.length))));
            if (pairing.v !== 1 || !validID(pairing.relayId) || typeof pairing.key !== 'string' || unbase64(pairing.key).length !== 32)
                throw new Error('Invalid finance pairing code.');
            const folder = financeRequestFolder(pairing.folder ?? DEFAULT_FINANCE_FOLDER);
            const current = this.getConfiguration();
            if (current) {
                if (current.mode !== 'client' || current.relayId !== pairing.relayId || this.secret() !== pairing.key)
                    throw new Error('This device belongs to another pairing. Its existing connection was preserved.');
                this.journal(current); // A folder update must never replace a lost or corrupt journal.
                this.app.saveLocalStorage(CONFIG, {...current, folder});
            } else {
                this.app.secretStorage.setSecret(KEY, pairing.key);
                this.save({ version: 1, relayId: pairing.relayId, jobs: {}, pending: [], nextSyncAt: 0, lastSyncAt: 0, lastError: '' });
                this.app.saveLocalStorage(CONFIG, { version: 1, mode: 'client', folder, relayId: pairing.relayId, deviceId: uuid(), enabled: true, intervalMinutes: 0 });
            }
        });
        await this.tick();
    }
    setEnabled(enabled: boolean): void { const c = this.getConfiguration(); if (c)
        this.app.saveLocalStorage(CONFIG, { ...c, enabled }); void this.tick(); }
    async unpairClient(): Promise<void> {
        await this.exclusive(async () => {
            if (this.getConfiguration()?.mode !== 'client')
                throw new Error('Only a paired client can be removed here.');
            this.app.saveLocalStorage(CONFIG, null);
            this.app.secretStorage.setSecret(KEY, '');
            this.app.secretStorage.setSecret(JOURNAL, '');
            this.responses.clear();
            this.status = { configured: false, enabled: false, online: false, message: 'Pair this device with your Controller.', updatedAt: 0, lastSyncAt: 0, items: [] };
        });
    }
    async setIntervalMinutes(minutes: number): Promise<void> {
        return this.exclusive(async () => {
            const c = this.getConfiguration();
            if (!c || ![0, 15, 30, 60, 360, 1440].includes(minutes))
                throw new Error('Invalid finance refresh interval.');
            this.app.saveLocalStorage(CONFIG, { ...c, intervalMinutes: minutes });
            const j = this.journal(c);
            j.nextSyncAt = minutes ? this.now() + minutes * 60000 : 0;
            this.save(j);
        });
    }
    start(): void { this.stopped = false; if (this.timer !== null)
        return; this.timer = window.setInterval((): void => { void this.tick(); }, 4000); void this.tick(); }
    async stop(): Promise<void> { this.stopped = true; if (this.timer !== null)
        window.clearInterval(this.timer); this.timer = null; await this.queue; }
    async request(action: FinanceAction, itemId?: string): Promise<string> {
        const id = await this.exclusive(async () => {
            let c = this.getConfiguration();
            if (c?.folderMove) c = await this.finishFolderMove(c);
            if (!c || !c.enabled)
                throw new Error('Set up or resume the finance Controller connection first.');
            this.secret();
            if (!['connect', 'reconnect', 'sync', 'disconnect'].includes(action) || ((action === 'reconnect' || action === 'disconnect') && (!itemId || itemId.length > 160)))
                throw new Error('Invalid finance action.');
            const j = this.journal(c);
            const existing = j.pending.find(r => r.action === action && r.itemId === itemId && (r.expiresAt > this.now() || r.expiresAt + RESULT_GRACE > this.now() && ['awaiting-user', 'working'].includes(this.responses.get(r.id)?.state || '')) && !['complete', 'failed', 'uncertain'].includes(this.responses.get(r.id)?.state || ''));
            if (existing)
                return existing.id;
            const request: Request = { id: uuid(), deviceId: c.deviceId, action, itemId, createdAt: this.now(), expiresAt: this.now() + TTL };
            j.pending = j.pending.filter(r => r.expiresAt + RETAIN > this.now());
            if (j.pending.length >= 100)
                throw new Error('Too many pending finance requests. Wait for the Controller.');
            j.pending.push(request);
            this.save(j);
            logger.flow('FinanceRelay', 'request-queued', { action, mode: c.mode }); // Persist before publishing; tick repairs an interrupted write.
            this.responses.set(request.id, { ...request, state: 'queued', message: 'Waiting for the Controller.' });
            await this.write(c, `requests/${request.id}`, request);
            return request.id;
        });
        void this.tick();
        return id;
    }
    async tick(): Promise<void> {
        if (this.stopped)
            return;
        if (this.running)
            return this.running;
        this.running = this.exclusive(() => this.reconcile()).catch(() => { this.status = { ...this.status, online: false, message: 'Finance relay paused: pairing, encrypted messages, or local journal could not be read. Check vault sync and restore local state.' }; }).finally(() => { this.running = null; });
        return this.running;
    }
    private path(c: Config, name: string): string { return `${c.folder || DEFAULT_FINANCE_FOLDER}/${c.relayId}/${name}.md`; }
    private async read(c: Config, name: string): Promise<any | null> {
        const path = this.path(c, name);
        if (!await this.app.vault.adapter.exists(path))
            return null;
        const stat = await this.app.vault.adapter.stat(path);
        if (!stat || stat.size > MAX_BYTES * 2)
            throw new Error('Invalid finance relay file.');
        return decodeRelay(await this.app.vault.adapter.read(path), this.secret(), `${c.relayId}/${name}`);
    }
    private async write(c: Config, name: string, value: unknown): Promise<void> {
        const path = this.path(c, name);
        const text = await encodeRelay(value, this.secret(), `${c.relayId}/${name}`);
        let folder = '';
        for (const part of path.split('/').slice(0, -1)) {
            folder = folder ? `${folder}/${part}` : part;
            if (!await this.app.vault.adapter.exists(folder))
                await this.app.vault.adapter.mkdir(folder);
        }
        await this.app.vault.adapter.write(path, text);
    }
    private validRequest(r: any, id: string): r is Request {
        return r && validID(id) && r.id === id && validID(r.deviceId) && ['connect', 'reconnect', 'sync', 'disconnect'].includes(r.action)
            && Number.isFinite(r.createdAt) && Number.isFinite(r.expiresAt)
            && r.expiresAt - r.createdAt > 0 && r.expiresAt - r.createdAt <= TTL
            && (r.itemId === undefined || typeof r.itemId === 'string' && r.itemId.length <= 160)
            && (!['reconnect', 'disconnect'].includes(r.action) || !!r.itemId);
    }
    private async reconcile(): Promise<void> {
        let c = this.getConfiguration();
        if (!c)
            return;
        if (c.folderMove) c = await this.finishFolderMove(c);
        if (!c.enabled) {
            this.status = { ...this.status, online: false, message: 'Finance connection paused.' };
            return;
        }
        this.secret();
        const j = this.journal(c);
        for (const [id, response] of this.responses)
            if (response.expiresAt + RETAIN < this.now())
                this.responses.delete(id);
        const pending = j.pending.filter(r => r.expiresAt + RETAIN >= this.now());
        if (pending.length !== j.pending.length) {
            j.pending = pending;
            this.save(j);
        }
        for (const r of j.pending) {
            if (r.expiresAt + RETAIN < this.now())
                continue;
            const response = await this.read(c, `responses/${r.id}`);
            if (response && response.id === r.id && ['queued', 'working', 'awaiting-user', 'complete', 'failed', 'uncertain'].includes(response.state)) {
                if (response.url && !validHostedLink(response.url))
                    throw new Error('Invalid Plaid URL.');
                this.responses.set(r.id, response);
            }
            else if (r.expiresAt + RESULT_GRACE < this.now())
                this.responses.set(r.id, { ...r, state: 'failed', message: 'Request expired. Check that the Controller and vault sync are running.' });
            else {
                this.responses.set(r.id, { ...r, state: 'queued', message: 'Waiting for the Controller.' });
                if (!await this.app.vault.adapter.exists(this.path(c, `requests/${r.id}`)))
                    await this.write(c, `requests/${r.id}`, r);
            }
        }
        if (c.mode === 'client') {
            const status = await this.read(c, 'status');
            if (status && status.version === 1 && Array.isArray(status.items) && status.items.every(validItem) && Number.isFinite(status.updatedAt) && status.updatedAt <= this.now() + 60000)
                this.status = { ...status, configured: true, mode: 'client', enabled: true };
            else
                this.status = { ...this.status, online: false, message: 'Waiting for the Controller and vault sync.' };
            return;
        }
        if (!this.isController() || Platform.isMobile) {
            this.status = { ...this.status, online: false, message: 'The finance host must be the desktop Controller.' };
            return;
        }
        const backend = this.backend();
        if (!backend || backend.version !== 1) {
            this.status = { ...this.status, online: false, message: 'Enable or update TPS Finances on the Controller.' };
            return;
        }
        const requestFolder = `${c.folder || DEFAULT_FINANCE_FOLDER}/${c.relayId}/requests`;
        if (await this.app.vault.adapter.exists(requestFolder)) {
            const { files } = await this.app.vault.adapter.list(requestFolder);
            for (const path of files) {
                const id = path.slice(requestFolder.length + 1).replace(/\.md$/, '');
                if (path !== `${requestFolder}/${id}.md` || !validID(id) || j.jobs[id])
                    continue;
                if (Object.keys(j.jobs).length >= 200)
                    break;
                const request = await this.read(c, `requests/${id}`);
                if (!this.validRequest(request, id))
                    throw new Error('Invalid finance request.');
                if (request.createdAt > this.now() + 60000)
                    continue;
                if (request.expiresAt + RETAIN < this.now()) {
                    await this.app.vault.adapter.remove(path);
                    continue;
                }
                j.jobs[id] = { request, response: { ...request, state: 'queued', message: 'Controller received request.' }, phase: 'queued', attempts: 0, nextAttempt: 0 };
            }
        }
        this.save(j);
        for (const [id, job] of Object.entries(j.jobs)) {
            if (!this.active(c))
                return;
            if (job.phase === 'done') {
                if (job.request.expiresAt + RETAIN < this.now()) {
                    for (const name of [`requests/${id}`, `responses/${id}`])
                        if (await this.app.vault.adapter.exists(this.path(c, name)))
                            await this.app.vault.adapter.remove(this.path(c, name));
                    delete j.jobs[id];
                    this.publishedResponses.delete(id);
                    this.responses.delete(id);
                    this.save(j);
                }
                else
                    await this.ensureResponse(c, job);
                continue;
            }
            if (job.nextAttempt > this.now())
                continue;
            await this.perform(c, j, job, backend);
        }
        if (this.active(c) && j.nextSyncAt && j.nextSyncAt <= this.now()) {
            j.nextSyncAt = c.intervalMinutes ? this.now() + c.intervalMinutes * 60000 : 0;
            this.save(j);
            try {
                await backend.sync();
                j.lastSyncAt = this.now();
                j.lastError = '';
            }
            catch (e) {
                j.lastError = safeError(e);
            }
            this.save(j);
        }
        if (this.now() - this.lastPublished >= 30000 || this.lastPublished === 0) {
            const snapshot = backend.snapshot();
            this.status = { configured: true, mode: 'host', enabled: true, online: true, updatedAt: this.now(), lastSyncAt: j.lastSyncAt, items: snapshot.items.map(({ localItemId, institutionName, environment, lastSyncAt }) => ({ localItemId, institutionName, environment, lastSyncAt })), message: j.lastError || (!snapshot.ready ? 'Configure Plaid credentials on this Controller.' : 'Controller ready.') };
            await this.write(c, 'status', { version: 1, ...this.status });
            this.lastPublished = this.now();
        }
    }
    private async ensureResponse(c: Config, job: Job): Promise<void> {
        const serialized = JSON.stringify(job.response);
        if (this.publishedResponses.get(job.request.id) !== serialized || !await this.app.vault.adapter.exists(this.path(c, `responses/${job.request.id}`))) {
            await this.write(c, `responses/${job.request.id}`, job.response);
            this.publishedResponses.set(job.request.id, serialized);
        }
        this.responses.set(job.request.id, job.response);
    }
    private async perform(c: Config, j: Journal, job: Job, backend: FinanceRelayBackend): Promise<void> {
        const r = job.request;
        try {
            if (job.phase === 'exchanging') {
                if (backend.hasCompleted(r.id)) {
                    job.phase = 'done';
                    job.response.state = 'complete';
                    job.response.message = 'Bank connected.';
                    j.nextSyncAt = this.now();
                }
                else {
                    job.phase = 'done';
                    job.response.state = 'uncertain';
                    job.response.message = 'Connection was interrupted while saving. Review this connection on the Controller before connecting again.';
                }
            }
            else if (!job.session && r.expiresAt < this.now() || job.session && job.session.expiresAt + RESULT_GRACE < this.now()) {
                job.phase = 'done';
                job.response.state = 'failed';
                job.response.message = 'Bank sign-in expired. Start a new connection.';
            }
            else if (r.action === 'sync' || r.action === 'disconnect') {
                job.response.state = 'working';
                job.response.message = r.action === 'sync' ? 'Syncing on the Controller…' : 'Disconnecting…';
                await this.ensureResponse(c, job);
                if (!this.active(c))
                    return;
                if (r.action === 'sync') {
                    await backend.sync();
                    j.lastSyncAt = this.now();
                    j.lastError = '';
                }
                else
                    await backend.disconnect(r.itemId!);
                job.phase = 'done';
                job.response.state = 'complete';
                job.response.message = r.action === 'sync' ? 'Finance sync complete. Notes will arrive through vault sync.' : 'Bank disconnected.';
            }
            else if (job.phase === 'queued' || job.phase === 'creating') {
                job.phase = 'creating';
                this.save(j);
                if (!this.active(c))
                    return;
                const session = await backend.createLink(r.itemId);
                if (!validHostedLink(session.url) || !Number.isFinite(session.expiresAt) || session.expiresAt <= this.now())
                    throw new Error('Invalid hosted session.');
                job.session = session;
                job.phase = 'waiting';
                job.attempts = 0;
                job.response.state = 'awaiting-user';
                job.response.url = session.url;
                job.response.message = 'Open bank sign-in, then return to Obsidian.';
            }
            else if (job.phase === 'waiting' && job.session) {
                const result = await backend.pollLink(job.session);
                if (result.state === 'cancelled') {
                    job.phase = 'done';
                    job.response.state = 'failed';
                    job.response.message = 'Bank sign-in was cancelled.';
                }
                if (result.state === 'waiting' && job.session.expiresAt < this.now()) {
                    delete job.response.url;
                    job.response.message = 'Sign-in closed. Checking for a completed connection…';
                    job.nextAttempt = this.now() + 60000;
                }
                if (result.state === 'complete') {
                    if (!this.active(c))
                        return;
                    job.phase = 'exchanging';
                    this.save(j); // Never replay an uncertain public-token exchange after a crash.
                    await backend.completeLink(job.session, result, r.id);
                    job.phase = 'done';
                    job.response.state = 'complete';
                    job.response.message = 'Bank connected.';
                    j.nextSyncAt = this.now();
                }
                job.nextAttempt = this.now() + (job.session && job.session.expiresAt < this.now() ? 60000 : 10000);
            }
        }
        catch (error) {
            if (job.phase === 'exchanging') {
                job.phase = 'done';
                job.response.state = 'uncertain';
                job.response.message = 'Connection outcome is uncertain. Review it on the Controller before connecting again.';
            }
            else if (job.phase === 'waiting' && ++job.attempts >= 5) {
                job.attempts = 0;
                job.nextAttempt = this.now() + 5 * 60000;
                job.response.message = 'Sign-in saved. Plaid is unavailable; the Controller will check again in five minutes.';
            }
            else if (job.phase !== 'waiting' && ++job.attempts >= 5) {
                job.phase = 'done';
                job.response.state = 'failed';
                job.response.message = safeError(error);
            }
            else {
                job.nextAttempt = this.now() + Math.min(60000, 2000 * 2 ** job.attempts);
                job.response.message = 'Controller will retry the request.';
            }
            j.lastError = safeError(error);
        }
        if (job.phase === 'done') {
            delete job.session;
            delete job.response.url;
            if (job.response.state === 'complete')
                j.lastError = '';
            logger.flow('FinanceRelay', 'request-finished', { action: r.action, state: job.response.state, attempts: job.attempts });
        }
        this.save(j);
        await this.ensureResponse(c, job);
        this.lastPublished = 0;
    }
}
