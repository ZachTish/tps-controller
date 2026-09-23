import { App, Modal, Notice, Platform, Setting } from 'obsidian';
import { FinanceRelayService } from './finance-relay';
export function renderFinanceRelaySettings(parent: HTMLElement, app: App, relay: FinanceRelayService, isController: boolean): void {
    const root = parent.createDiv({ cls: 'tps-controller-finance-settings' });
    const render = () => {
        root.empty();
        root.createEl('h3', { text: 'Apple Card & Savings' });
        new Setting(root).setName('Import with TishOS on iPhone')
            .setDesc('Connect and run the first import in TishOS → Apple Wallet. No bank pairing code is needed.')
            .addButton(button => button.setButtonText('Open Apple Wallet').onClick(() => {
                const url = 'tishos://settings?section=apple-wallet';
                if (Platform.isMobile) window.location.assign(url); else window.open(url);
            }));
        root.createEl('h3', { text: 'Bank connections · This device' });
        let configuration: ReturnType<FinanceRelayService['getConfiguration']>;
        let status: ReturnType<FinanceRelayService['getStatus']>;
        try {
            configuration = relay.getConfiguration();
            status = relay.getStatus();
        }
        catch {
            root.createEl('p', { text: 'Finance configuration could not be read. Restore this device’s local configuration before continuing.' });
            return;
        }
        const config = configuration;
        let requestFolder = relay.getRequestFolder();
        const folderSetting = !Platform.isMobile ? new Setting(root).setName('Request files folder')
            .setDesc(config?.mode === 'client' ? requestFolder : 'Keep this folder included in vault sync. After moving it, update the pairing code on your other devices.')
            : undefined;
        if (folderSetting && config?.mode !== 'client') {
            folderSetting.addText(text => text.setValue(requestFolder).setPlaceholder('_system/TPS Finance Relay')
                .onChange(value => { requestFolder = value; }));
            if (config) folderSetting.addButton(button => button.setButtonText('Move files').onClick(async () => {
                button.setDisabled(true);
                try { await relay.setRequestFolder(requestFolder); render(); root.querySelector<HTMLInputElement>('input')?.focus({preventScroll:true}); }
                catch (error) { new Notice(String(error)); button.setDisabled(false); }
            }));
        } else if (folderSetting) folderSetting.addButton(button => button.setButtonText('Update pairing code').onClick(() => new PairingModal(app, relay, false, render).open()));
        if (Platform.isMobile && config?.mode === 'client') new Setting(root).setName('Bank pairing')
            .addButton(button => button.setButtonText('Update pairing code').onClick(() => new PairingModal(app, relay, false, render).open()));
        new Setting(root).setName(config?.mode === 'host' ? 'This device hosts finance sync' : config ? 'Paired with the finance Controller' : 'Share one bank connection across devices')
            .setDesc(config ? status.message : 'Keep the Controller desktop and vault sync running. Pair other devices once; credentials stay on the Controller.')
            .addButton(button => button.setButtonText('Refresh status').onClick(async () => { await relay.tick(); render(); }));
        if (!config) {
            if (!Platform.isMobile) new Setting(root).setName('Host on this device').setDesc(!isController ? 'Choose the Controller role in Overview to host here.' : 'Uses this device’s existing bank connections. Only choose one finance host for this vault.')
                .addButton(button => button.setButtonText('Use this Controller').setDisabled(!isController || Platform.isMobile).onClick(async () => {
                button.setDisabled(true);
                try {
                    await relay.configureHost(requestFolder);
                    render();
                }
                catch (error) {
                    new Notice(String(error));
                    button.setDisabled(false);
                }
            }));
            new Setting(root).setName('Pair bank connections').setDesc('For banks connected through your desktop Controller. Apple Wallet is set up separately above.')
                .addButton(button => button.setButtonText('Enter pairing code').onClick(() => new PairingModal(app, relay, false, render).open()));
            return;
        }
        new Setting(root).setName('Finance service · This device')
            .addToggle(toggle => toggle.setValue(config.enabled).onChange(value => { relay.setEnabled(value); render(); }));
        if (config.mode === 'host') {
            new Setting(root).setName('Automatic bank refresh · This device')
                .addDropdown(dropdown => {
                for (const [value, label] of [[0, 'Manual only'], [15, 'Every 15 minutes'], [30, 'Every 30 minutes'], [60, 'Hourly'], [360, 'Every 6 hours'], [1440, 'Daily']] as const)
                    dropdown.addOption(String(value), label);
                dropdown.setValue(String(config.intervalMinutes)).onChange(async (value) => { try {
                    await relay.setIntervalMinutes(Number(value));
                }
                catch (error) {
                    new Notice(String(error));
                } });
            });
            if (config.walletEnabled) new Setting(root).setName('Previous Wallet importer')
                .setDesc('Choose Finish setup in TishOS → Apple Wallet. This importer stops automatically before your iPhone takes over.')
                .addButton(button => button.setButtonText('Stop old importer').onClick(() => { relay.setWalletEnabled(false); render(); }));
            new Setting(root).setName('Pair another device').setDesc('The pairing code grants access to this shared finance connection. Keep it private.')
                .addButton(button => button.setButtonText('Show pairing code').onClick(() => new PairingModal(app, relay, true, render).open()));
        }
        if (config.mode === 'client')
            new Setting(root).setName('Remove this device’s pairing').addButton(button => button.setButtonText('Unpair').onClick(() => new UnpairModal(app, relay, render).open()));
        new Setting(root).setName('Connections and pending requests').addButton(button => button.setButtonText('Open Finances').onClick(() => {
            const finance = (app as any).plugins?.plugins?.['tps-finances']?.api;
            if (finance?.openConnectionSettings) {
                finance.openConnectionSettings();
                return;
            }
            const settings = (app as any).setting;
            settings?.open();
            settings?.openTabById('tps-finances');
        }));
    };
    render();
}
class PairingModal extends Modal {
    constructor(app: App, private relay: FinanceRelayService, private exporting: boolean, private refresh: () => void) { super(app); }
    onOpen(): void {
        this.titleEl.setText(this.exporting ? 'Pair another finance device' : 'Connect to finance Controller');
        const input = this.contentEl.createEl('textarea', { attr: { 'aria-label': 'Finance pairing code', rows: '5', spellcheck: 'false' } });
        input.style.width = '100%';
        input.style.resize = 'vertical';
        if (this.exporting) {
            input.value = this.relay.exportPairing();
            input.readOnly = true;
            input.addEventListener('focus', () => input.select());
        }
        new Setting(this.contentEl).addButton(button => button.setButtonText(this.exporting ? 'Copy code' : 'Pair this device').setCta().onClick(async () => {
            button.setDisabled(true);
            try {
                if (this.exporting) {
                    await navigator.clipboard.writeText(input.value);
                    new Notice('Pairing code copied.');
                }
                else {
                    await this.relay.importPairing(input.value);
                    input.value = '';
                    this.close();
                    this.refresh();
                }
            }
            catch (error) {
                new Notice(String(error));
            }
            finally {
                button.setDisabled(false);
            }
        }));
    }
    onClose(): void { this.contentEl.empty(); }
}
class UnpairModal extends Modal {
    constructor(app: App, private relay: FinanceRelayService, private refresh: () => void) { super(app); }
    onOpen(): void {
        this.titleEl.setText('Unpair this device?');
        this.contentEl.createEl('p', { text: 'Bank connections and notes stay on the Controller. Requests already sent may still finish.' });
        new Setting(this.contentEl).addButton(button => button.setButtonText('Cancel').onClick(() => this.close()))
            .addButton(button => button.setButtonText('Unpair').setWarning().onClick(async () => { button.setDisabled(true); try {
            await this.relay.unpairClient();
            this.close();
            this.refresh();
        }
        catch (error) {
            new Notice(String(error));
            button.setDisabled(false);
        } }));
    }
}
