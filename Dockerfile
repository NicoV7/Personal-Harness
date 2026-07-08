FROM python:3.12-slim AS runtime

RUN groupadd --gid 1000 betterai && useradd --uid 1000 --gid 1000 --create-home betterai

WORKDIR /opt/betterai
COPY pyproject.toml ./
COPY app ./app
RUN pip install --no-cache-dir .

USER 1000:1000
EXPOSE 7777
CMD ["python", "-m", "app.main"]
