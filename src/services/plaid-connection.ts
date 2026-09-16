import { App, requestUrl, SecretComponent, Setting } from 'obsidian';

type Environment = 'sandbox' | 'development' | 'production';
export interface PlaidConfiguration {
    plaidEnvironment: Environment;
    plaidClientIdSecret: string;
    plaidSecretSecret: string;
    oauthRedirectUri: string;
}
const KEY = 'tps-controller-plaid-v1';
const HOSTS = {sandbox:'https://sandbox.plaid.com',development:'https://development.plaid.com',production:'https://production.plaid.com'};
const PATHS = new Set(['/link/token/create','/item/public_token/exchange','/item/remove','/accounts/get','/transactions/sync','/investments/holdings/get','/investments/transactions/get']);
export class PlaidConnectionService {
    readonly version = 1;
    constructor(private app: App) {}
    getConfiguration(legacy?: Partial<PlaidConfiguration>): PlaidConfiguration {
        const stored = this.app.loadLocalStorage(KEY);
        const raw = stored ?? legacy ?? {};
        const config: PlaidConfiguration = {
            plaidEnvironment: raw.plaidEnvironment === 'production' || raw.plaidEnvironment === 'development' ? raw.plaidEnvironment : 'sandbox',
            plaidClientIdSecret: String(raw.plaidClientIdSecret || 'tps-finances-plaid-client-id'),
            plaidSecretSecret: String(raw.plaidSecretSecret || 'tps-finances-plaid-secret'),
            oauthRedirectUri: String(raw.oauthRedirectUri || ''),
        };
        // Import references once, never secret values or another device's state.
        if (stored == null && legacy) this.app.saveLocalStorage(KEY, config);
        return config;
    }
    saveConfiguration(config: PlaidConfiguration): void { this.app.saveLocalStorage(KEY, config); }
    inspect(clientRef?: string, secretRef?: string) {
        const config = this.getConfiguration();
        const client = this.app.secretStorage.getSecret(clientRef || config.plaidClientIdSecret)?.trim() || '';
        const secret = this.app.secretStorage.getSecret(secretRef || config.plaidSecretSecret)?.trim() || '';
        const conflicting = Boolean(client && secret && client === secret) || (clientRef || config.plaidClientIdSecret) === (secretRef || config.plaidSecretSecret);
        return {state: conflicting ? 'conflicting-credentials' : client && secret ? 'ready' : 'missing-credentials', clientIdConfigured: Boolean(client), secretConfigured: Boolean(secret)};
    }
    async request(environment: Environment, path: string, body: Record<string, unknown>, clientRef?: string, secretRef?: string) {
        if (!Object.prototype.hasOwnProperty.call(HOSTS, environment) || !PATHS.has(path)) throw new Error('Unsupported Plaid operation.');
        const config = this.getConfiguration();
        if (this.inspect(clientRef, secretRef).state !== 'ready') throw new Error('Configure separate Plaid client ID and secret in TPS Controller → Advanced → Plaid.');
        return requestUrl({url:HOSTS[environment]+path, method:'POST', headers:{'Content-Type':'application/json','Plaid-Version':'2020-09-14',
            'PLAID-CLIENT-ID':this.app.secretStorage.getSecret(clientRef || config.plaidClientIdSecret)!.trim(),
            'PLAID-SECRET':this.app.secretStorage.getSecret(secretRef || config.plaidSecretSecret)!.trim()},body:JSON.stringify(body),throw:false});
    }
}
export function renderPlaidConnectionSettings(container: HTMLElement, app: App, service: PlaidConnectionService): void {
    container.createEl('h3', {text:'Plaid · This device'});
    const config = service.getConfiguration();
    new Setting(container).setName('Environment · This device').addDropdown(dropdown => dropdown.addOption('sandbox','Sandbox').addOption('development','Development').addOption('production','Production').setValue(config.plaidEnvironment).onChange(value => { config.plaidEnvironment = value as Environment; service.saveConfiguration(config); }));
    for (const [key,label] of [['plaidClientIdSecret','Plaid client ID'],['plaidSecretSecret','Plaid secret']] as const) {
        new Setting(container).setName(`${label} · This device`).addComponent(el => new SecretComponent(app,el).setValue(config[key]).onChange(value => { config[key] = value; service.saveConfiguration(config); }));
    }
    new Setting(container).setName('OAuth redirect URI · This device').addText(text => text.setValue(config.oauthRedirectUri).onChange(value => {config.oauthRedirectUri=value.trim();service.saveConfiguration(config);}));
    new Setting(container).setName('Accounts and transactions').setDesc('Manage institutions, sync, and ledger records in TPS Finances.').addButton(button => button.setButtonText('Open Finances settings').onClick(() => {const settings=(app as any).setting;settings?.open();settings?.openTabById('tps-finances');}));
}
