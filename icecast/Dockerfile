FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        icecast2 \
        ca-certificates \
        gettext-base \
    && rm -rf /var/lib/apt/lists/*

COPY icecast.xml.template /etc/icecast2/icecast.xml.template
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
    && mkdir -p /var/log/icecast2 \
    && chown -R icecast2:icecast /var/log/icecast2

EXPOSE 8000

USER icecast2

ENTRYPOINT ["/entrypoint.sh"]
