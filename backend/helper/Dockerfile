ARG PYTHON_IMAGE=docker.hanxi.cc/library/python:3.11-slim

FROM ${PYTHON_IMAGE}

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py frida_agent.js ./

EXPOSE 19091

CMD ["python", "server.py"]
