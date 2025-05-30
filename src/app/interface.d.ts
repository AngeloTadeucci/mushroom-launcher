import { ServerEntry } from "./config";

export interface IElectronAPI {
    getAppVersion: () => Promise<string>;
    getAppConfig: () => Promise<AppConfig>;
    saveAppConfig: () => Promise<void>;
    getAppDataPath: () => Promise<string>;

    setLanguage: (lang: string) => Promise<void>;
    setClientPath: (path: string) => Promise<void>;
    setEnableConsole: (enable: boolean) => Promise<void>;
    setAutoLogin: (enable: boolean) => Promise<void>;
    setAudioEnabled: (enable: boolean) => Promise<void>;
    setAudioVolume: (volume: number) => Promise<void>;

    loadTranslation: (
        lng: string,
        ns: string,
    ) => Promise<Record<string, string>>;

    openFolder: (path: string) => Promise<void>;
    openClientDialog: () => Promise<string | null>;

    getDownloadProgress: () => Promise<number>;
    getDownloadFile: () => Promise<string>;
    getDownloadEta: () => Promise<number>;
    downloadClient: (provider: string) => Promise<void>;

    getServerList: () => Promise<ServerEntry[]>;
    getOnlineStatus: (serverId: string) => Promise<boolean>;
    removeServer: (id: string) => Promise<boolean>;
    addServer: (entry: Partial<ServerEntry>) => Promise<boolean>;
    editServer: (entry: Partial<ServerEntry>) => Promise<boolean>;

    launchClient: (serverId: string) => Promise<[boolean, string]>;

    getClientMods: () => Promise<ModEntry[]>;
    disableMod: (id: string) => Promise<boolean>;
    enableMod: (id: string) => Promise<boolean>;

    /**
     * Event handlers
     */
    send: (channel: string, data: any) => void;
    on: (channel: string, func: (...args: any[]) => any) => () => void;
}

declare global {
    interface Window {
        electron: IElectronAPI;
    }
}
