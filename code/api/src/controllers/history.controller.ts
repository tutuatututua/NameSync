import { Request, Response } from 'express';
import { HistorySessionModel } from '../models/history-session.model';

// Default user ID for demo purposes (in production, this would come from auth)
const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000000';

export class HistoryController {
  /**
   * GET /api/history
   * List saved comparison sessions
   */
  static async list(req: Request, res: Response): Promise<void> {
    try {
      // In production, get userId from authenticated session
      const userId = DEFAULT_USER_ID;
      
      const sessions = await HistorySessionModel.findByUserId(userId);
      
      // Format the response
      const formattedSessions = sessions.map(session => ({
        id: session.id,
        name: session.name,
        date: session.created_at || new Date().toISOString(),
        rowCount: session.row_count || 0,
        meanConfidence: session.mean_confidence || 0
      }));

      res.status(200).json({
        success: true,
        data: formattedSessions
      });
    } catch (error) {
      console.error('Error listing history sessions:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }

  /**
   * GET /api/history/:id
   * Get session details with results
   */
  static async getById(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const userId = DEFAULT_USER_ID;

      const session = await HistorySessionModel.findById(id);
      
      if (!session) {
        res.status(404).json({
          success: false,
          message: 'Session not found'
        });
        return;
      }

      // Verify ownership
      if (session.user_id !== userId) {
        res.status(403).json({
          success: false,
          message: 'Access denied'
        });
        return;
      }

      // Parse results
      let results = [];
      try {
        results = session.results ? JSON.parse(session.results) : [];
      } catch {
        results = [];
      }

      // Calculate stats from results
      const totalRows = session.row_count || 0;
      const confidenceScores = results.map((r: { confidence?: number }) => r.confidence || 0).filter((c: number) => c > 0);
      const minConfidence = confidenceScores.length > 0 ? Math.min(...confidenceScores) : 0;
      const maxConfidence = confidenceScores.length > 0 ? Math.max(...confidenceScores) : 0;
      const meanConfidence = session.mean_confidence || 0;
      const stdDev = confidenceScores.length > 0 
        ? Math.sqrt(confidenceScores.reduce((sum: number, c: number) => sum + Math.pow(c - meanConfidence, 2), 0) / confidenceScores.length)
        : 0;

      // Calculate histogram data (10 bins from 0.0 to 1.0)
      const histogramData = Array(10).fill(0);
      confidenceScores.forEach((score: number) => {
        const binIndex = Math.min(Math.floor(score * 10), 9);
        histogramData[binIndex]++;
      });

      res.status(200).json({
        success: true,
        data: {
          id: session.id,
          name: session.name,
          date: session.created_at || new Date().toISOString(),
          rowCount: totalRows,
          meanConfidence: meanConfidence,
          stats: {
            totalRows,
            minConfidence: minConfidence.toFixed(2),
            maxConfidence: maxConfidence.toFixed(2),
            mean: meanConfidence.toFixed(2),
            stdDev: stdDev.toFixed(2)
          },
          histogramData,
          results
        }
      });
    } catch (error) {
      console.error('Error getting session details:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }

  /**
   * DELETE /api/history/:id
   * Delete a session
   */
  static async delete(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const userId = DEFAULT_USER_ID;

      const session = await HistorySessionModel.findById(id);
      
      if (!session) {
        res.status(404).json({
          success: false,
          message: 'Session not found'
        });
        return;
      }

      // Verify ownership
      if (session.user_id !== userId) {
        res.status(403).json({
          success: false,
          message: 'Access denied'
        });
        return;
      }

      await HistorySessionModel.deleteById(id);

      res.status(200).json({
        success: true,
        message: 'Session deleted successfully'
      });
    } catch (error) {
      console.error('Error deleting session:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }

  /**
   * POST /api/history/:id/clone
   * Use session as base for new merge
   */
  static async clone(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const userId = DEFAULT_USER_ID;

      const session = await HistorySessionModel.findById(id);
      
      if (!session) {
        res.status(404).json({
          success: false,
          message: 'Session not found'
        });
        return;
      }

      // Verify ownership
      if (session.user_id !== userId) {
        res.status(403).json({
          success: false,
          message: 'Access denied'
        });
        return;
      }

      // Return session data for cloning
      res.status(200).json({
        success: true,
        message: 'Session ready for cloning',
        data: {
          id: session.id,
          name: session.name,
          rowCount: session.row_count || 0,
          meanConfidence: session.mean_confidence || 0,
          mode: 'continue'
        }
      });
    } catch (error) {
      console.error('Error cloning session:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }

  /**
   * GET /api/history/search
   * Search sessions by name or date
   */
  static async search(req: Request, res: Response): Promise<void> {
    try {
      const { q, dateRange, sortBy = 'date', sortOrder = 'desc' } = req.query;
      const userId = DEFAULT_USER_ID;

      let sessions;

      if (q && typeof q === 'string' && q.trim()) {
        // Search by name
        sessions = await HistorySessionModel.search(q.trim(), userId);
      } else if (dateRange && typeof dateRange === 'string') {
        // Date range filter
        const now = new Date();
        let startDate: Date;
        
        switch (dateRange) {
          case 'today':
            startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            break;
          case 'last7days':
            startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            break;
          case 'last30days':
            startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            break;
          default:
            startDate = new Date(0); // All time
        }
        
        sessions = await HistorySessionModel.searchByDateRange(
          startDate.toISOString(),
          now.toISOString(),
          userId
        );
      } else {
        // Return all sessions for user
        sessions = await HistorySessionModel.findByUserId(userId);
      }

      // Sort results
      if (sortBy === 'name') {
        sessions.sort((a, b) => {
          const comparison = a.name.localeCompare(b.name);
          return sortOrder === 'asc' ? comparison : -comparison;
        });
      } else {
        // Sort by date
        sessions.sort((a, b) => {
          const dateA = new Date(a.created_at || 0).getTime();
          const dateB = new Date(b.created_at || 0).getTime();
          return sortOrder === 'asc' ? dateA - dateB : dateB - dateA;
        });
      }

      // Format the response
      const formattedSessions = sessions.map(session => ({
        id: session.id,
        name: session.name,
        date: session.created_at || new Date().toISOString(),
        rowCount: session.row_count || 0,
        meanConfidence: session.mean_confidence || 0
      }));

      res.status(200).json({
        success: true,
        data: formattedSessions
      });
    } catch (error) {
      console.error('Error searching history sessions:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }

  /**
   * POST /api/history
   * Create a new history session (for saving results)
   */
  static async create(req: Request, res: Response): Promise<void> {
    try {
      const { name, comparison_id, row_count, mean_confidence, results } = req.body;
      const userId = DEFAULT_USER_ID;

      if (!name) {
        res.status(400).json({
          success: false,
          message: 'Session name is required'
        });
        return;
      }

      const session = await HistorySessionModel.create({
        name,
        comparison_id: comparison_id || null,
        user_id: userId,
        row_count: row_count || 0,
        mean_confidence: mean_confidence || 0,
        results: results || null
      });

      res.status(201).json({
        success: true,
        message: 'Session saved successfully',
        data: {
          id: session?.id,
          name: session?.name,
          rowCount: session?.row_count,
          meanConfidence: session?.mean_confidence,
          createdAt: session?.created_at
        }
      });
    } catch (error) {
      console.error('Error creating history session:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }
}
