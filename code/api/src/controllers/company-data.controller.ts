import { Request, Response } from 'express';
import { CompanyDataModel } from '../models/company-data.model';
import { UploadHistoryModel } from '../models/upload-history.model';

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

  /**
   * DELETE /api/comparisons/company-data/all
   * Wipe all company data along with its upload history ("Clear all Company data").
   */
  static async deleteAllCompanyData(_req: Request, res: Response): Promise<void> {
    try {
      const deleted = await CompanyDataModel.deleteAll();
      await UploadHistoryModel.deleteBySourceType('company');

      res.status(200).json({
        success: true,
        message: 'All company data cleared',
        data: { deleted }
      });
    } catch (error) {
      console.error('Error clearing company data:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }

  /**
   * DELETE /api/comparisons/company-data/:uuid
   * Delete a single company row.
   */
  static async deleteCompanyRecord(req: Request, res: Response): Promise<void> {
    try {
      const { uuid } = req.params;
      const deleted = await CompanyDataModel.deleteByUuid(uuid);

      if (deleted === 0) {
        res.status(404).json({ success: false, message: 'Company record not found' });
        return;
      }

      res.status(200).json({ success: true, message: 'Company record deleted' });
    } catch (error) {
      console.error('Error deleting company record:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }
}
