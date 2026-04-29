import { contextBridge, ipcRenderer } from "electron";
import {
  AUTH_CHANNELS,
  type AuthChangePayload,
  type AuthIpcResult,
  type AuthUser,
} from "../shared/auth";

type HyloAuthApi = {
  signIn: () => Promise<AuthIpcResult>;
  signOut: () => Promise<AuthIpcResult>;
  switchToOrganization: (organizationId: string) => Promise<AuthIpcResult>;
  getUser: () => Promise<AuthUser | null>;
  getAccessToken: () => Promise<string>;
  getOrganizationId: () => Promise<string | null>;
  onAuthChange: (callback: (payload: AuthChangePayload) => void) => () => void;
};

const hyloAuth: HyloAuthApi = {
  signIn: () => ipcRenderer.invoke(AUTH_CHANNELS.SIGN_IN),
  signOut: () => ipcRenderer.invoke(AUTH_CHANNELS.SIGN_OUT),
  switchToOrganization: (organizationId) =>
    ipcRenderer.invoke(AUTH_CHANNELS.SWITCH_TO_ORGANIZATION, organizationId),
  getUser: () => ipcRenderer.invoke(AUTH_CHANNELS.GET_USER),
  getAccessToken: () => ipcRenderer.invoke(AUTH_CHANNELS.GET_ACCESS_TOKEN),
  getOrganizationId: () =>
    ipcRenderer.invoke(AUTH_CHANNELS.GET_ORGANIZATION_ID),
  onAuthChange: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: AuthChangePayload,
    ): void => callback(payload);
    ipcRenderer.on(AUTH_CHANNELS.ON_AUTH_CHANGE, listener);
    return () => {
      ipcRenderer.removeListener(AUTH_CHANNELS.ON_AUTH_CHANGE, listener);
    };
  },
};

contextBridge.exposeInMainWorld("hyloAuth", hyloAuth);
