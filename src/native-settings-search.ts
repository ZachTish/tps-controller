import type { Setting } from 'obsidian';

export interface SettingsSearchEntry {
  readonly name: string;
  readonly desc?: string;
  readonly aliases?: readonly string[];
  readonly route: string;
  readonly key?: string;
}

// Structural subset of Obsidian 1.13's public definitions; older supported hosts
// simply keep calling display(). No private search APIs or host patches.
type SearchRow = {
  name: string;
  desc?: string;
  aliases?: string[];
  searchable?: boolean;
} & ({ action: () => void; render?: never } | { action?: never; render: (setting: Setting) => void | (() => void) } | { action?: never; render?: never });
type SearchPage = { type: 'page'; name: string; desc: string; items: SearchDefinition[] };
type SearchDefinition = SearchRow | SearchPage | { type: 'group'; heading: string; items: Array<SearchRow | SearchPage> };

/** Pure metadata enumeration. The existing UI and save owners run only on open. */
export function nativeSettingsSearch(
  entries: readonly SettingsSearchEntry[],
  routes: Readonly<Record<string, string>>,
  render: (container: HTMLElement) => void | (() => void),
  open: (entry: SettingsSearchEntry) => void,
): SearchDefinition[] {
  return [
    {
      type: 'page', name: 'All settings',
      desc: 'Browse every settings area. These entries also appear in Obsidian’s built-in settings search.',
      items: Object.entries(routes).map(([route, heading]) => ({
        type: 'group', heading,
        items: entries.filter(entry => entry.route === route).map(entry => ({
          name: entry.name,
          desc: [heading, entry.desc].filter(Boolean).join(' · '),
          aliases: [...entry.aliases || [], heading],
          action: () => open(entry),
        })),
      })),
    },
    { name: '', searchable: false, render: setting => {
      setting.settingEl.empty();
      setting.settingEl.style.display = 'block';
      setting.settingEl.style.border = '0';
      setting.settingEl.style.padding = '0';
      return render(setting.settingEl.createDiv());
    } },
  ];
}

/** Focus only the selected destination; never alter preferences to reveal a row. */
export function focusSettingsSearchResult(container: HTMLElement, name: string): boolean {
  const labels = Array.from(container.querySelectorAll<HTMLElement>('.setting-item-name, h2, h3, h4, summary, strong, button'));
  const label = labels.find(el => el.textContent?.trim() === name);
  if (!label) return false;
  const row = label.closest<HTMLElement>('.setting-item') || label;
  for (let parent = row.parentElement; parent && parent !== container; parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true;
  }
  if (!row.getClientRects().length) return false;
  const target = row.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])') || label;
  if (!target.matches('input, select, textarea, button, summary')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
  row.scrollIntoView({ block: 'center' });
  return true;
}
