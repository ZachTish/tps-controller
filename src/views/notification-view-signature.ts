import type { OverdueItem } from '../types';

function itemKey(item: OverdueItem): string {
    return item.sourceKey || `${item.file.path}::${item.id || item.reminder?.id || ''}`;
}

export function buildNotificationItemsSignature(items: OverdueItem[]): string {
    return items.map((item) => [
        itemKey(item),
        item.file.path,
        item.targetKind || '',
        item.sourceType || '',
        item.title || '',
        item.taskTitle || '',
        item.noteTitle || '',
        item.icon || '',
        item.color || '',
        item.status || '',
        item.diff || '',
        item.isAllDay ? '1' : '0',
        item.snoozedUntil ?? '',
        item.nextTriggerTime ?? '',
        item.nextRuleLabel || '',
        item.isRepeating ? '1' : '0',
        item.nextReminderIntervalMinutes ?? '',
        item.reminderProperty || '',
        item.reminderPropertySource || '',
        item.reminder?.property || '',
        item.taskLine ?? '',
        item.taskRawLine || '',
    ].join('\u001f')).join('\u001e');
}
