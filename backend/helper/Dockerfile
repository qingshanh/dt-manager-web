ARG NODE_IMAGE=docker.hanxi.cc/library/node:22-alpine
ARG PYTHON_IMAGE=docker.hanxi.cc/library/python:3.11-slim

FROM ${NODE_IMAGE} AS node-deps

WORKDIR /app

COPY package.json package-lock.json ./
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm ci --registry=${NPM_REGISTRY}

FROM ${PYTHON_IMAGE}

WORKDIR /app

COPY requirements.txt ./
ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
RUN pip install --no-cache-dir -i ${PIP_INDEX_URL} -r requirements.txt

COPY package.json package-lock.json ./
COPY --from=node-deps /app/node_modules ./node_modules
COPY server.py frida_agent.js ./

EXPOSE 19091

CMD ["python", "server.py"]
