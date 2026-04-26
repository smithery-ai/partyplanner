"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";

export type WorkflowFrontendConfig = {
  apiBaseUrl?: string;
  managedConnectionInitializingUrl?: string;
};

export type ResolvedWorkflowFrontendConfig = {
  apiBaseUrl: string;
  managedConnectionInitializingUrl: string;
};

const defaultConfig: ResolvedWorkflowFrontendConfig = {
  apiBaseUrl: "/api",
  managedConnectionInitializingUrl: "/connection/initializing",
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
        {children}
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
