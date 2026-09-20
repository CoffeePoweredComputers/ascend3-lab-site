# hello

The reference lab tool. Copy this folder to start your own; the contract it
follows is in [`../README.md`](../README.md).

- `tool.json`: what the wiki shows.
- `Containerfile`: how to build it. The app listens on `$PORT` on all
  interfaces, writes only under `/data`, and runs as a non-root user.
- `app.py`: twenty lines of standard library, no framework.
