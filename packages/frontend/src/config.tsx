"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";
import { LocalApiStreamProvider } from "./local-api-stream";

export type WorkflowFrontendConfig = {
  apiBaseUrl?: string;
  localApiBaseUrl?: string;
  managedConnectionInitializingUrl?: string;
  additionalInputs?: Record<string, unknown>;
  prepareExternalActionUrl?: (url: string) => Promise<void>;
  secretValues?: Record<string, string>;
};

export type ResolvedWorkflowFrontendConfig = {
  apiBaseUrl: string;
  localApiBaseUrl: string;
  managedConnectionInitializingUrl: string;
  additionalInputs: Record<string, unknown>;
  prepareExternalActionUrl?: (url: string) => Promise<void>;
  secretValues: Record<string, string>;
};

const defaultConfig: ResolvedWorkflowFrontendConfig = {
  apiBaseUrl: "/api",
  localApiBaseUrl: "https://local-api.localhost",
  managedConnectionInitializingUrl: "/connection/initializing",
  additionalInputs: {},
  secretValues: {},
};

const WorkflowFrontendConfigContext =
  createContext<ResolvedWorkflowFrontendConfig>(defaultConfig);

export function WorkflowFrontendProvider({
  config,
  children,
}: {
  config?: WorkflowFrontendConfig;
  children: ReactNode;
}) {
  const value = useMemo<ResolvedWorkflowFrontendConfig>(() => {
    return {
      ...defaultConfig,
      ...config,
      apiBaseUrl: normalizeApiBaseUrl(config?.apiBaseUrl ?? "/api"),
      localApiBaseUrl: config?.localApiBaseUrl ?? defaultConfig.localApiBaseUrl,
      managedConnectionInitializingUrl:
        config?.managedConnectionInitializingUrl ??
        defaultConfig.managedConnectionInitializingUrl,
    };
  }, [config]);

  return (
    <WorkflowFrontendConfigContext.Provider value={value}>
      {children}
    </WorkflowFrontendConfigContext.Provider>
  );
}

export function WorkflowFrontendRoot({
  config,
  children,
}: {
  config?: WorkflowFrontendConfig;
  children: ReactNode;
}) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <WorkflowFrontendProvider config={config}>
        <LocalApiStreamProvider>{children}</LocalApiStreamProvider>
      </WorkflowFrontendProvider>
    </QueryClientProvider>
  );
}

export function useWorkflowFrontendConfig(): ResolvedWorkflowFrontendConfig {
  return useContext(WorkflowFrontendConfigContext);
}

function normalizeApiBaseUrl(apiBaseUrl: string): string {
  const trimmed = apiBaseUrl.trim();
  if (!trimmed || trimmed === "/") return "";
  const suffixIndex = trimmed.search(/[?#]/);
  if (suffixIndex !== -1) {
    return `${trimmed.slice(0, suffixIndex).replace(/\/+$/, "")}${trimmed.slice(suffixIndex)}`;
  }
  return trimmed.replace(/\/+$/, "");
}
