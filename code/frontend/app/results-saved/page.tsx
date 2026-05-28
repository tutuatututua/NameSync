'use client';

import { useState, useEffect, useMemo, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Navbar,
  PageContainer,
  MainContent,
  PageHeader,
  StatsCard,
  ConfidenceChart,
  ResultsTable,
  SearchInput,
  Button,
  Alert
} from '../components';
import type { ResultRow } from '../components';
import { API_BASE_URL } from '../utils/config';

interface SessionDetail {
  id: string;
  name: string;
  date: string;
  rowCount: number;
  meanConfidence: number;
  stats: {
    totalRows: number;
    minConfidence: string;
    maxConfidence: string;
    mean: string;
    stdDev: string;
  };
  histogramData: number[];
  results: ResultRow[];
}

const ITEMS_PER_PAGE = 50;

function ResultsSavedContent() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('id');

  const [session, setSession] = useState<SessionDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    if (sessionId) {
      fetchSessionDetails(sessionId);
    } else {
      setError('No session ID provided');
      setIsLoading(false);
    }
  }, [sessionId]);

  const fetchSessionDetails = async (id: string) => {
    try {
      setIsLoading(true);
      setError(null);
      const response = await fetch(`${API_BASE_URL}/history/${id}`);
      const data = await response.json();

      if (data.success) {
        setSession(data.data);
      } else {
        setError(data.message || 'Failed to load session details');
      }
    } catch (err) {
      setError('Failed to load session details. Please try again.');
      console.error('Error fetching session details:', err);
    } finally {
      setIsLoading(false);
    }
  };

  // Filter results based on search query
  const filteredResults = useMemo(() => {
    if (!session?.results) return [];
    if (!searchQuery.trim()) return session.results;

    const query = searchQuery.toLowerCase();
    return session.results.filter((row: ResultRow) =>
      row.companyName.toLowerCase().includes(query) ||
      row.facebookName.toLowerCase().includes(query)
    );
  }, [session?.results, searchQuery]);

  // Paginate results
  const paginatedResults = useMemo(() => {
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    return filteredResults.slice(startIndex, startIndex + ITEMS_PER_PAGE);
  }, [filteredResults, currentPage]);

  const totalPages = Math.ceil(filteredResults.length / ITEMS_PER_PAGE);

  const handleDownloadCSV = () => {
    if (!session?.results) return;

    // Convert results to CSV
    const headers = ['Company Name', 'Facebook Name', 'Confidence'];
    const rows = session.results.map((r: ResultRow) => [
      r.companyName,
      r.facebookName,
      r.confidence.toString()
    ]);
    const csvContent = [headers.join(','), ...rows.map((r: string[]) => r.join(','))].join('\n');

    // Create and download file
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${session.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_results.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  };

  if (isLoading) {
    return (
      <PageContainer>
        <Navbar />
        <MainContent size="wide">
          <div className="flex items-center justify-center py-12" data-testid="loading-indicator">
            <div className="animate-spin h-8 w-8 border-4 border-blue-800 border-t-transparent rounded-full"></div>
          </div>
        </MainContent>
      </PageContainer>
    );
  }

  if (error || !session) {
    return (
      <PageContainer>
        <Navbar />
        <MainContent size="wide">
          <Alert variant="error" className="mb-4" data-testid="error-message">
            {error || 'Session not found'}
          </Alert>
        </MainContent>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <Navbar />
      <MainContent size="wide">
        <PageHeader
          title="Comparison Results"
          subtitle="Company Data and Facebook name matching complete"
          actions={
            <>
              <Button variant="secondary" onClick={handleDownloadCSV}>Download CSV</Button>
              <div className="flex items-center gap-2 px-4 py-2 bg-green-100 text-green-700 text-sm font-medium rounded-lg">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
                </svg>
                Saved
              </div>
            </>
          }
        />

        <Alert
          variant="success"
          action={{ label: 'View in History →', href: '/history' }}
        >
          <p className="text-sm text-slate-700">
            Session saved as <span className="font-medium text-slate-900">&quot;{session.name}&quot;</span>
          </p>
        </Alert>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 my-8">
          <StatsCard label="Total Rows" value={session.stats.totalRows.toLocaleString()} />
          <StatsCard label="Min Confidence" value={session.stats.minConfidence} />
          <StatsCard label="Max Confidence" value={session.stats.maxConfidence} />
          <StatsCard label="Mean" value={session.stats.mean} />
          <StatsCard label="Std Dev" value={session.stats.stdDev} />
        </div>

        <ConfidenceChart data={session.histogramData} />

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
          <SearchInput
            placeholder="Search names..."
            className="max-w-sm"
            value={searchQuery}
            onChange={setSearchQuery}
            data-testid="results-search-input"
          />
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <span>
              {filteredResults.length > 0
                ? `${(currentPage - 1) * ITEMS_PER_PAGE + 1}-${Math.min(currentPage * ITEMS_PER_PAGE, filteredResults.length)} of ${filteredResults.length.toLocaleString()}`
                : '0 results'}
            </span>
            <div className="flex items-center gap-1 ml-2">
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="p-1 hover:bg-slate-100 rounded disabled:opacity-40"
                data-testid="prev-page-btn"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
                </svg>
              </button>
              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage >= totalPages}
                className="p-1 hover:bg-slate-100 rounded disabled:opacity-40"
                data-testid="next-page-btn"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
                </svg>
              </button>
            </div>
          </div>
        </div>

        <ResultsTable rows={paginatedResults} />
      </MainContent>
    </PageContainer>
  );
}

export default function ResultsSavedPage() {
  return (
    <Suspense fallback={
      <PageContainer>
        <Navbar />
        <MainContent size="wide">
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin h-8 w-8 border-4 border-blue-800 border-t-transparent rounded-full"></div>
          </div>
        </MainContent>
      </PageContainer>
    }>
      <ResultsSavedContent />
    </Suspense>
  );
}
