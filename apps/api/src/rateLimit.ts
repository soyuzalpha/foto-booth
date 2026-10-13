/**
 * Pembatas laju sederhana (sliding window) untuk rute publik.
 *
 * Kenapa tidak pakai `@fastify/rate-limit`: rute yang perlu dijaga cuma satu
 * (`POST /v1/booking/requests`), dan yang penting di sini bukan throughput,
 * melainkan **jam yang bisa disuntik**. Versi plugin memakai waktu dinding
 * sendiri, jadi tes yang memajukan `ctx.now()` tidak akan pernah melihat
 * jendelanya bergeser.
 *
 * Batasnya disimpan di memori proses. Untuk satu rumah, satu proses, itu cukup:
 * restart server memang mengosongkan hitungan, dan tidak ada klaster yang perlu
 * disinkronkan.
 */

export interface RateLimitOptions {
  /** Berapa permintaan boleh lewat dalam satu jendela. */
  limit: number;
  /** Panjang jendela (milidetik). */
  windowMs: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Sisa kuota di jendela ini. `0` saat diblokir. */
  remaining: number;
  /** Detik sampai kuota pulih — dipakai untuk header `Retry-After`. */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  check(key: string): RateLimitVerdict;
  /** Buang catatan key ini — dipakai tes dan saat operator membuka blokir. */
  reset(key?: string): void;
}

export function createRateLimiter(options: RateLimitOptions, now: () => Date): RateLimiter {
  const hits = new Map<string, number[]>();

  return {
    check(key) {
      const current = now().getTime();
      const cutoff = current - options.windowMs;

      // Hanya stempel waktu di dalam jendela yang dihitung; sisanya dibuang
      // supaya map tidak tumbuh tanpa batas selama proses hidup.
      const recent = (hits.get(key) ?? []).filter((stamp) => stamp > cutoff);

      if (recent.length >= options.limit) {
        hits.set(key, recent);
        const oldest = recent[0] ?? current;
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((oldest + options.windowMs - current) / 1000)),
        };
      }

      recent.push(current);
      hits.set(key, recent);
      return {
        allowed: true,
        remaining: Math.max(0, options.limit - recent.length),
        retryAfterSeconds: 0,
      };
    },

    reset(key) {
      if (key === undefined) hits.clear();
      else hits.delete(key);
    },
  };
}
