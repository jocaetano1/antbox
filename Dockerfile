FROM denoland/deno:alpine-1.35.1

RUN apk add --no-cache libstdc++6

WORKDIR /app
COPY . .

RUN deno cache demo.ts

ENV PORT=7180
EXPOSE 7180

VOLUME [ "/data" ]

CMD ["deno", "run", "-A", "demo.ts", "/data"]

