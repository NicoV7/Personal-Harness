FROM python:3.12-slim AS builder

WORKDIR /opt/betterai
COPY pyproject.toml ./
COPY app ./app
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir . \
    && /opt/venv/bin/pip uninstall -y pip \
    && find /opt/venv -type d -name '__pycache__' -exec rm -rf {} +

FROM python:3.12-slim AS runtime

RUN groupadd --gid 1000 betterai && useradd --uid 1000 --gid 1000 --create-home betterai

COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

USER 1000:1000
EXPOSE 7777
CMD ["python", "-m", "app.main"]
