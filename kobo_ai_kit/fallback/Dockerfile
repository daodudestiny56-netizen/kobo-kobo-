# FALLBACK ONLY. The team decided to port SweepGuard/SmartRate into the Node app (no second service). Use this only if that port cannot be finished.
# Kobo Kobo AI service (Sweep Guard, Smart Rate, Voice).  PRD v3 section 5 hard rules:
#   build (from the kit's root folder):  docker build --platform linux/amd64 -f fallback/Dockerfile -t <registry>/kobo-ai:v1 .      (tag v1, v2, ... never "latest")
#   listens on 0.0.0.0:8080, GET /healthz, no secrets in the image (they come from the environment / a k8s Secret)
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    VOICE_CACHE_DIR=/data/voice_cache

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY kobo_ai_service.py smart_rate.py voice.py voice_ivr.py core_client.py voice_tool.py generate_seed.py ./
COPY voice_templates.json voice_speakers.json ./
COPY seed ./seed

RUN useradd --system --uid 10001 kobo && mkdir -p /data/voice_cache && chown -R kobo /app /data
USER kobo
EXPOSE 8080

CMD ["sh", "-c", "python -m uvicorn kobo_ai_service:app --host 0.0.0.0 --port ${PORT:-8080}"]
