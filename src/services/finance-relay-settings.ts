import { Platform, Setting } from 'obsidian';
export function renderWalletSetupEntry(parent: HTMLElement): void {
    new Setting(parent).setName('Apple Card & Savings')
        .setDesc('Connect in TishOS on your iPhone to import automatically. Requires TishOS 0.18.2 or newer.')
        .addButton(button => button.setButtonText('Connect Apple Wallet').setCta().onClick(() => {
            const url = 'tishos://settings?section=apple-wallet';
            if (Platform.isMobile) window.location.assign(url); else window.open(url);
        }));
}

export function renderFinanceImportRetirement(parent: HTMLElement): void {
    parent.createEl('p', { text: 'Bank importing and the finance relay are retired in Controller. Configure importing in TishOS. Existing connections, mappings, pending requests and notes are unchanged.' });
}
