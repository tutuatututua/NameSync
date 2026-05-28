'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Navbar,
  PageContainer,
  MainContent,
  PageHeader,
  SearchInput,
  SessionCard,
  Button,
  EmptyState,
  DeleteConfirmModal
} from '../components';
import { API_BASE_URL } from '../utils/config';

interface HistorySession {
  id: string;
  name: string;
  date: string;
  rowCount: number;
  meanConfidence: number;
}

const historyIcon = (
  <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5"></path>
  </svg>
);

export default function HistoryPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const [filteredSessions, setFilteredSessions] = useState<HistorySession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [sessionToDelete, setSessionToDelete] = useState<HistorySession | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch sessions on mount
  useEffect(() => {
    fetchSessions();
  }, []);

  // Filter sessions when search query changes
  useEffect(() => {
    if (!searchQuery.trim()) {
      setFilteredSessions(sessions);
      return;
    }

    const query = searchQuery.toLowerCase();
    const filtered = sessions.filter(session => {
      const nameMatch = session.name.toLowerCase().includes(query);
      const dateMatch = formatDate(session.date).toLowerCase().includes(query);
      return nameMatch || dateMatch;
    });
    setFilteredSessions(filtered);
  }, [searchQuery, sessions]);

  const fetchSessions = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const response = await fetch(`${API_BASE_URL}/history`);
      const data = await response.json();

      if (data.success) {
        setSessions(data.data);
        setFilteredSessions(data.data);
      } else {
        setError(data.message || 'Failed to load sessions');
      }
    } catch (err) {
      setError('Failed to load sessions. Please try again.');
      console.error('Error fetching sessions:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const formatDate = (dateString: string): string => {
    const date = new Date(dateString);
    const now = new Date();
    const diffTime = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return 'Today';
    } else if (diffDays === 1) {
      return 'Yesterday';
    } else if (diffDays < 7) {
      return `${diffDays} days ago`;
    } else if (diffDays < 30) {
      const weeks = Math.floor(diffDays / 7);
      return `${weeks} week${weeks > 1 ? 's' : ''} ago`;
    } else {
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      });
    }
  };

  const handleSessionClick = (sessionId: string) => {
    router.push(`/session-detail?id=${sessionId}`);
  };

  const handleDeleteClick = (session: HistorySession, e: React.MouseEvent) => {
    e.stopPropagation();
    setSessionToDelete(session);
    setDeleteModalOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!sessionToDelete || isDeleting) return;

    try {
      setIsDeleting(true);
      const response = await fetch(`${API_BASE_URL}/history/${sessionToDelete.id}`, {
        method: 'DELETE'
      });
      if (!response.ok) {
        setError('Failed to delete session');
        return;
      }
      const data = await response.json();

      if (data.success) {
        setSessions(prev => prev.filter(s => s.id !== sessionToDelete.id));
        setDeleteModalOpen(false);
        setSessionToDelete(null);
      } else {
        setError(data.message || 'Failed to delete session');
      }
    } catch (err) {
      setError('Failed to delete session. Please try again.');
      console.error('Error deleting session:', err);
    } finally {
      setIsDeleting(false);
    }
  };

  // Show empty state when no sessions
  if (!isLoading && sessions.length === 0 && !error) {
    return (
      <PageContainer>
        <Navbar />
        <MainContent size="wide">
          <EmptyState
            icon={historyIcon}
            title="No saved comparisons yet"
            description="Your comparison history will appear here. Run your first comparison to get started."
            action={{
              label: 'Start a Comparison',
              href: '/'
            }}
            data-testid="empty-state"
          />
        </MainContent>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <Navbar />
      <MainContent size="wide">
        <PageHeader
          title="Saved Comparisons"
          subtitle="View and manage your previous name comparisons"
          actions={<Button href="/" data-testid="new-comparison-btn">New Comparison</Button>}
        />

        {error && (
          <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700" data-testid="error-message">
            {error}
          </div>
        )}

        <div className="mb-6">
          <SearchInput
            placeholder="Search by session name or date..."
            className="max-w-md"
            value={searchQuery}
            onChange={setSearchQuery}
            data-testid="search-input"
          />
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12" data-testid="loading-indicator">
            <div className="animate-spin h-8 w-8 border-4 border-blue-800 border-t-transparent rounded-full"></div>
          </div>
        ) : (
          <>
            {filteredSessions.length === 0 && searchQuery && (
              <div className="text-center py-12 text-slate-500" data-testid="no-results">
                No sessions found matching &quot;{searchQuery}&quot;
              </div>
            )}

            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredSessions.map((session) => (
                <div key={session.id} className="relative group">
                  <SessionCard
                    title={session.name.length > 40 ? session.name.substring(0, 40) + '...' : session.name}
                    date={formatDate(session.date)}
                    rowCount={session.rowCount}
                    averageConfidence={session.meanConfidence}
                    onClick={() => handleSessionClick(session.id)}
                    data-testid={`session-card-${session.id}`}
                  />
                  <button
                    onClick={(e) => handleDeleteClick(session, e)}
                    className="absolute top-2 right-2 p-2 text-slate-400 hover:text-red-600 transition-colors opacity-0 group-hover:opacity-100"
                    title="Delete session"
                    data-testid={`delete-btn-${session.id}`}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"></path>
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </MainContent>

      <DeleteConfirmModal
        isOpen={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        onConfirm={handleDeleteConfirm}
        sessionName={sessionToDelete?.name || ''}
        rowCount={sessionToDelete?.rowCount || 0}
        isDeleting={isDeleting}
      />
    </PageContainer>
  );
}
