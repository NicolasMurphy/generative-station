FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        icecast2 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY icecast.xml /etc/icecast2/icecast.xml

RUN mkdir -p /var/log/icecast2 && chown -R icecast2:icecast /var/log/icecast2

EXPOSE 8000

USER icecast2

CMD ["icecast2", "-c", "/etc/icecast2/icecast.xml"]
