FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

CMD ["gunicorn", \
     "--workers", "1", \
     "--bind", "0.0.0.0:9000", \
     "--access-logfile", "-", \
     "--error-logfile", "-", \
     "app:app"]
