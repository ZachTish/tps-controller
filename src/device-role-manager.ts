import { App } from "obsidian";

export type DeviceRole = "controller" | "user";

export class DeviceRoleManager {
    private app: App;
    private storageKey: string;
    private _currentRole: DeviceRole = "user";
    private onRoleChange?: (role: DeviceRole) => void;

    constructor(app: App, onRoleChange?: (role: DeviceRole) => void) {
        this.app = app;
        // Use vault name to scope local storage. 
        this.storageKey = `tps-device-role-${this.app.vault.getName()}`;
        this.onRoleChange = onRoleChange;
        this.loadRole();
    }

    private loadRole() {
        const stored = window.localStorage.getItem(this.storageKey);
        if (stored === "controller" || stored === "user") {
            this._currentRole = stored;
        } else {
            // New device or undefined state: Default to Passive Replica
            this._currentRole = "user";
            window.localStorage.setItem(this.storageKey, "user");
            console.log("[TPS Controller] New device detected. Defaulting to 'user' (Passive).");
        }
        console.log(`[TPS Controller] Device Role initialized: ${this._currentRole}`);
    }

    public get role(): DeviceRole {
        return this._currentRole;
    }

    public isController(): boolean {
        return this._currentRole === "controller";
    }

    public setRole(role: DeviceRole) {
        this._currentRole = role;
        window.localStorage.setItem(this.storageKey, role);
        console.log(`[TPS Controller] Device role set to: ${role}`);
        if (this.onRoleChange) {
            this.onRoleChange(role);
        }
    }
}
