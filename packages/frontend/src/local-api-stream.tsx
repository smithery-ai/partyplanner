"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { useWorkflowFrontendConfig } from "./config";

export type LocalApiStreamMessage = { type: string } & Record<string, unknown>;
export type LocalApiStreamHandler = (message: LocalApiStreamMessage) => void;

type Subscribe = (handler: LocalApiStreamHandler) => () => void;

const LocalApiStreamContext = createContext<Subscribe | null>(null);

export function LocalApiStreamProvider({ children }: { children: ReactNode }) {
  const { localApiBaseUrl } = useWorkflowFrontendConfig();
  const handlersRef = useRef(new Set<LocalApiStreamHandler>());

  useEffect(() => {
    let closed = false;
    let reconnectTimer: number | null = null;
    let ws: WebSocket | null = null;

    const dispatch = (text: string) => {
      let message: LocalApiStreamMessage;
      try {
        message = JSON.parse(text) as LocalApiStreamMessage;
      } catch {
        return;
      }
      for (const handler of handlersRef.current) {
        try {
          handler(message);
        } catch (err) {
          console.error("local-api stream handler threw:", err);
        }
      }
    };

    const connect = () => {
      const wsUrl = `${localApiBaseUrl.replace(/^http/, "ws")}/api/stream`;
      const socket = new WebSocket(wsUrl);
      ws = socket;

      socket.addEventListener("message", (event) => {
        const raw: unknown = event.data;
        if (raw instanceof Blob) {
          void raw.text().then(dispatch);
          return;
        }
        dispatch(typeof raw === "string" ? raw : String(raw));
      });
      socket.addEventListener("close", () => {
        if (ws === socket) ws = null;
        if (closed) return;
        reconnectTimer = window.setTimeout(connect, 1000);
      });
      socket.addEventListener("error", () => socket.close());
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
      ws?.close();
      ws = null;
    };
  }, [localApiBaseUrl]);

  const subscribe = useMemo<Subscribe>(() => {
    const handlers = handlersRef.current;
    return (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    };
  }, []);

  return (
    <LocalApiStreamContext.Provider value={subscribe}>
      {children}
    </LocalApiStreamContext.Provider>
  );
}

export function useLocalApiStream(handler: LocalApiStreamHandler): void {
  const subscribe = useContext(LocalApiStreamContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!subscribe) return;
    return subscribe((message) => handlerRef.current(message));
  }, [subscribe]);
}
