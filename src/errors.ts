/** Business error: becomes {code, message, request_id} with the given HTTP status. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const errors = {
  validation: (msg: string) => new AppError(422, 'VALIDATION_ERROR', msg),
  notFound: (what: string) => new AppError(404, 'NOT_FOUND', `${what} not found`),
  insufficientFunds: () =>
    new AppError(422, 'INSUFFICIENT_FUNDS', 'The wallet does not have enough balance for this transfer'),
  conflict: (code: string, msg: string) => new AppError(409, code, msg),
};
