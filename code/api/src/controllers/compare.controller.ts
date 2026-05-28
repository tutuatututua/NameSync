import { Request, Response } from 'express';
import { UploadSessionModel } from '../models/upload-session.model';
import { WebSocketService } from '../services/websocket.service';
import fetch from 'node-fetch';

const COMPARE_WEBHOOK_URL = process.env.COMPARE_WEBHOOK_URL;

/**
 * Webhook Callback URL Configuration
 * 
 * For local development, webhooks need a publicly accessible URL to send results back.
 * Use ngrok to expose localhost:8080:
 *   1. Install ngrok: https://ngrok.com/download
 *   2. Run: ngrok http 8080
 *   3. Copy the https URL (e.g., https://abc123.ngrok.io)
 *   4. Set WEBHOOK_CALLBACK_URL_BASE=https://abc123.ngrok.io in your .env file
 * 
 * In production, this defaults to the server's public URL.
 */
const WEBHOOK_CALLBACK_URL_BASE = process.env.WEBHOOK_CALLBACK_URL_BASE;

export class CompareController {
  /**
   * POST /api/comparisons/:id/compare
   * Trigger comparison after both files are uploaded and processed
   */
  static async triggerComparison(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // Verify session exists
      const session = await UploadSessionModel.findById(id);
      if (!session) {
        res.status(404).json({
          success: false,
          message: 'Session not found'
        });
        return;
      }

      // The data is forwarded to the ingestion webhooks at upload time, so a session
      // that has been uploaded (pending_webhook), is already processing, or completed
      // is eligible to be (re)triggered.
      if (
        session.status !== 'pending_webhook' &&
        session.status !== 'processing' &&
        session.status !== 'completed'
      ) {
        res.status(400).json({
          success: false,
          message: 'Files not yet uploaded. Please upload data first.'
        });
        return;
      }

      // Notify frontend that comparison is starting
      WebSocketService.broadcast(id, {
        type: 'comparison_starting',
        sessionId: id,
        message: 'Starting comparison process'
      });

      // Determine callback URL for webhook responses.
      // Only trust WEBHOOK_CALLBACK_URL_BASE when it is an absolute http(s) URL;
      // otherwise fall back to the request-derived host (the env value is sometimes
      // a bare token, which would produce a malformed callback URL).
      const isValidBase = !!WEBHOOK_CALLBACK_URL_BASE && /^https?:\/\//i.test(WEBHOOK_CALLBACK_URL_BASE);
      const callbackUrlBase = (isValidBase ? WEBHOOK_CALLBACK_URL_BASE : `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
      const callbackUrl = `${callbackUrlBase}/api/callbacks/comparison-results`;

      // Trigger-only payload: the company/facebook data was already delivered to the
      // ingestion webhooks at upload time, so the comparison service only needs the
      // session id and where to send results back.
      const comparePayload = {
        session_id: id,
        callback_url: callbackUrl
      };

      // The comparison webhook must be configured. Without it the external workflow
      // never runs, so the session would sit in "processing" forever — fail loudly
      // instead of reporting a fake success.
      if (!COMPARE_WEBHOOK_URL) {
        WebSocketService.broadcast(id, {
          type: 'comparison_failed',
          sessionId: id,
          message: 'Comparison service is not configured'
        });
        res.status(503).json({
          success: false,
          message: 'Comparison service is not configured (COMPARE_WEBHOOK_URL missing)'
        });
        return;
      }

      const response = await fetch(COMPARE_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': id
        },
        body: JSON.stringify(comparePayload)
      });

      if (!response.ok) {
        WebSocketService.broadcast(id, {
          type: 'comparison_failed',
          sessionId: id,
          message: 'Failed to trigger comparison webhook'
        });
        res.status(502).json({
          success: false,
          message: 'Failed to trigger comparison webhook'
        });
        return;
      }

      // Update session status to indicate comparison is in progress
      await UploadSessionModel.updateStatus(id, 'processing');

      // Notify frontend
      WebSocketService.broadcast(id, {
        type: 'comparison_triggered',
        sessionId: id,
        message: 'Comparison triggered successfully'
      });

      res.status(200).json({
        success: true,
        message: 'Comparison triggered successfully',
        data: {
          sessionId: id,
          status: 'processing'
        }
      });
    } catch (error) {
      console.error('Error triggering comparison:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: (error as Error).message
      });
    }
  }
}
