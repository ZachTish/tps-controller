/**
 * type-guards.ts — Safe typed accessors for Obsidian's private plugin registry.
 *
 * Replaces scattered `(app as any).plugins` casts with a narrow typed interface
 * and a single lookup path that handles both `.getPlugin()` and direct map access.
 */
import type { App, Plugin } from 'obsidian';

// ── Typed internal-app interfaces ────────────────────────────────────────────

interface AppWithPluginsRegistry extends App {
    plugins?: {
        getPlugin?: (id: string) => Plugin | null;
        plugins?: Record<string, Plugin>;
        enabledPlugins?: Set<string> | string[];
    };
}

interface AppWithCommands extends App {
    commands?: {
        executeCommandById?: (id: string) => boolean;
        findCommand?: (id: string) => unknown;
    };
}

// ── Plugin registry ───────────────────────────────────────────────────────────

/**
 * Look up a community plugin by its manifest ID.
 * Returns null when the plugin is not installed or not yet loaded.
 */
export function getPluginById<T extends Plugin = Plugin>(
    app: App,
    pluginId: string,
): T | null {
    const reg = app as AppWithPluginsRegistry;

    // Prefer the public registry method
    const direct = reg.plugins?.getPlugin?.(pluginId);
    if (direct) return direct as T;

    // Fall back to the internal map (covers plugins that bypass getPlugin)
    return (reg.plugins?.plugins?.[pluginId] as T) ?? null;
}

/**
 * Check whether a community plugin is currently enabled.
 * Uses the `enabledPlugins` set / array when available; falls back to a live lookup.
 */
export function isPluginEnabled(app: App, pluginId: string): boolean {
    const reg = app as AppWithPluginsRegistry;
    const enabled = reg.plugins?.enabledPlugins;

    if (enabled instanceof Set) return enabled.has(pluginId);
    if (Array.isArray(enabled)) return enabled.includes(pluginId);

    // Final fallback — try a live lookup
    return !!reg.plugins?.getPlugin?.(pluginId);
}

/**
 * Retrieve the settings object of a community plugin.
 * Returns an empty record when the plugin or its settings are unavailable.
 */
export function getPluginSettings<T extends Record<string, unknown> = Record<string, unknown>>(
    app: App,
    pluginId: string,
): T {
    const plugin = getPluginById(app, pluginId);
    const settings = (plugin as any)?.settings;
    return (settings && typeof settings === 'object' ? settings : {}) as T;
}

// ── Command registry ──────────────────────────────────────────────────────────

/**
 * Execute a registered Obsidian command by its full ID.
 * Returns false if the command is not found or throws.
 */
export function executeCommandById(app: App, commandId: string): boolean {
    const withCommands = app as AppWithCommands;
    try {
        return withCommands.commands?.executeCommandById?.(commandId) ?? false;
    } catch {
        return false;
    }
}

/**
 * Returns true when a command with `commandId` is registered.
 */
export function hasCommand(app: App, commandId: string): boolean {
    const withCommands = app as AppWithCommands;
    try {
        return Boolean(withCommands.commands?.findCommand?.(commandId));
    } catch {
        return false;
    }
}

// ── General type guards ───────────────────────────────────────────────────────

/** Returns true when `value` is a non-null, non-array object (i.e., a plain record). */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
