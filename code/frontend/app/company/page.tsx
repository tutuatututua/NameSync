'use client';

import { useState, useEffect, useRef } from 'react';
import {
  Navbar,
  PageContainer,
  MainContent,
  PageHeader,
  UploadDropzone,
  FileCard,
  Button,
  Alert,
  ConfirmModal
} from '../components';
import CompanyUploadHistory from './components/CompanyUploadHistory';
import CompanyDataTable from './components/CompanyDataTable';
import { API_BASE_URL } from '../utils/config';
import { deleteAllCompanyData } from '../utils/fileParser';

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


type WorkflowStep = 'upload' | 'saving' | 'saved' | 'error';

export default function CompanyDataPage() {
  const [companyFile, setCompanyFile] = useState<UploadedFile | null>(null);
  const [uploadPersonName, setUploadPersonName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [workflowStep, setWorkflowStep] = useState<WorkflowStep>('upload');
  const [uploadStatus, setUploadStatus] = useState<string>('');
  const [uploadedSessionId, setUploadedSessionId] = useState<string | null>(null);
  const [uploadHistory, setUploadHistory] = useState<UploadHistoryRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  // Bumped after a destructive action so the data table refetches.
  const [reloadToken, setReloadToken] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch upload history on mount
  useEffect(() => {
    fetchUploadHistory();
  }, []);

  const fetchUploadHistory = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/upload-history/by-source/company?page=1&limit=10`);
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

    if (!file.name.toLowerCase().endsWith('.csv')) {
      return { valid: false, errorMessage: 'Please upload a .csv file. Only CSV files are supported for company data import.' };
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

    setCompanyFile(uploadedFile);
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
    return !!companyFile && companyFile.valid && uploadPersonName.trim().length > 0;
  };

  const handleUpload = async () => {
    if (!companyFile || !companyFile.valid || !uploadPersonName.trim()) return;

    setIsSubmitting(true);
    setError(null);
    setWorkflowStep('saving');
    setUploadStatus('Uploading file...');

    try {
      const formData = new FormData();
      formData.append('companyFile', companyFile.file);
      formData.append('name', `Company Upload - ${companyFile.name}`);
      formData.append('uploadPersonName', uploadPersonName.trim());
      formData.append('mode', 'fresh');

      // Create a placeholder facebook file (required by API)
      const emptyJSON = new Blob(['{"friends_v2":[]}'], { type: 'application/json' });
      formData.append('facebookFile', emptyJSON, 'placeholder.json');

      const response = await fetch(`${API_BASE_URL}/comparisons`, {
        method: 'POST',
        body: formData
      });

      const data = await response.json();

      if (data.success) {
        const newRows = data.data.companyRecordsCount || 0;
        const duplicateRows = data.data.duplicateRows || 0;

        setUploadedSessionId(data.data.sessionId);

        // Create upload history record
        await fetch(`${API_BASE_URL}/upload-history`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source_type: 'company',
            user_upload: uploadPersonName.trim(),
            timestamp: new Date().toISOString(),
            rows_processed: newRows,
            duplicate_rows: duplicateRows,
            session_id: data.data.sessionId
          })
        });

        setWorkflowStep('saved');
        setUploadStatus(
          `Upload done — ${newRows} new row${newRows === 1 ? '' : 's'} added` +
          (duplicateRows > 0 ? `, ${duplicateRows} duplicate${duplicateRows === 1 ? '' : 's'} skipped` : '')
        );
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

  const resetForm = () => {
    setCompanyFile(null);
    setUploadPersonName('');
    setWorkflowStep('upload');
    setUploadedSessionId(null);
    setUploadStatus('');
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleConfirmClearAll = async () => {
    setIsClearing(true);
    setError(null);
    try {
      await deleteAllCompanyData();
      resetForm();
      setReloadToken((t) => t + 1);
      fetchUploadHistory();
      setShowClearConfirm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear company data');
    } finally {
      setIsClearing(false);
    }
  };

  const companyIcon = (
    <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
    </svg>
  );

  return (
    <PageContainer>
      <Navbar />
      <MainContent size="wide">
        <PageHeader
          title="Company Data"
          subtitle="Upload and manage Company data records"
          actions={
            <Button
              variant="secondary"
              onClick={() => setShowClearConfirm(true)}
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
                Upload Company Data
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
                  Company CSV File <span className="text-red-500">*</span>
                </label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
                  onChange={handleFileInputChange}
                  className="hidden"
                  data-testid="file-input"
                />
                {!companyFile ? (
                  <UploadDropzone
                    icon={companyIcon}
                    title="Upload Company CSV"
                    description="Click to browse or drag & drop your Company CSV file"
                    fileType="CSV"
                    onClick={handleDropzoneClick}
                    onFileDrop={handleFileSelect}
                    data-testid="company-dropzone"
                  />
                ) : (
                  <FileCard
                    fileName={companyFile.name}
                    fileSize={formatFileSize(companyFile.size)}
                    status={companyFile.valid ? 'valid' : 'error'}
                    statusLabel={companyFile.valid ? 'Valid CSV' : 'Invalid File'}
                    errorMessage={companyFile.errorMessage}
                    onRemove={() => {
                      setCompanyFile(null);
                      if (fileInputRef.current) {
                        fileInputRef.current.value = '';
                      }
                    }}
                    data-testid="company-file-card"
                  />
                )}
              </div>

              {/* Upload Status */}
              {uploadStatus && (
                <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="text-sm text-blue-800">{uploadStatus}</p>
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
            <CompanyUploadHistory 
              history={uploadHistory}
              onRefresh={fetchUploadHistory}
            />
          </div>

          {/* Right Column - Data Table */}
          <div className="lg:col-span-2">
            <CompanyDataTable sessionId={uploadedSessionId} reloadToken={reloadToken} />
          </div>
        </div>
      </MainContent>

      <ConfirmModal
        isOpen={showClearConfirm}
        title="Clear all Company data"
        message={
          <>
            This permanently removes <span className="font-medium text-slate-900">all Company data</span> and its
            upload history from the database. This action cannot be undone.
          </>
        }
        confirmLabel="Clear all Company data"
        isProcessing={isClearing}
        onClose={() => setShowClearConfirm(false)}
        onConfirm={handleConfirmClearAll}
      />
    </PageContainer>
  );
}
