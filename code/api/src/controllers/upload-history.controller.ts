import { Request, Response } from 'express';
import { UploadHistoryModel, SourceType } from '../models/upload-history.model';

export class UploadHistoryController {
  /**
   * GET /api/upload-history
   * Get all upload history records (paginated)
   */
  static async list(req: Request, res: Response): Promise<void> {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.max(1, Math.min(100, parseInt(req.query.limit as string) || 20));

      const result = await UploadHistoryModel.findAllPaginated(page, limit);

      res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination
      });
    } catch (error) {
      console.error('Error fetching upload history:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }

  /**
   * GET /api/upload-history/by-source/:sourceType
   * Get upload history records by source type (facebook or company)
   */
  static async listBySourceType(req: Request, res: Response): Promise<void> {
    try {
      const { sourceType } = req.params;
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.max(1, Math.min(100, parseInt(req.query.limit as string) || 20));

      if (!['facebook', 'company'].includes(sourceType)) {
        res.status(400).json({
          success: false,
          message: 'Invalid source type. Must be "facebook" or "company"'
        });
        return;
      }

      const result = await UploadHistoryModel.findBySourceTypePaginated(
        sourceType as SourceType,
        page,
        limit
      );

      res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination
      });
    } catch (error) {
      console.error('Error fetching upload history by source:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }

  /**
   * GET /api/upload-history/:id
   * Get a single upload history record by ID
   */
  static async getById(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const record = await UploadHistoryModel.findById(id);

      if (!record) {
        res.status(404).json({
          success: false,
          message: 'Upload history record not found'
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: record
      });
    } catch (error) {
      console.error('Error fetching upload history record:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }

  /**
   * POST /api/upload-history
   * Create a new upload history record
   */
  static async create(req: Request, res: Response): Promise<void> {
    try {
      const { source_type, user_upload, timestamp, rows_processed, duplicate_rows, session_id } = req.body;

      // Validate required fields
      if (!source_type || !user_upload) {
        res.status(400).json({
          success: false,
          message: 'source_type and user_upload are required'
        });
        return;
      }

      if (!['facebook', 'company'].includes(source_type)) {
        res.status(400).json({
          success: false,
          message: 'source_type must be "facebook" or "company"'
        });
        return;
      }

      const record = await UploadHistoryModel.create({
        source_type,
        user_upload,
        timestamp: timestamp || new Date().toISOString(),
        rows_processed: rows_processed || 0,
        duplicate_rows: duplicate_rows || 0,
        session_id
      });

      res.status(201).json({
        success: true,
        message: 'Upload history record created successfully',
        data: record
      });
    } catch (error) {
      console.error('Error creating upload history record:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }

  /**
   * DELETE /api/upload-history/:id
   * Delete an upload history record
   */
  static async delete(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const record = await UploadHistoryModel.findById(id);

      if (!record) {
        res.status(404).json({
          success: false,
          message: 'Upload history record not found'
        });
        return;
      }

      await UploadHistoryModel.deleteById(id);

      res.status(200).json({
        success: true,
        message: 'Upload history record deleted successfully'
      });
    } catch (error) {
      console.error('Error deleting upload history record:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }

  /**
   * DELETE /api/upload-history/by-source/:sourceType
   * Delete all upload history records for a source type
   */
  static async deleteBySourceType(req: Request, res: Response): Promise<void> {
    try {
      const { sourceType } = req.params;

      if (!['facebook', 'company'].includes(sourceType)) {
        res.status(400).json({
          success: false,
          message: 'Invalid source type. Must be "facebook" or "company"'
        });
        return;
      }

      await UploadHistoryModel.deleteBySourceType(sourceType as SourceType);

      res.status(200).json({
        success: true,
        message: `All upload history records for ${sourceType} deleted successfully`
      });
    } catch (error) {
      console.error('Error deleting upload history by source:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }
}
