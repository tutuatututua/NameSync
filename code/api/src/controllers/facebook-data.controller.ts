import { Request, Response } from 'express';
import { FacebookDataModel } from '../models/facebook-data.model';

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
}
