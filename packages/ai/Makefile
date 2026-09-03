.PHONY: test build sync

test:
	go test -v ./...

build:
	go build -v ./pkg/...

sync:
	npm run models:refresh
