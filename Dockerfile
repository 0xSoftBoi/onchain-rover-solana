# Clanker 500 — full live sidecar (DEMO_MOCK) serving the site/ demo on Railway.
# The sidecar (Express, tsx) serves the polished landing + broadcast + overlay
# pages with live, server-generated demo data; Railway provides $PORT.
FROM node:22-slim

WORKDIR /app

# Install sidecar deps first for layer caching. tsx (the runtime) is a devDep,
# so keep dev deps included.
COPY sidecar/package.json sidecar/package-lock.json* sidecar/
RUN cd sidecar && npm install --include=dev --no-audit --no-fund

# App source + the static demo site (served via ../../site from the sidecar).
COPY sidecar/ sidecar/
COPY site/ site/

ENV NODE_ENV=production
ENV DEMO_MOCK=1
# PORT is injected by Railway; the sidecar reads process.env.PORT.

WORKDIR /app/sidecar
CMD ["npm", "start"]
