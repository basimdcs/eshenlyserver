import * as crypto from 'crypto';

export function hmacSign(secret: string, parts: string[]): string {
  const message = parts.join('.');
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

export function hmacVerify(secret: string, parts: string[], signature: string): boolean {
  const expected = hmacSign(secret, parts);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
