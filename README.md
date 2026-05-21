# generative-station

Continuous generative audio stream. SuperCollider piece runs forever inside a container, ffmpeg encodes Opus, Icecast serves it.

```sh
docker compose up --build
```

Listen at `http://localhost:8000/stream` (or open `web/index.html`).
