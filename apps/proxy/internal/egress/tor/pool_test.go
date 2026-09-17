package tor

import (
	"context"
	"testing"
	"time"
)

func TestNewPoolDefaults(t *testing.T) {
	t.Parallel()
	pool := NewPool(0, 0, 0, 0, 0)
	if pool.size != defaultPoolSize {
		t.Fatalf("size = %d, want %d", pool.size, defaultPoolSize)
	}
	if pool.bootstrapTimeout != defaultBuildTimeout {
		t.Fatalf("bootstrapTimeout = %v, want %v", pool.bootstrapTimeout, defaultBuildTimeout)
	}
	if pool.buildTimeout != defaultBuildTimeout {
		t.Fatalf("buildTimeout = %v, want %v", pool.buildTimeout, defaultBuildTimeout)
	}
	if pool.dialTimeout != defaultDialTimeout {
		t.Fatalf("dialTimeout = %v, want %v", pool.dialTimeout, defaultDialTimeout)
	}
	if pool.refreshEvery != defaultRefreshEvery {
		t.Fatalf("refreshEvery = %v, want %v", pool.refreshEvery, defaultRefreshEvery)
	}
}

func TestNewPoolHonorsExplicitValues(t *testing.T) {
	t.Parallel()
	pool := NewPool(5, time.Minute, 2*time.Minute, 3*time.Second, time.Hour)
	if pool.size != 5 || pool.bootstrapTimeout != time.Minute || pool.buildTimeout != 2*time.Minute || pool.dialTimeout != 3*time.Second || pool.refreshEvery != time.Hour {
		t.Fatalf("pool = %+v, want explicit values", pool)
	}
}

func TestPoolEmptyState(t *testing.T) {
	t.Parallel()
	pool := NewPool(1, time.Second, time.Second, time.Second, time.Second)
	if pool.Ready() {
		t.Fatal("empty pool should not be ready")
	}
	if pool.HealthyCount() != 0 || pool.TotalCount() != 0 {
		t.Fatalf("counts = %d/%d, want 0/0", pool.HealthyCount(), pool.TotalCount())
	}
	if _, err := pool.DialContext(context.Background(), "tcp", "example.com:443"); err == nil {
		t.Fatal("dial on empty pool should fail")
	}
	client := pool.NewClient()
	if client == nil || client.Transport == nil {
		t.Fatal("NewClient returned a client without transport")
	}
	pool.Close()
	pool.Close()
}

func TestPoolStartAfterCloseIsNoOp(t *testing.T) {
	t.Parallel()
	pool := NewPool(1, time.Second, time.Second, time.Second, time.Second)
	pool.mu.Lock()
	pool.closed = true
	pool.mu.Unlock()
	pool.Start(context.Background())
	if pool.started {
		t.Fatal("Start should be a no-op on a closed pool")
	}
}

func TestPoolDialRejectsWhenClosed(t *testing.T) {
	t.Parallel()
	pool := NewPool(1, time.Second, time.Second, time.Second, time.Second)
	pool.Close()
	if _, err := pool.DialContext(context.Background(), "tcp", "example.com:443"); err == nil {
		t.Fatal("dial on closed pool should fail")
	}
}

func TestManagedCircuitNilSafe(t *testing.T) {
	t.Parallel()
	var circuit *managedCircuit
	if circuit.alive() {
		t.Fatal("nil circuit should not be alive")
	}
	circuit.close()
}
