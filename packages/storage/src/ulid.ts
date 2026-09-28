/**
 * 最小 ULID 生成（05 §3.0：主键 TEXT、ULID、时间有序）。零外部依赖。
 * 形态：10 字符时间戳（48bit，Crockford Base32）+ 16 字符随机（80bit）。
 */
import { randomBytes } from "node:crypto";

const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now: number = Date.now()): string {
  let time = Math.trunc(Math.max(0, now));
  const timeChars: string[] = [];
  for (let i = 0; i < 10; i++) {
    timeChars.unshift(ENC.charAt(time % 32));
    time = Math.floor(time / 32);
  }
  const bytes = randomBytes(16);
  let randomPart = "";
  for (let i = 0; i < 16; i++) {
    // 256 = 8 × 32，byte % 32 均匀分布
    randomPart += ENC.charAt((bytes[i] ?? 0) % 32);
  }
  return timeChars.join("") + randomPart;
}
