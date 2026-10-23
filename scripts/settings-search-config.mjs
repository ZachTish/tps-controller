export const ROUTES = {
  "overview": "Overview",
  "connections": "Connections",
  "calendar": "Calendar rules",
  "note-rules": "Note rules",
  "reminders": "Reminders",
  "automations": "Automations \u2192 Archive files",
  "advanced": "Advanced"
};
export const SOURCES = {
  "src/settings-tab.ts": {
    "route": "overview",
    "methods": {
      "renderTishOSConnections": "connections",
      "renderReminderSettingsPage": "reminders"
    },
    "conditions": {
      "activePage:overview": "overview",
      "activePage:connections": "connections",
      "activePage:calendar": "calendar",
      "activePage:note-rules": "note-rules",
      "activePage:reminders": "reminders",
      "activePage:automations": "automations",
      "activePage:advanced": "advanced"
    },
    "objects": {
      "fmKeys": {
        "label": "label",
        "route": "advanced"
      }
    }
  },
  "src/services/note-rule-ui.ts": {
    "route": "note-rules",
    "helpers": { "button": { "name": 1 } }
  }
};
export const EXTRA_ENTRIES = [];
