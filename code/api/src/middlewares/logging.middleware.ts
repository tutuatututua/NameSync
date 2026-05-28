import { Request, Response, NextFunction } from 'express';

class RequestLogger {
  static logRequest(req: Request): void {
    console.log(`[REQUEST] ${new Date().toISOString()}`, {
      method: req.method,
      url: req.originalUrl,
    });
  }

  static logResponse(req: Request, res: Response, responseTime: number): void {
    // Intentionally does NOT log request/response bodies or headers — they may
    // contain PII or large file payloads. Log only request-line metadata.
    console.log(`[RESPONSE] ${new Date().toISOString()}`, {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      responseTime: `${responseTime}ms`,
    });
  }

  static logError(err: Error, req: Request): void {
    console.error(`[ERROR] ${new Date().toISOString()}`, {
      message: err.message,
      stack: err.stack,
      method: req.method,
      url: req.originalUrl,
    });
  }
}

function loggingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();

  RequestLogger.logRequest(req);

  const errorHandler = (err: Error) => {
    RequestLogger.logError(err, req);
  };

  req.on('error', errorHandler);
  res.on('error', errorHandler);

  const originalEnd = res.end.bind(res);
  res.end = (...args: any[]) => {
    const responseTime = Date.now() - startTime;
    RequestLogger.logResponse(req, res, responseTime);
    return originalEnd(...args);
  };

  next();
}

export default loggingMiddleware;
