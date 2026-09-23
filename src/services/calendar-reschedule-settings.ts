import { Notice, Setting } from 'obsidian';
import type { CalendarRescheduleAction, ExternalCalendarConfig } from '../types';
import { calendarRescheduleUpdates } from './calendar-reschedule-actions';

/** Draft editing never changes a running sync or writes note properties. */
export function renderCalendarRescheduleActions(container: HTMLElement, calendar: ExternalCalendarConfig, save: () => Promise<void>): void {
    const root = container.createDiv({ cls: 'tps-controller-reschedule-actions' });
    root.createEl('h4', { text: 'On external reschedule' });
    root.createEl('p', { text: 'Native event notes only. Set a property once when the feed changes the start, end, or all-day timing. Existing keys are updated; missing keys are added. Retained old-note actions require Keep old note. Local edits, first sync, and title-only changes do not trigger these actions.' });
    let baseline = JSON.stringify(calendar.rescheduleActions || []);
    let draft: CalendarRescheduleAction[] = Array.isArray(calendar.rescheduleActions) ? JSON.parse(baseline) : [];
    let saving = false;
    const actions = root.createDiv();
    const rows = root.createDiv();
    const status = root.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } });
    const render = () => {
        rows.empty();
        draft.forEach((action, index) => {
            const row = rows.createDiv({ cls: 'tps-controller-reschedule-action' });
            new Setting(row).setName(`Property update ${index + 1}`)
                .addDropdown(drop => {
                    drop.selectEl.setAttribute('aria-label', `Target note ${index + 1}`);
                    drop.addOption('previous', 'Retained old note').addOption('current', 'Current note')
                        .setValue(action.target).onChange(value => action.target = value as CalendarRescheduleAction['target']);
                })
                .addExtraButton(button => button.setIcon('trash').setTooltip(`Remove property update ${index + 1}`)
                    .onClick(() => { draft.splice(index, 1); render(); addButton?.focus(); }));
            new Setting(row).setName('Property').addText(text => {
                text.inputEl.setAttribute('aria-label', `Property key ${index + 1}`);
                text.setPlaceholder('status').setValue(action.key).onChange(value => action.key = value);
            });
            new Setting(row).setName('Value').setDesc('Text, number, true/false, or a JSON list of text. Identity, timing, recurrence and provider-owned fields are protected.')
                .addText(text => {
                    text.inputEl.setAttribute('aria-label', `Property value ${index + 1}`);
                    text.setPlaceholder('rescheduled').setValue(action.value).onChange(value => action.value = value);
                });
        });
    };
    let addButton: HTMLButtonElement | undefined;
    new Setting(actions).setName('Reschedule properties')
        .addButton(button => {
            addButton = button.buttonEl;
            button.setButtonText('Add property update').onClick(() => {
                if (saving || draft.length >= 30) return;
                draft.push({ target: 'previous', key: '', value: '' });
                render();
                rows.querySelectorAll<HTMLInputElement>('input')[Math.max(0, (draft.length - 1) * 2)]?.focus();
            });
        })
        .addButton(button => button.setButtonText('Save property updates').onClick(async () => {
            if (saving) return;
            try {
                if (JSON.stringify(calendar.rescheduleActions || []) !== baseline) throw new Error('Calendar actions changed. Reopen this calendar before saving.');
                calendarRescheduleUpdates(draft, 'previous');
                calendarRescheduleUpdates(draft, 'current');
                saving = true;
                button.setDisabled(true);
                const previous = calendar.rescheduleActions;
                calendar.rescheduleActions = draft.map(action => ({ ...action, key: action.key.trim() }));
                try { await save(); } catch (error) { calendar.rescheduleActions = previous; throw error; }
                baseline = JSON.stringify(calendar.rescheduleActions);
                draft = JSON.parse(baseline);
                render();
                status.textContent = 'Saved. Applies on the next external reschedule after a baseline sync.';
            } catch (error) {
                status.textContent = error instanceof Error ? error.message : 'Unable to save reschedule properties.';
                new Notice(status.textContent);
            } finally { saving = false; button.setDisabled(false); }
        }));
    render();
}
