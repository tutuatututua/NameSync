'use client';

import { useState } from 'react';
import { triggerComparison } from '../../utils/facebookData';
import { Button } from '../../components';

interface FacebookComparisonProps {
  sessionId: string;
  onComparisonComplete?: () => void;
}

export default function FacebookComparison({ sessionId, onComparisonComplete }: FacebookComparisonProps) {
  const [isComparing, setIsComparing] = useState(false);
  const [comparisonStatus, setComparisonStatus] = useState<string>('');
  const [comparisonResult, setComparisonResult] = useState<{
    status: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleCompare = async () => {
    setIsComparing(true);
    setError(null);
    setComparisonStatus('Sending comparison trigger...');

    try {
      const result = await triggerComparison(sessionId);

      if (result.success && result.data) {
        setComparisonStatus('Comparison triggered successfully');
        setComparisonResult({
          status: result.data.status ?? 'unknown'
        });
        onComparisonComplete?.();
      } else {
        setError(result.message || 'Comparison failed');
        setComparisonStatus('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Comparison failed');
      setComparisonStatus('');
    } finally {
      setIsComparing(false);
    }
  };

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-6" data-testid="facebook-comparison">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">
            Compare Data
          </h3>
          <p className="text-sm text-slate-500 mt-1">
            Run comparison between Facebook data and Company records
          </p>
        </div>
        <div className="flex items-center gap-2">
          <svg className="w-8 h-8 text-blue-800" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {comparisonResult && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-sm text-green-800 font-medium">Comparison Status: {comparisonResult.status}</p>
          <p className="mt-1 text-sm text-green-700">
            The comparison service has been triggered. Results will stream in as they are processed.
          </p>
        </div>
      )}

      {comparisonStatus && !comparisonResult && (
        <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
          <div className="flex items-center gap-2">
            <div className="animate-spin h-4 w-4 border-2 border-blue-800 border-t-transparent rounded-full"></div>
            <p className="text-sm text-blue-800">{comparisonStatus}</p>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="text-sm text-slate-500">
          <p>Session ID: <span className="font-mono text-xs">{sessionId.substring(0, 8)}...</span></p>
        </div>
        <Button
          onClick={handleCompare}
          disabled={isComparing}
          isLoading={isComparing}
          data-testid="run-comparison-btn"
        >
          {isComparing ? 'Comparing...' : 'Run Comparison'}
        </Button>
      </div>

      <div className="mt-4 pt-4 border-t border-slate-200">
        <p className="text-xs text-slate-500">
          This sends a trigger to the comparison service (the uploaded data was already
          forwarded to the webhooks during upload). It generates matching scores based on
          name similarity and streams results back via the callback URL.
        </p>
      </div>
    </div>
  );
}
