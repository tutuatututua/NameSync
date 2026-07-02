"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { WsServerMessageSchema, type WsServerMessage } from "@extensions/contract";
import { WS_BASE_URL, API_BASE_URL } from "@/app/utils/config";

export type SocketStatus = "connecting" | "connected" | "polling" | "closed";

type CompleteMsg = Extract<WsServerMessage, { type: "comparison_complete" }>;

interface Options {
  enabled?: boolean;
  onMessage?: (msg: WsServerMessage) => void;
  onComplete?: (msg: CompleteMsg) => void;
  onFailed?: (msg: WsServerMessage) => void;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1500;
const POLL_INTERVAL_MS = 3000;

/**
 * One reusable comparison-progress socket. Keyed ONLY on sessionId, with callbacks
 * held in a ref so the socket is never torn down by unrelated parent re-renders
 * (fixes H7). Retries with backoff, then falls back to polling GET /results
 * (fixes M4). Every frame is parsed with the shared zod union via safeParse, so a
 * malformed/unknown frame is ignored rather than throwing.
 */
export function useComparisonSocket(sessionId: string | null, opts: Options = {}) {
  const { enabled = true } = opts;
  const [status, setStatus] = useState<SocketStatus>("connecting");

  const cbRef = useRef(opts);
  cbRef.current = opts;

  const wsRef = useRef<WebSocket | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retriesRef = useRef(0);
  const closedRef = useRef(false);

  const handleFrame = useCallback((raw: string) => {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = WsServerMessageSchema.safeParse(data);
    if (!parsed.success) return;
    const msg = parsed.data;
    cbRef.current.onMessage?.(msg);
    if (msg.type === "comparison_complete") cbRef.current.onComplete?.(msg);
    if (msg.type === "comparison_failed" || msg.type === "processing_failed") cbRef.current.onFailed?.(msg);
  }, []);

  const startPolling = useCallback((sid: string) => {
    if (pollRef.current) return;
    setStatus("polling");
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/comparisons/${sid}/results`);
        if (!res.ok) return;
        const json = await res.json();
        if (json?.data?.status === "completed") {
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
          cbRef.current.onComplete?.({
            type: "comparison_complete",
            sessionId: sid,
            totalRecords: json.data.rowCount ?? 0,
          });
        }
      } catch {
        /* keep polling */
      }
    }, POLL_INTERVAL_MS);
  }, []);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    closedRef.current = false;
    retriesRef.current = 0;

    const connect = () => {
      if (closedRef.current) return;
      setStatus("connecting");
      let ws: WebSocket;
      try {
        ws = new WebSocket(`${WS_BASE_URL}?sessionId=${encodeURIComponent(sessionId)}`);
      } catch {
        startPolling(sessionId);
        return;
      }
      wsRef.current = ws;
      ws.onopen = () => {
        retriesRef.current = 0;
        setStatus("connected");
      };
      ws.onmessage = (e) => handleFrame(typeof e.data === "string" ? e.data : String(e.data));
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        if (closedRef.current) return;
        if (retriesRef.current < MAX_RETRIES) {
          retriesRef.current += 1;
          setTimeout(connect, RETRY_DELAY_MS * retriesRef.current);
        } else {
          startPolling(sessionId);
        }
      };
    };

    connect();

    return () => {
      closedRef.current = true;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setStatus("closed");
    };
  }, [sessionId, enabled, handleFrame, startPolling]);

  return { status };
}
