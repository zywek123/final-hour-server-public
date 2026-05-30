ARG BASE_CONTAINER=docker.io/node:latest

FROM $BASE_CONTAINER AS final-hour-dev

ARG USER=node

LABEL org.opencontainers.image.authors="mikey@blindcomputing.org"

EXPOSE 13000/udp
VOLUME /home/node/app/maps
RUN mkdir -p /home/node/app
WORKDIR /home/node
ENTRYPOINT ["npm", "run"]
CMD ["dev"]

RUN apt-get update && apt-get install -y python3-setuptools && rm -rf /var/lib/apt/lists/*

RUN --mount=type=bind,source=package.json,target=/home/node/package.json \
    --mount=type=bind,source=package-lock.json,target=/home/node/package-lock.json \
    npm ci

WORKDIR /home/node/app

FROM final-hour-dev AS final-hour-prod

ENV NODE_PATH=./dist
CMD ["start"]

COPY --chown=node . /home/node/app
RUN chown -R node /home/node/app
RUN npm run build
USER $USER