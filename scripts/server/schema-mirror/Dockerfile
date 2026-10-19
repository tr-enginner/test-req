# Serves https://opencode.ai/config.json inside the compose network (DNS alias "opencode.ai").
# Self-signed TLS; OpenCode containers should set NODE_TLS_REJECT_UNAUTHORIZED=0 (see manager).
FROM nginx:1.27-alpine
RUN apk add --no-cache openssl \
  && mkdir -p /etc/nginx/ssl \
  && openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout /etc/nginx/ssl/opencode.ai.key \
    -out /etc/nginx/ssl/opencode.ai.crt \
    -subj "/CN=opencode.ai" \
    -addext "subjectAltName=DNS:opencode.ai,DNS:www.opencode.ai"
COPY nginx.conf /etc/nginx/conf.d/default.conf
RUN echo '{}' > /usr/share/nginx/html/config.json
