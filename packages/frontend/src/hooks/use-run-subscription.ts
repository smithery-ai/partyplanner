"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useWorkflowFrontendConfig } from "../config";
import type { RunStateDocument } from "../types";
import { applyRunStateToCache, runStateDocumentToResult } from "./use-workflow";

export type RunSubscriptionStatus =
  | "pending"
  | "connected"
  | "closed"
  | "failed";

export type RunSubscriptionState = {
  status: RunSubscriptionStatus;
  serverDriving: boolean;
};

export function useRunSubscription(
  runId: string | undefined,
): RunSubscriptionState {
  const config = useWorkflowFrontendConfig();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<RunSubscriptionStatus>("pending");

  useEffect(() => {
    if (!runId) {
      setStatus("pending");
      return;
    }
    const wsUrl = subscribeUrl(config.apiBaseUrl, runId);
    if (!wsUrl) {
      setStatus("failed");
      return;
    }

    let cancelled = false;
    let everConnected = false;
    setStatus("pending");

    let socket: WebSocket | null = null;
    try {
      socket = new WebSocket(wsUrl);
    } catch {
      setStatus("failed");
      return;
    }

    socket.addEventListener("open", () => {
      if (cancelled) return;
      everConnected = true;
      setStatus("connected");
    });
    socket.addEventListener("message", (event) => {
      if (cancelled) return;
      const data = parseMessage(event.data);
      if (!data) return;
      applyRunStateToCache(
        queryClient,
        config.apiBaseUrl,
        runStateDocumentToResult(data),
      );
    });
    socket.addEventListener("close", () => {
      if (cancelled) return;
      setStatus(everConnected ? "closed" : "failed");
    });
    socket.addEventListener("error", () => {
      if (cancelled) return;
      setStatus(everConnected ? "closed" : "failed");
    });

    return () => {
      cancelled = true;
      try {
        socket?.close();
      } catch {
        // ignore
      }
    };
  }, [runId, config.apiBaseUrl, queryClient]);

  return {
    status,
    serverDriving: status === "pending" || status === "connected",
  };
}

function subscribeUrl(apiBaseUrl: string, runId: string): string | undefined {
  const base = apiBaseUrl.replace(/\/+$/, "");
  const path = `${base}/runs/${encodeURIComponent(runId)}/subscribe`;
  if (path.startsWith("http://")) return `ws://${path.slice("http://".length)}`;
  if (path.startsWith("https://"))
    return `wss://${path.slice("https://".length)}`;
  if (typeof window === "undefined") return undefined;
  const origin = window.location.origin;
  const wsOrigin = origin.startsWith("https://")
    ? `wss://${origin.slice("https://".length)}`
    : `ws://${origin.slice("http://".length)}`;
  return `${wsOrigin}${path.startsWith("/") ? path : `/${path}`}`;
}

function parseMessage(raw: unknown): RunStateDocument | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw) as RunStateDocument;
  } catch {
    return undefined;
  }
}
