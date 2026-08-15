/**
 * Every failure the client is meant to handle carries a stable `code`.
 *
 * The app maps codes to copy (lib/auth.tsx#friendlyAuthError, lib/db/error.ts),
 * so codes are API surface: renaming one is a breaking change, and messages are
 * free to be reworded.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, message: string) => new AppError(400, code, message);
export const unauthorized = (code: string, message: string) => new AppError(401, code, message);
export const forbidden = (code: string, message: string) => new AppError(403, code, message);
export const notFound = (code = 'not_found', message = 'Not found') => new AppError(404, code, message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
