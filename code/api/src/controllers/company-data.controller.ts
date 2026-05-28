import { Request, Response } from 'express';
import { CompanyDataModel } from '../models/company-data.model';

export class CompanyDataController {
  /**
   * GET /api/comparisons/company-data/all
   * Get all company data records across all sessions (paginated)
   */
  static async getAllCompanyData(req: Request, res: Response): Promise<void> {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit as string) || 20));

      const result = await CompanyDataModel.findAllPaginated(page, limit);

      res.status(200).json({
        success: true,
        data: result.data,
        pagination: result.pagination
      });
    } catch (error) {
      console.error('Error fetching all company data:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }
}
