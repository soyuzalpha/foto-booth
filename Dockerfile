# Skema mengikuti aseppp-web: deps → builder → runner, satu image, semua app.
#
# Catatan: API sengaja TIDAK di-compile ke JS. Node 24 sudah bisa menjalankan
# TypeScript langsung (type stripping), jadi `node src/index.ts` cukup — dan
# `packages/shared` yang di-export sebagai `.ts` mentah juga ikut terbaca.

FROM node:24-alpine AS deps

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/studio/package.json apps/studio/
COPY packages/shared/package.json packages/shared/
COPY apps/desktop/package.json apps/desktop/
COPY apps/mobile/package.json apps/mobile/

# Shell desktop **dan** shell mobile tidak ikut di-deploy (server tidak punya
# layar), tapi keduanya ada di workspace — jadi package.json-nya harus ikut
# supaya lockfile cocok (`--frozen-lockfile` menolak workspace yang hilang).
# Binary Electron (283 MB) TIDAK diunduh: tanpa ini setiap build image
# menambah ~300 MB yang tidak pernah dipakai.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

RUN pnpm install --frozen-lockfile


FROM node:24-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/apps/studio/node_modules ./apps/studio/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules

COPY . .

# Menghasilkan apps/studio/dist (SPA + service worker) yang di-serve API.
RUN pnpm build


FROM node:24-alpine AS runner

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=5050

COPY --from=builder /app ./

EXPOSE 5050

# Bind ke semua interface DI DALAM container; host hanya memetakan 127.0.0.1.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5050)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "--filter", "@foto-booth/api", "start"]
