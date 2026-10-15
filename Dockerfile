# ==============================================================================
# DeepEye 生产级轻量容器构建
# 基于 Node.js 22 LTS Alpine 基础镜像，多阶段构建，极小化体积与安全运行
# ==============================================================================

# ── 阶段 1：依赖准备 (deps) ──
FROM node:22-alpine AS deps
WORKDIR /app

# 安装原生与系统依赖工具（Alpine 需 libc6-compat 与构建工具）
RUN apk add --no-cache libc6-compat python3 make g++

# 优先拷贝依赖定义文件，最大化利用 Docker 构建缓存层
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts || npm install

# ── 阶段 2：编译构建 (builder) ──
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# 禁用 Next.js 遥测数据收集
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# 执行生产级 Next.js 构建
RUN npm run build

# ── 阶段 3：运行时容器 (runner) ──
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# 创建非 root 专属安全用户与运行组
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# 安装运行时基础依赖（wget 用于健康检查，ca-certificates 用于安全请求）
RUN apk add --no-cache ca-certificates wget

# 拷贝运行时必备的源码、产物与依赖包
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules

# 初始化数据持久化目录并赋予权限
RUN mkdir -p data/sessions data/auth && \
    chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 3000

# 容器健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

CMD ["npm", "run", "start"]
