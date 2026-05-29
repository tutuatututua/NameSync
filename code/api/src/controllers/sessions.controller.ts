import { Request, Response } from 'express';
import { UploadSessionModel } from '../models/upload-session.model';

export class SessionsController {
  /**
   * GET /api/sessions
   * List available sessions for "continue from existing"
   */
  static async list(req: Request, res: Response): Promise<void> {
    try {
      // Get available upload sessions
      const uploadSessions = await UploadSessionModel.findAvailableSessions();
      
      // Format the response - only include completed sessions with names
      const formattedSessions = uploadSessions
        .filter(s => s.status === 'completed' && s.name)
        .map(session => ({
          id: session.id,
          title: session.name || 'Untitled Session',
          date: session.created_at 
            ? new Date(session.created_at).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric'
              })
            : 'Unknown date',
          rowCount: 0, // Would need to calculate from results
          averageConfidence: 0
        }));

      res.status(200).json({
        success: true,
        data: formattedSessions
      });
    } catch (error) {
      console.error('Error listing sessions:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }

  /**
   * GET /api/sessions/latest
   * Return the most recent session eligible to (re)trigger a comparison, so the
   * Compare button can run against existing data without a fresh upload.
   */
  static async getLatest(_req: Request, res: Response): Promise<void> {
    try {
      const session = await UploadSessionModel.findLatestCompareable();

      res.status(200).json({
        success: true,
        data: session ? { id: session.id, status: session.status } : null
      });
    } catch (error) {
      console.error('Error getting latest session:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }

  /**
   * GET /api/sessions/:id
   * Get session details for preview
   */
  static async getById(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // Find in upload sessions table
      const uploadSession = await UploadSessionModel.findById(id);
      if (uploadSession) {
        res.status(200).json({
          success: true,
          data: {
            id: uploadSession.id,
            title: uploadSession.name || 'Untitled Session',
            date: uploadSession.created_at 
              ? new Date(uploadSession.created_at).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric'
                })
              : 'Unknown date',
            rowCount: 0, // Would need to calculate from results
            averageConfidence: 0,
            mode: uploadSession.mode,
            status: uploadSession.status
          }
        });
        return;
      }

      res.status(404).json({
        success: false,
        message: 'Session not found'
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
}
