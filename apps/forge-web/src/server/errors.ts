/** A refusal with a stable machine code and a human message. Never carries secrets. */
export class ForgeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ForgeError";
  }
}

export const refuse = (code: string, message: string, status = 400, detail?: Record<string, unknown>): never => {
  throw new ForgeError(code, message, status, detail);
};
