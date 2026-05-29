import { Request, Response } from 'express';
import { FacebookDataModel } from '../models/facebook-data.model';
import { UploadHistoryModel } from '../models/upload-history.model';

export class FacebookDataController {
  /**
   * GET /api/comparisons/facebook-data/all
   * Get all Facebook data records across all sessions (paginated)
   */
  static async getAllFacebookData(req: Request, res: Response): Promise<void> {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit as string) || 20));

      const result = await FacebookDataModel.findAllPaginated(page, limit);

      res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination
      });
    } catch (error) {
      console.error('Error fetching all Facebook data:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }

  /**
   * DELETE /api/comparisons/facebook-data/all
   * Wipe all Facebook data along with its upload history ("Clear all Facebook data").
   */
  static async deleteAllFacebookData(_req: Request, res: Response): Promise<void> {
    try {
      const deleted = await FacebookDataModel.deleteAll();
      await UploadHistoryModel.deleteBySourceType('facebook');

      res.status(200).json({
        success: true,
        message: 'All Facebook data cleared',
        data: { deleted }
      });
    } catch (error) {
      console.error('Error clearing Facebook data:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }

  /**
   * DELETE /api/comparisons/facebook-data/:uuid
   * Delete a single Facebook row.
   */
  static async deleteFacebookRecord(req: Request, res: Response): Promise<void> {
    try {
      const { uuid } = req.params;
      const deleted = await FacebookDataModel.deleteByUuid(uuid);

      if (deleted === 0) {
        res.status(404).json({ success: false, message: 'Facebook record not found' });
        return;
      }

      res.status(200).json({ success: true, message: 'Facebook record deleted' });
    } catch (error) {
      console.error('Error deleting Facebook record:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }
}
