FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY bin/proxy ./proxy
COPY models ./models
EXPOSE 4001
CMD ["./proxy"]
