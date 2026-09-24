import { App, Setting } from 'obsidian';

export type ConnectionSection = 'finance' | 'ai' | 'health' | 'tishos';
export const CONNECTION_SECTIONS = [
    { id: 'finance', label: 'Banks & Wallet', pluginId: 'tps-finances', minimum: '1.9.0', name: 'TPS Finances' },
    { id: 'ai', label: 'AI', pluginId: 'tps-ai-gateway', minimum: '0.10.0', name: 'TPS AI Gateway' },
    { id: 'tishos', label: 'TishOS devices', pluginId: 'tps-controller', minimum: '2.6.0', name: 'TPS Controller' },
    { id: 'health', label: 'Food databases', pluginId: 'tps-health', minimum: '3.4.0', name: 'TPS Health' },
] as const;
export function connectionSection(value: unknown): ConnectionSection {
    return CONNECTION_SECTIONS.some(section => section.id === value) ? value as ConnectionSection : 'finance';
}
/** Provider editors retain their existing persistence and validated operations. No credential copying. */
export function mountConnectionSettings(app: App, parent: HTMLElement, section: ConnectionSection): () => void {
    const entry = CONNECTION_SECTIONS.find(item => item.id === section)!;
    const panel = (app as any).plugins?.plugins?.[entry.pluginId]?.api?.connectionSettings;
    if (panel?.version !== 1 || typeof panel.render !== 'function') {
        new Setting(parent).setName(entry.name)
            .setDesc(`Enable ${entry.name} ${entry.minimum} or newer to configure this connection here. Existing configuration is preserved.`)
            .addButton(button => button.setButtonText('Open community plugins').onClick(() => {
                const settings = (app as any).setting;
                settings?.open(); settings?.openTabById('community-plugins');
            }));
        return () => {};
    }
    try {
        const dispose = panel.render(parent);
        return typeof dispose === 'function' ? dispose : () => {};
    } catch {
        parent.empty();
        parent.createEl('p', { text: `${entry.name} connection settings could not be loaded. Reopen settings after reloading the plugin.`, attr: {role: 'alert'} });
        return () => {};
    }
}
