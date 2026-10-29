FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd --create-home --uid 10001 clipwell
COPY --chown=clipwell:clipwell app.py filester.py ./
COPY --chown=clipwell:clipwell static ./static
USER clipwell
EXPOSE 8000
CMD ["python", "app.py"]
