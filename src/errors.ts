/** Stable error codes thrown by Squeeze decoders and encoders. */
export type SqueezeErrorCode =
  | 'UNEXPECTED_EOF'
  | 'BAD_BLOCK_TYPE'
  | 'BAD_STORED_LENGTH'
  | 'BAD_CODE_LENGTHS'
  | 'BAD_SYMBOL'
  | 'DISTANCE_TOO_FAR'
  | 'TOO_MANY_SYMBOLS'
  | 'MISSING_END_OF_BLOCK'
  | 'OUTPUT_LIMIT'
  | 'BAD_HEADER'
  | 'BAD_CHECKSUM'
  | 'BAD_CRC'
  | 'BAD_LENGTH'
  | 'NEED_DICTIONARY'
  | 'TRAILING_DATA'
  | 'BAD_SIGNATURE'
  | 'BAD_CHUNK'
  | 'BAD_IHDR'
  | 'BAD_PALETTE'
  | 'BAD_FILTER'
  | 'BAD_IMAGE_DATA'
  | 'UNSUPPORTED'
  | 'BAD_ARGUMENT';

/** The only error type Squeeze throws for bad input. Check `code` rather than `message`. */
export class SqueezeError extends Error {
  readonly code: SqueezeErrorCode;
  constructor(code: SqueezeErrorCode, message: string) {
    super(message);
    this.name = 'SqueezeError';
    this.code = code;
  }
}

export function fail(code: SqueezeErrorCode, message: string): never {
  throw new SqueezeError(code, message);
}
