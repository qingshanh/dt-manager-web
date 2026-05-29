ARG PYTHON_IMAGE=docker.hanxi.cc/library/python:3.11-slim

FROM ${PYTHON_IMAGE}

WORKDIR /app

COPY requirements.txt ./
ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
RUN pip install --no-cache-dir -i ${PIP_INDEX_URL} -r requirements.txt

COPY server.py frida_agent.js ./

EXPOSE 19091

CMD ["python", "server.py"]
