'use client';

import { useState, useEffect, useMemo, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
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
  DeleteConfirmModal,
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

function SessionDetailContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('id');

  const [session, setSession] = useState<SessionDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

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
      if (!response.ok) {
        setError(response.status === 404 ? 'Session not found' : 'Failed to load session details');
        return;
      }
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

  const handleUseInNewMerge = async () => {
    if (!session) return;

    try {
      const response = await fetch(`${API_BASE_URL}/history/${session.id}/clone`, {
        method: 'POST'
      });
      const data = await response.json();

      if (data.success) {
        // Navigate to upload page with session info in query params
        router.push(`/?mode=continue&sessionId=${session.id}&sessionName=${encodeURIComponent(session.name)}`);
      } else {
        setError(data.message || 'Failed to clone session');
      }
    } catch (err) {
      setError('Failed to clone session. Please try again.');
      console.error('Error cloning session:', err);
    }
  };

  const handleDelete = async () => {
    if (!session) return;

    try {
      setIsDeleting(true);
      const response = await fetch(`${API_BASE_URL}/history/${session.id}`, {
        method: 'DELETE'
      });
      const data = await response.json();

      if (data.success) {
        router.push('/history');
      } else {
        setError(data.message || 'Failed to delete session');
        setDeleteModalOpen(false);
      }
    } catch (err) {
      setError('Failed to delete session. Please try again.');
      console.error('Error deleting session:', err);
      setDeleteModalOpen(false);
    } finally {
      setIsDeleting(false);
    }
  };

  const formatDate = (dateString: string): string => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    });
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
          <Link
            href="/history"
            className="inline-flex items-center gap-2 text-sm text-blue-800 hover:text-blue-900"
            data-testid="back-to-history"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
            </svg>
            Back to History
          </Link>
        </MainContent>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <Navbar />
      <MainContent size="wide">
        <Link
          href="/history"
          className="inline-flex items-center gap-2 text-sm text-slate-600 hover:text-slate-900 mb-6"
          data-testid="back-link"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
          </svg>
          Back to History
        </Link>

        <PageHeader
          title={session.name}
          subtitle={`Saved ${formatDate(session.date)}`}
          actions={
            <>
              <Button
                variant="secondary"
                onClick={handleDownloadCSV}
                data-testid="download-csv-btn"
              >
                Download CSV
              </Button>
              <Button
                onClick={handleUseInNewMerge}
                data-testid="use-in-merge-btn"
              >
                Use in New Merge
              </Button>
              <button
                onClick={() => setDeleteModalOpen(true)}
                className="p-2 text-slate-400 hover:text-red-600 transition-colors"
                title="Delete session"
                data-testid="delete-btn"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
                </svg>
              </button>
            </>
          }
        />

        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
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

      <DeleteConfirmModal
        isOpen={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        onConfirm={handleDelete}
        sessionName={session.name}
        rowCount={session.rowCount}
        isDeleting={isDeleting}
      />
    </PageContainer>
  );
}

export default function SessionDetailPage() {
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
      <SessionDetailContent />
    </Suspense>
  );
}
