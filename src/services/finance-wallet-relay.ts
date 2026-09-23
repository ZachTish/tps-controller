/** FinanceKit mailbox. Content is encrypted by the owning FinanceRelayService. */
export interface WalletReceipt {
    version: 1;
    producerId: string;
    sequence: number;
    batchId: string;
    digest: string;
    complete: boolean;
}
export interface WalletManifest {
    version: 1;
    producerId: string;
    sequence: number;
    batchId: string;
    parts: string[];
}
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export interface WalletLocalOwner { version: 1; producerId: string; requestId: string; }
export function walletLocalOwner(value: unknown): WalletLocalOwner {
    const r = value as WalletLocalOwner;
    if (!r || r.version !== 1 || !id(r.producerId) || !id(r.requestId)) throw new Error('Invalid Wallet handoff.');
    return {version: 1, producerId: r.producerId, requestId: r.requestId};
}
/** Called in the same exclusive queue as legacy Wallet writes, even if bank refresh is paused. */
export async function retireWalletImporter(io: {
    read(name: string): Promise<unknown | null>;
    write(name: string, value: unknown): Promise<void>;
    owner(): WalletLocalOwner | undefined;
    previousProducer(): string | undefined;
    retire(owner: WalletLocalOwner): void;
    active(): boolean;
}): Promise<void> {
    const raw = await io.read('wallet/local-import');
    if (raw === null || !io.active()) return;
    const request = walletLocalOwner(raw), owner = io.owner(), previous = io.previousProducer();
    if ((owner && (owner.producerId !== request.producerId || owner.requestId !== request.requestId)) || (previous && previous !== request.producerId))
        throw new Error('Wallet handoff belongs to another connection.');
    if (!owner) io.retire(request); // Durable stop precedes acknowledgement, including after a crash.
    const saved = io.owner();
    if (!io.active() || !saved || saved.producerId !== request.producerId || saved.requestId !== request.requestId)
        throw new Error('Wallet retirement was not saved.');
    const receipt = await io.read('wallet/local-import-receipt') as (WalletLocalOwner & {complete: boolean}) | null;
    if (receipt?.version === 1 && receipt.complete === true && receipt.producerId === request.producerId && receipt.requestId === request.requestId) return;
    if (io.active()) await io.write('wallet/local-import-receipt', {...request, complete: true});
}
export async function walletDigest(value: unknown): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)));
    return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export function walletReceipt(value: unknown): WalletReceipt | null {
    if (value === null) return null;
    const r = value as WalletReceipt;
    if (!r || r.version !== 1 || !id(r.producerId) || !id(r.batchId) || !Number.isSafeInteger(r.sequence) || r.sequence < 1 || !hash(r.digest) || typeof r.complete !== 'boolean') throw new Error('Wallet receipt is invalid. Restore the Controller’s local finance state.');
    return r;
}
export function walletManifest(value: unknown): WalletManifest {
    const m = value as WalletManifest;
    if (!m || m.version !== 1 || !id(m.producerId) || !id(m.batchId) || !Number.isSafeInteger(m.sequence) || m.sequence < 1 || !Array.isArray(m.parts) || !m.parts.length || m.parts.length > 128 || !m.parts.every(hash)) throw new Error('Wallet transfer manifest is invalid.');
    return m;
}
/** The caller serializes this with bank sync and pins the host/pairing throughout. */
export async function reconcileWallet(io: {
    read(name: string): Promise<unknown | null>;
    write(name: string, value: unknown): Promise<void>;
    load(): WalletReceipt | null;
    save(value: WalletReceipt): void;
    active(): boolean;
    importParts(parts: unknown[]): Promise<void>;
}): Promise<void> {
    const value = await io.read('wallet/pending');
    if (value === null || !io.active()) return;
    const m = walletManifest(value);
    const digest = await walletDigest(m);
    const prior = walletReceipt(io.load());
    if (prior) {
        if (prior.producerId !== m.producerId) throw new Error('Wallet is paired with another iPhone. Restore that phone’s connection before importing.');
        if (prior.sequence === m.sequence && (prior.batchId !== m.batchId || prior.digest !== digest)) throw new Error('Wallet transfer identity changed. No replacement was imported.');
        if (prior.complete && prior.sequence === m.sequence) {
            await io.write('wallet/receipt', prior);
            return;
        }
        if (m.sequence !== prior.sequence + (prior.complete ? 1 : 0)) throw new Error('Wallet transfer is out of order. Resume the pending transfer on the iPhone.');
    } else if (m.sequence !== 1) throw new Error('Wallet import history is missing. Restore this Controller’s state.');
    const parts: unknown[] = [];
    for (let i = 0; i < m.parts.length; i++) {
        const part = await io.read(`wallet/${m.batchId}/${i}`);
        // Parts are canonical JSON strings, so Swift/JavaScript object ordering cannot change the hash.
        if (part === null) return; // File sync may deliver the manifest before its parts.
        if (typeof part !== 'string') throw new Error('Wallet transfer part is invalid.');
        if (await walletDigest(part) !== m.parts[i]) throw new Error('Wallet transfer verification failed.');
        parts.push(JSON.parse(part));
    }
    const reread = await io.read('wallet/pending');
    if (!io.active() || await walletDigest(reread) !== digest) return;
    const claimed: WalletReceipt = {version: 1, producerId: m.producerId, sequence: m.sequence, batchId: m.batchId, digest, complete: false};
    io.save(claimed); // Persist before the first note mutation; retry only this exact batch.
    await io.importParts(parts);
    if (!io.active()) return;
    const receipt = {...claimed, complete: true};
    io.save(receipt);
    await io.write('wallet/receipt', receipt);
}
