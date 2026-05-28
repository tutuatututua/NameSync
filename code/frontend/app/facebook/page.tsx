'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Navbar,
  PageContainer,
  MainContent,
  PageHeader,
  UploadDropzone,
  FileCard,
  Button,
  Alert
} from '../components';
import FacebookDataTable from './components/FacebookDataTable';
import FacebookUploadHistory from './components/FacebookUploadHistory';
import FacebookComparison from './components/FacebookComparison';
import { API_BASE_URL, WS_BASE_URL } from '../utils/config';

interface UploadedFile {
  file: File;
  name: string;
  size: number;
  valid: boolean;
  errorMessage?: string;
}

interface UploadHistoryRecord {
  id: string;
  source_type: string;
  user_upload: string;
  timestamp: string;
  rows_processed: number;
  duplicate_rows: number;
  session_id: string | null;
  created_at: string | null;
}

interface WebSocketMessage {
  type: string;
  sessionId?: string;
  message?: string;
  facebookRecordsCount?: number;
  batchNumber?: number;
  totalBatches?: number;
  progress?: number;
  recordsCount?: number;
  totalRecords?: number;
}

type WorkflowStep = 'upload' | 'saving' | 'saved' | 'comparing' | 'completed' | 'error';
type WebSocketStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export default function FacebookDataPage() {
  const router = useRouter();
  const [facebookFile, setFacebookFile] = useState<UploadedFile | null>(null);
  const [uploadPersonName, setUploadPersonName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [workflowStep, setWorkflowStep] = useState<WorkflowStep>('upload');
  const [wsStatus, setWsStatus] = useState<WebSocketStatus>('disconnected');
  const [uploadStatus, setUploadStatus] = useState<string>('');
  const [uploadedSessionId, setUploadedSessionId] = useState<string | null>(null);
  const [uploadHistory, setUploadHistory] = useState<UploadHistoryRecord[]>([]);
  const [totalFacebookRecords, setTotalFacebookRecords] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Fetch upload history on mount
  useEffect(() => {
    fetchUploadHistory();
  }, []);

  // WebSocket connection for real-time updates. Keyed only on the session id so the
  // socket stays open across the whole workflow (saving -> saved -> comparing ->
  // completed). Gating on workflowStep tore the socket down on the first state
  // change, before the comparison_* messages could arrive.
  useEffect(() => {
    if (!uploadedSessionId) return;
    connectWebSocket(uploadedSessionId);
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadedSessionId]);

  const connectWebSocket = (sessionId: string) => {
    setWsStatus('connecting');
    const ws = new WebSocket(`${WS_BASE_URL}?sessionId=${sessionId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsStatus('connected');
      console.log('WebSocket connected for session:', sessionId);
    };

    ws.onmessage = (event) => {
      try {
        const message: WebSocketMessage = JSON.parse(event.data);
        handleWebSocketMessage(message);
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    };

    ws.onerror = () => {
      setWsStatus('error');
    };

    ws.onclose = () => {
      setWsStatus('disconnected');
    };
  };

  const handleWebSocketMessage = (message: WebSocketMessage) => {
    switch (message.type) {
      case 'processing_started':
        setUploadStatus('Processing uploaded file...');
        break;
      case 'records_parsed':
        setUploadStatus(`Parsed ${message.facebookRecordsCount || 0} Facebook records`);
        if (message.facebookRecordsCount) {
          setTotalFacebookRecords(message.facebookRecordsCount);
        }
        break;
      case 'saved_to_database':
        setWorkflowStep('saved');
        setUploadStatus('Data saved to database successfully');
        fetchUploadHistory();
        break;
      case 'webhook_success':
        setWorkflowStep('saved');
        setUploadStatus(message.message || 'Upload done');
        fetchUploadHistory();
        break;
      case 'processing_failed':
        setWorkflowStep('error');
        setError(message.message || 'Processing failed');
        break;
      case 'comparison_starting':
        setWorkflowStep('comparing');
        setUploadStatus('Starting comparison...');
        break;
      case 'comparison_triggered':
        setUploadStatus('Comparison in progress...');
        break;
      case 'comparison_completed':
        setWorkflowStep('completed');
        setUploadStatus('Comparison completed!');
        break;
      case 'comparison_failed':
        setWorkflowStep('error');
        setError(message.message || 'Comparison failed');
        break;
    }
  };

  const fetchUploadHistory = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/upload-history/by-source/facebook?page=1&limit=10`);
      if (!response.ok) {
        console.error('Error fetching upload history:', response.status);
        return;
      }
      const data = await response.json();
      if (data.success) {
        setUploadHistory(data.data);
      }
    } catch (err) {
      console.error('Error fetching upload history:', err);
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const validateFile = (file: File): { valid: boolean; errorMessage?: string } => {
    const MAX_SIZE = 500 * 1024 * 1024; // 500MB

    if (!file.name.toLowerCase().endsWith('.json')) {
      return { valid: false, errorMessage: 'Please upload a .json file. Only JSON files are supported for Facebook data import.' };
    }

    if (file.size > MAX_SIZE) {
      return { valid: false, errorMessage: 'File exceeds 500MB limit.' };
    }

    return { valid: true };
  };

  const handleFileSelect = (file: File) => {
    const validation = validateFile(file);
    const uploadedFile: UploadedFile = {
      file,
      name: file.name,
      size: file.size,
      valid: validation.valid,
      errorMessage: validation.errorMessage
    };

    setFacebookFile(uploadedFile);
    setWorkflowStep('upload');
    setUploadedSessionId(null);
    setError(null);
  };

  const handleDropzoneClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      handleFileSelect(e.target.files[0]);
    }
  };

  const canUpload = (): boolean => {
    return !!facebookFile && facebookFile.valid && uploadPersonName.trim().length > 0;
  };

  const handleUpload = async () => {
    if (!facebookFile || !facebookFile.valid || !uploadPersonName.trim()) return;

    setIsSubmitting(true);
    setError(null);
    setWorkflowStep('saving');
    setUploadStatus('Uploading file...');

    try {
      const formData = new FormData();
      formData.append('facebookFile', facebookFile.file);
      formData.append('name', `Facebook Upload - ${facebookFile.name}`);
      formData.append('uploadPersonName', uploadPersonName.trim());
      formData.append('mode', 'fresh');

      // Create a placeholder company file (required by API)
      const emptyCSV = new Blob(['Company Name,Thai Name'], { type: 'text/csv' });
      formData.append('companyFile', emptyCSV, 'placeholder.csv');

      const response = await fetch(`${API_BASE_URL}/comparisons`, {
        method: 'POST',
        body: formData
      });

      const data = await response.json();

      if (data.success) {
        const newRows = data.data.facebookRecordsCount || 0;
        const duplicateRows = data.data.duplicateRows || 0;

        setUploadedSessionId(data.data.sessionId);
        setTotalFacebookRecords(newRows);
        // Drive the UI from the HTTP response rather than WebSocket messages, which are
        // broadcast during this request before the client socket connects. Marking the
        // step 'saved' is what reveals the Compare section.
        setWorkflowStep('saved');
        setUploadStatus(
          `Upload done — ${newRows} new row${newRows === 1 ? '' : 's'} added` +
          (duplicateRows > 0 ? `, ${duplicateRows} duplicate${duplicateRows === 1 ? '' : 's'} skipped` : '')
        );

        // Create upload history record
        await fetch(`${API_BASE_URL}/upload-history`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source_type: 'facebook',
            user_upload: uploadPersonName.trim(),
            timestamp: new Date().toISOString(),
            rows_processed: newRows,
            duplicate_rows: duplicateRows,
            session_id: data.data.sessionId
          })
        });
        fetchUploadHistory();
      } else {
        setWorkflowStep('error');
        setError(data.message || 'Upload failed');
      }
    } catch (err) {
      setWorkflowStep('error');
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClear = () => {
    setFacebookFile(null);
    setUploadPersonName('');
    setWorkflowStep('upload');
    setUploadedSessionId(null);
    setUploadStatus('');
    setError(null);
    setTotalFacebookRecords(0);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const facebookIcon = (
    <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path d="M4 6h16M4 12h16M4 18h7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
    </svg>
  );

  return (
    <PageContainer>
      <Navbar />
      <MainContent size="wide">
        <PageHeader
          title="Facebook Data"
          subtitle="Upload, manage, and compare Facebook data with existing records"
          actions={
            <Button 
              variant="secondary" 
              onClick={handleClear}
              data-testid="clear-btn"
            >
              Clear All
            </Button>
          }
        />

        {error && (
          <Alert 
            variant="error" 
            className="mb-6"
            onDismiss={() => setError(null)}
            data-testid="error-alert"
          >
            {error}
          </Alert>
        )}

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Left Column - Upload Section */}
          <div className="lg:col-span-1 space-y-6">
            <div className="bg-white rounded-lg border border-slate-200 p-6">
              <h3 className="text-lg font-semibold text-slate-900 mb-4">
                Upload Facebook Data
              </h3>
              
              {/* Upload Person Name Input */}
              <div className="mb-4">
                <label 
                  htmlFor="uploadPersonName" 
                  className="block text-sm font-medium text-slate-700 mb-2"
                >
                  Upload Person Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  id="uploadPersonName"
                  value={uploadPersonName}
                  onChange={(e) => setUploadPersonName(e.target.value)}
                  placeholder="Enter your name"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-800 focus:border-transparent"
                  data-testid="upload-person-input"
                />
              </div>

              {/* File Upload */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Facebook JSON File <span className="text-red-500">*</span>
                </label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  onChange={handleFileInputChange}
                  className="hidden"
                  data-testid="file-input"
                />
                {!facebookFile ? (
                  <UploadDropzone
                    icon={facebookIcon}
                    title="Upload Facebook JSON"
                    description="Click to browse for your Facebook JSON file"
                    fileType="JSON"
                    onClick={handleDropzoneClick}
                    data-testid="facebook-dropzone"
                  />
                ) : (
                  <FileCard
                    fileName={facebookFile.name}
                    fileSize={formatFileSize(facebookFile.size)}
                    status={facebookFile.valid ? 'valid' : 'error'}
                    statusLabel={facebookFile.valid ? 'Valid JSON' : 'Invalid File'}
                    errorMessage={facebookFile.errorMessage}
                    onRemove={() => {
                      setFacebookFile(null);
                      if (fileInputRef.current) {
                        fileInputRef.current.value = '';
                      }
                    }}
                    data-testid="facebook-file-card"
                  />
                )}
              </div>

              {/* Upload Status */}
              {uploadStatus && (
                <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="text-sm text-blue-800">{uploadStatus}</p>
                  {wsStatus === 'connected' && (
                    <p className="text-xs text-blue-600 mt-1">● Live updates connected</p>
                  )}
                </div>
              )}

              {/* Action Button */}
              <Button
                className="w-full"
                disabled={!canUpload() || isSubmitting || workflowStep === 'saving'}
                onClick={handleUpload}
                isLoading={isSubmitting || workflowStep === 'saving'}
                data-testid="upload-btn"
              >
                {workflowStep === 'saving' ? 'Uploading...' : 'Upload & Merge'}
              </Button>

              <p className="mt-3 text-xs text-slate-500 text-center">
                New data will be merged with existing records
              </p>
            </div>

            {/* Upload History Section */}
            <FacebookUploadHistory 
              history={uploadHistory}
              onRefresh={fetchUploadHistory}
            />
          </div>

          {/* Right Column - Data Table & Comparison */}
          <div className="lg:col-span-2 space-y-6">
            {/* Facebook Data Table */}
            <FacebookDataTable 
              sessionId={uploadedSessionId}
              totalRecords={totalFacebookRecords}
            />

            {/* Comparison Section */}
            {(workflowStep === 'saved' || workflowStep === 'comparing' || workflowStep === 'completed') && uploadedSessionId && (
              <FacebookComparison
                sessionId={uploadedSessionId}
                onComparisonComplete={() => {
                  setWorkflowStep('completed');
                  fetchUploadHistory();
                }}
              />
            )}
          </div>
        </div>
      </MainContent>
    </PageContainer>
  );
}
