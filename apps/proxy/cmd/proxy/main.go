package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/opendum/opendum/apps/proxy/internal/api"
	"github.com/opendum/opendum/apps/proxy/internal/auth"
	"github.com/opendum/opendum/apps/proxy/internal/config"
	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
	"github.com/opendum/opendum/apps/proxy/internal/models"
	"github.com/opendum/opendum/apps/proxy/internal/proxy"
	"github.com/opendum/opendum/apps/proxy/internal/redisclient"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("failed to load config", "error", err)
		os.Exit(1)
	}

	database, err := appdb.Open(cfg.DatabaseURL)
	if err != nil {
		slog.Error("failed to connect database", "error", err)
		os.Exit(1)
	}
	defer database.Close()

	redisClient, err := redisclient.Open(cfg.RedisURL)
	if err != nil {
		slog.Error("failed to connect redis", "error", err)
		os.Exit(1)
	}
	defer redisClient.Close()

	registry, err := models.Load(cfg.ModelsDir)
	if err != nil {
		slog.Error("failed to load model registry", "error", err, "dir", cfg.ModelsDir)
		os.Exit(1)
	}

	authSvc := auth.NewService(database, redisClient, registry)
	proxySvc := proxy.NewService(database, redisClient, authSvc, registry, cfg.BetterAuthSecret)
	handler := api.NewServer(registry, authSvc, proxySvc)

	server := &http.Server{
		Addr:         fmt.Sprintf("%s:%d", cfg.Host, cfg.Port),
		Handler:      handler,
		ReadTimeout:  cfg.ReadTimeout,
		WriteTimeout: cfg.WriteTimeout,
		IdleTimeout:  cfg.IdleTimeout,
	}

	go func() {
		slog.Info("Opendum Go proxy listening", "addr", server.Addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server failed", "error", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		slog.Error("graceful shutdown failed", "error", err)
	}
}
