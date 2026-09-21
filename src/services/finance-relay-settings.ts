import { App, Modal, Notice, Platform, Setting } from 'obsidian';
import { FinanceRelayService } from './finance-relay';
export function renderFinanceRelaySettings(parent: HTMLElement, app: App, relay: FinanceRelayService, isController: boolean): void {
    const root = parent.createDiv({ cls: 'tps-controller-finance-settings' });
    const render = () => {
        root.empty();
        root.createEl('h3', { text: 'Finance server · This device' });
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
        const folderSetting = new Setting(root).setName('Request files folder')
            .setDesc(config?.mode === 'client' ? requestFolder : 'Keep this folder included in vault sync. After moving it, update the pairing code on your other devices.');
        if (config?.mode !== 'client') {
            folderSetting.addText(text => text.setValue(requestFolder).setPlaceholder('_system/TPS Finance Relay')
                .onChange(value => { requestFolder = value; }));
            if (config) folderSetting.addButton(button => button.setButtonText('Move files').onClick(async () => {
                button.setDisabled(true);
                try { await relay.setRequestFolder(requestFolder); render(); root.querySelector<HTMLInputElement>('input')?.focus({preventScroll:true}); }
                catch (error) { new Notice(String(error)); button.setDisabled(false); }
            }));
        } else folderSetting.addButton(button => button.setButtonText('Update pairing code').onClick(() => new PairingModal(app, relay, false, render).open()));
        new Setting(root).setName(config?.mode === 'host' ? 'This device hosts finance sync' : config ? 'Paired with the finance Controller' : 'Share one bank connection across devices')
            .setDesc(config ? status.message : 'Keep the Controller desktop and vault sync running. Pair other devices once; credentials stay on the Controller.')
            .addButton(button => button.setButtonText('Refresh status').onClick(async () => { await relay.tick(); render(); }));
        if (!config) {
            new Setting(root).setName('Host on this device').setDesc(Platform.isMobile ? 'Hosting requires a desktop. Enter its pairing code below.' : !isController ? 'Choose the Controller role in Overview to host here.' : 'Uses this device’s existing bank connections. Only choose one finance host for this vault.')
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
            new Setting(root).setName('Connect to your Controller')
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
            new Setting(root).setName('Import Apple Wallet · This device')
                .setDesc('Enable on this Controller, then enter its finance pairing code in TishOS on your iPhone and authorize Apple Card or Savings. Imported notes use your Finances property settings.')
                .addToggle(toggle => toggle.setValue(config.walletEnabled === true).onChange(value => { relay.setWalletEnabled(value); render(); }));
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
