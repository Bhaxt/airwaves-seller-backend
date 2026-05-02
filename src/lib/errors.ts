export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function notFound(msg = 'Not found') { return new AppError(404, msg, 'NOT_FOUND'); }
export function unauthorized(msg = 'Unauthorized') { return new AppError(401, msg, 'UNAUTHORIZED'); }
export function forbidden(msg = 'Forbidden') { return new AppError(403, msg, 'FORBIDDEN'); }
export function badRequest(msg: string, code?: string) { return new AppError(400, msg, code ?? 'BAD_REQUEST'); }
export function conflict(msg: string) { return new AppError(409, msg, 'CONFLICT'); }
export function tooManyRequests(msg: string) { return new AppError(429, msg, 'RATE_LIMITED'); }
