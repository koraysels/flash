FROM node:20-slim AS build

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

RUN pnpm install --frozen-lockfile --filter flash-frontend

COPY frontend ./frontend

# VITE_GOOGLE_MAPS_API_KEY is optional — pass as build arg if you use the calibration map
ARG VITE_GOOGLE_MAPS_API_KEY=""
RUN VITE_GOOGLE_MAPS_API_KEY=$VITE_GOOGLE_MAPS_API_KEY pnpm --filter flash-frontend run build

FROM nginx:stable-alpine
COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
