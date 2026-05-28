'use client';

import { useEffect, useState, useRef, Suspense, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Navbar,
  PageContainer,
  ProgressCard,
  Alert
} from '../components';
import { API_BASE_URL, WS_BASE_URL } from '../utils/config';

interface WebSocketMessage {
  type: string;
  sessionId?: string;
  message?: string;
  batchNumber?: number;
  totalBatches?: number;
  progress?: number;
  recordsCount?: number;
  totalRecords?: number;
}

interface SessionStatus {
  id: string;
  title: string;
  status: 'pending' | 'pending_webhook' | 'processing' | 'completed' | 'failed' | null;
  date: string;
}

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'polling' | 'error';

// Connection retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const POLLING_INTERVAL_MS = 3000;

// Wrap the component in Suspense for useSearchParams
export default function ProcessPage() {
  return (
    <Suspense fallback={<ProcessPageLoading />}>
      <ProcessPageContent />
    </Suspense>
  );
}

function ProcessPageLoading() {
  return (
    <PageContainer>
      <Navbar />
      <main className="flex items-center justify-center min-h-[calc(100vh-4rem)] px-4">
        <ProgressCard
          title="Loading..."
          subtitle="Initializing comparison process"
          current={0}
          total={100}
          percent={0}
        />
      </main>
    </PageContainer>
  );
}

function ProcessPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('sessionId');
  const wsRef = useRef<WebSocket | null>(null);
  const retryCountRef = useRef(0);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  
  const [progress, setProgress] = useState({
    current: 0,
    total: 100,
    percent: 0,
    subtitle: 'Initializing comparison process...'
  });
  const [isComplete, setIsComplete] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Poll session status from API as fallback when WebSocket fails
  const pollSessionStatus = useCallback(async () => {
    if (!sessionId) return;

    try {
      const response = await fetch(`${API_BASE_URL}/sessions/${sessionId}`);
      if (!response.ok) {
        console.warn('Polling failed:', response.status);
        return;
      }

      const data = await response.json();
      if (data.success && data.data) {
        const session: SessionStatus = data.data;
        
        // Update UI based on session status
        switch (session.status) {
          case 'processing':
            setProgress(prev => ({
              ...prev,
              subtitle: 'Processing comparison (via polling)...',
              percent: Math.min(prev.percent + 5, 90) // Incremental progress
            }));
            break;
          case 'completed':
            setIsComplete(true);
            setProgress({
              current: 100,
              total: 100,
              percent: 100,
              subtitle: 'Comparison complete! Redirecting to results...'
            });
            // Stop polling
            if (pollingIntervalRef.current) {
              clearInterval(pollingIntervalRef.current);
              pollingIntervalRef.current = null;
            }
            // Redirect after delay
            setTimeout(() => {
              router.push(`/results?sessionId=${sessionId}`);
            }, 1500);
            break;
          case 'failed':
            setProgress(prev => ({
              ...prev,
              subtitle: 'Processing failed'
            }));
            setErrorMessage('The comparison process failed. Please try again.');
            if (pollingIntervalRef.current) {
              clearInterval(pollingIntervalRef.current);
              pollingIntervalRef.current = null;
            }
            setTimeout(() => router.push('/upload-error'), 2000);
            break;
        }
      }
    } catch (error) {
      console.error('Error polling session status:', error);
    }
  }, [sessionId, router]);

  // Start polling as fallback
  const startPolling = useCallback(() => {
    if (pollingIntervalRef.current) return; // Already polling
    
    console.log('Starting polling fallback for session:', sessionId);
    setConnectionState('polling');
    setProgress(prev => ({
      ...prev,
      subtitle: 'Using polling mode for updates...'
    }));
    
    // Poll immediately then set interval
    pollSessionStatus();
    pollingIntervalRef.current = setInterval(pollSessionStatus, POLLING_INTERVAL_MS);
  }, [sessionId, pollSessionStatus]);

  // Connect WebSocket with retry logic
  const connectWebSocket = useCallback(() => {
    if (!sessionId) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setConnectionState('connecting');
    setErrorMessage(null);

    try {
      const ws = new WebSocket(`${WS_BASE_URL}?sessionId=${sessionId}`);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('WebSocket connected for process page:', sessionId);
        retryCountRef.current = 0;
        setConnectionState('connected');
        setProgress(prev => ({
          ...prev,
          subtitle: 'Connected. Waiting for comparison results...'
        }));
      };

      ws.onmessage = (event) => {
        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          handleWebSocketMessage(message);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      ws.onerror = (error) => {
        // Browsers intentionally don't expose WebSocket error details for security reasons,
        // so the error object appears empty {}. This is expected behavior during connection attempts.
        console.warn('WebSocket connection attempt failed - retry/polling fallback will handle it');
        setConnectionState('error');
        
        // Don't show error immediately - let onclose handle retry/fallback
        if (retryCountRef.current >= MAX_RETRIES) {
          setErrorMessage('Real-time updates unavailable. Using fallback polling mode.');
        }
      };

      ws.onclose = (event) => {
        console.log('WebSocket closed:', event.code, event.reason);
        wsRef.current = null;

        // If already complete or no session, don't retry
        if (isComplete || !sessionId) return;

        // Attempt retry if we haven't exceeded max retries
        if (retryCountRef.current < MAX_RETRIES) {
          retryCountRef.current++;
          const delay = RETRY_DELAY_MS * retryCountRef.current;
          console.log(`Retrying WebSocket connection in ${delay}ms (attempt ${retryCountRef.current}/${MAX_RETRIES})...`);
          setConnectionState('connecting');
          setProgress(prev => ({
            ...prev,
            subtitle: `Connection lost. Retrying (${retryCountRef.current}/${MAX_RETRIES})...`
          }));
          setTimeout(connectWebSocket, delay);
        } else {
          // Max retries reached, switch to polling
          console.log('Max WebSocket retries reached, switching to polling');
          setConnectionState('disconnected');
          startPolling();
        }
      };
    } catch (error) {
      console.error('Error creating WebSocket:', error);
      setConnectionState('error');
      setErrorMessage('Failed to establish real-time connection. Using polling mode.');
      startPolling();
    }
  }, [sessionId, isComplete, startPolling]);

  const handleWebSocketMessage = (message: WebSocketMessage) => {
    switch (message.type) {
      case 'batch_received':
        // Functional update: the socket's onmessage handler is created once at
        // connect time, so reading `progress` directly here would see a stale value
        // and break accumulation. Derive everything from `prev`.
        setProgress(prev => ({
          current: (prev.current || 0) + (message.recordsCount || 0),
          total: message.totalBatches ? message.totalBatches * 100 : (prev.total || 100),
          percent: message.progress ?? prev.percent ?? 0,
          subtitle: `Processing batch ${message.batchNumber} of ${message.totalBatches}`
        }));
        break;

      case 'comparison_complete':
        setIsComplete(true);
        setProgress(prev => ({
          current: message.totalRecords || prev.current,
          total: message.totalRecords || prev.total,
          percent: 100,
          subtitle: 'Comparison complete! Redirecting to results...'
        }));

        setTimeout(() => {
          router.push(`/results?sessionId=${sessionId}`);
        }, 1500);
        break;

      case 'processing_failed':
        setProgress(prev => ({
          ...prev,
          subtitle: message.message || 'Processing failed'
        }));
        setErrorMessage(message.message || 'The comparison process failed. Please try again.');
        setTimeout(() => router.push('/upload-error'), 2000);
        break;

      case 'connected':
        setProgress(prev => ({
          ...prev,
          subtitle: 'Connected. Waiting for comparison results...'
        }));
        break;

      case 'comparison_triggered':
        setProgress(prev => ({
          ...prev,
          subtitle: 'Comparison started. Waiting for results...'
        }));
        break;
    }
  };

  // Initialize connection
  useEffect(() => {
    if (!sessionId) {
      setProgress({
        current: 0,
        total: 100,
        percent: 0,
        subtitle: 'No session found. Redirecting...'
      });
      setTimeout(() => router.push('/'), 2000);
      return;
    }

    // Start WebSocket connection
    connectWebSocket();

    // Cleanup on unmount
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
  }, [sessionId, router, connectWebSocket]);

  const handleCancel = () => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
    }
    router.push('/');
  };

  // Get connection status text for UI
  const getConnectionStatusText = () => {
    switch (connectionState) {
      case 'connecting':
        return 'Connecting...';
      case 'connected':
        return 'Live updates active';
      case 'polling':
        return 'Using fallback polling';
      case 'disconnected':
        return 'Disconnected';
      case 'error':
        return 'Connection error';
      default:
        return '';
    }
  };

  return (
    <PageContainer>
      <Navbar />
      <main className="flex items-center justify-center min-h-[calc(100vh-4rem)] px-4">
        <div className="w-full max-w-2xl">
          {errorMessage && (
            <div className="mb-4">
              <Alert 
                variant="warning" 
                onDismiss={() => setErrorMessage(null)}
              >
                {errorMessage}
              </Alert>
            </div>
          )}
          
          <ProgressCard
            title={isComplete ? "Comparison complete!" : "Comparing names..."}
            subtitle={progress.subtitle}
            current={progress.current}
            total={progress.total || 100}
            percent={progress.percent}
            onCancel={handleCancel}
          />
          
          {/* Connection status indicator */}
          <div className="mt-4 text-center">
            <div className="flex items-center justify-center gap-2 text-sm text-slate-500">
              <span 
                className={`w-2 h-2 rounded-full ${
                  connectionState === 'connected' ? 'bg-green-500' :
                  connectionState === 'polling' ? 'bg-yellow-500' :
                  connectionState === 'connecting' ? 'bg-blue-500 animate-pulse' :
                  'bg-red-500'
                }`}
              />
              <span>{getConnectionStatusText()}</span>
            </div>
            
            {(connectionState === 'polling' || connectionState === 'disconnected') && (
              <p className="text-xs text-slate-400 mt-2">
                Real-time updates are unavailable. The process will continue using polling.
              </p>
            )}
          </div>
        </div>
      </main>
    </PageContainer>
  );
}
